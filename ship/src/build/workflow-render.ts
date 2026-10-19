/**
 * Renders a workflow's typed sources into the one plain-JS file the runtime loads (it loads no
 * module) and checks a committed copy against a fresh render (Ship ADR-0001 decision 1).
 *
 * **Render contract.** The closure: the entry plus its transitive relative value imports (type-only
 * ones erased, never followed; a non-relative value import an error), each transpiled (ES2022,
 * comments removed, module syntax dropped), concatenated in dependency post-order into one scope: a
 * top-level name is unique across it and never a {@link HOOK_NAMES} member, and no
 * {@link FORBIDDEN_TOKENS} / {@link FORBIDDEN_WORDS} member appears. Every guard throws an `Error`
 * prefixed `workflow render:` naming the files. The runtime runs the file as an async function
 * body, hooks and `args` as globals (so the tail `return` works at top level; the ES2022 built-in
 * `Object.hasOwn` runs too), accepting a leading `export const meta` but not a second top-level
 * `export` (a SyntaxError). A file holding CR still runs; the writer writes LF regardless,
 * `.gitattributes` checks `.claude/workflows/*.js` out LF, the drift check normalises.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import * as prettier from 'prettier';
import ts from 'typescript';

import type { WorkflowMeta } from '../workflow/runtime.types.js';
import { toPosix } from '../../../tooling/shared.js';

import { WORKFLOW_GLOBALS } from './workflow-globals.js';

/** One saved workflow to render. */
export interface WorkflowSpec {
  /** The workflow's name; the entry must export `run<Name>` (first letter upper-cased). */
  readonly name: string;
  /** The entry source, repository-relative (or absolute). */
  readonly entry: string;
  /** The `meta` export's value. */
  readonly meta: WorkflowMeta;
  /** The rendered file, repository-relative (or absolute). */
  readonly out: string;
}

/** Reads one source file by absolute path. */
type SourceReader = (path: string) => string;

/** One codegen-check result. */
export interface RenderCheck {
  /** The rendered file, as its spec names it. */
  readonly target: string;
  /** Whether the on-disk copy equals a fresh render, line endings aside. */
  readonly ok: boolean;
  /** Why not, when not. */
  readonly reason?: string;
}

/**
 * The names the workflow's scope already binds — the runtime's globals and
 * the `meta` export: no top-level name may take one.
 */
const HOOK_NAMES: readonly string[] = [...WORKFLOW_GLOBALS, 'meta'];

/** Substrings the output may never contain: no code loading, clock, randomness or host global. */
export const FORBIDDEN_TOKENS: readonly string[] = [
  'eval(',
  'new Function',
  'Date.now',
  'new Date(',
  'Math.random',
  'process.',
  'Buffer',
  'require(',
  'setTimeout',
  'setImmediate',
  'globalThis',
  '__dirname',
  'console',
  'structuredClone',
  'crypto',
  'performance',
  'fetch',
  'setInterval',
  'queueMicrotask',
];

/** Words the output may never contain: the clock class in any form. */
export const FORBIDDEN_WORDS: readonly string[] = ['Date'];

/** One closure file. */
interface ClosureFile {
  /** Absolute path. */
  readonly path: string;
  /** Repository-relative, forward slashes — how messages name it. */
  readonly file: string;
  /** Its TypeScript source. */
  readonly source: string;
}

/**
 * The render closure of `entry`, in render (dependency post-order) order.
 *
 * @param entry - The entry source, relative to `root` (or absolute).
 * @param read - The source reader (default: the filesystem).
 * @returns Each closure file, repository-relative with forward slashes.
 * @throws {@link Error} when a closure file has a non-relative value import, naming the file.
 */
export function workflowClosure(
  root: string,
  entry: string,
  read: SourceReader = readSource,
): string[] {
  return closureOf(root, resolve(root, entry), read).map((f) => f.file);
}

/**
 * Render one workflow: the `export const meta` literal first (nothing precedes it; the runtime
 * accepts the leading `export`), a generated-by comment line, the closure, then a tail returning
 * `run<Name>`'s result for the hooks object and `args` — formatted by prettier under the
 * repository's config.
 *
 * @param root - The repository root; `spec`'s paths resolve against it.
 * @param read - The source reader (default: the filesystem).
 * @returns Resolves to the rendered file's content, LF line endings whatever
 *   the sources' own; rejects with an `Error` on any render-contract
 *   violation (the file header).
 */
export async function renderWorkflow(
  spec: WorkflowSpec,
  root: string,
  read: SourceReader = readSource,
): Promise<string> {
  const files = closureOf(root, resolve(root, spec.entry), read);
  const chunks = files.map((f) => ({ file: f.file, js: transpile(f.source) }));
  const meta = JSON.stringify(spec.meta);
  for (const chunk of [{ file: 'meta', js: meta }, ...chunks]) assertNoForbidden(chunk);
  assertNames(chunks);
  const runName = `run${spec.name.charAt(0).toUpperCase()}${spec.name.slice(1)}`;
  const code = [
    `export const meta = ${meta};`,
    `// Generated by ship/src/build/render-workflows.ts from ${toPosix(spec.entry)} — do not edit; run \`npm run codegen\`.`,
    '',
    ...chunks.map((c) => c.js),
    `return await ${runName}({ agent, parallel, pipeline, phase, log }, args);`,
  ].join('\n');
  const config = await prettier.resolveConfig(resolve(root, spec.entry));
  return prettier.format(code, { ...config, parser: 'babel' });
}

/**
 * The drift check: re-render each workflow and compare with its on-disk
 * copy, line endings normalised. Writes nothing.
 *
 * @returns Resolves to one result per workflow, in order; rejects when a
 *   render violates the render contract.
 */
export async function checkRenderedWorkflows(
  workflows: readonly WorkflowSpec[],
  root: string,
): Promise<RenderCheck[]> {
  return Promise.all(
    workflows.map(async (spec): Promise<RenderCheck> => {
      const rendered = await renderWorkflow(spec, root);
      const out = resolve(root, spec.out);
      if (!existsSync(out))
        return { target: spec.out, ok: false, reason: 'missing — never rendered' };
      return readFileSync(out, 'utf8').replaceAll('\r\n', '\n') === rendered
        ? { target: spec.out, ok: true }
        : { target: spec.out, ok: false, reason: 'differs from the rendered output' };
    }),
  );
}

/**
 * Render each workflow and write it LF, replacing any existing file.
 *
 * @returns Resolves to each written file, as its spec names it; rejects
 *   when a render violates the render contract, writing nothing for that
 *   workflow.
 */
export async function writeRenderedWorkflows(
  workflows: readonly WorkflowSpec[],
  root: string,
): Promise<string[]> {
  return Promise.all(
    workflows.map(async (spec) => {
      const rendered = await renderWorkflow(spec, root);
      const out = resolve(root, spec.out);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, rendered, 'utf8');
      return spec.out;
    }),
  );
}

/** Read a source file from disk by absolute path, as UTF-8. */
function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Collect the closure from the absolute `entry`, depth-first, each file after its imports. */
function closureOf(root: string, entry: string, read: SourceReader): ClosureFile[] {
  const seen = new Set<string>();
  const order: ClosureFile[] = [];
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const file: ClosureFile = { path, file: toPosix(relative(root, path)), source: read(path) };
    for (const dep of valueImports(file)) visit(dep);
    order.push(file);
  };
  visit(entry);
  return order;
}

/**
 * The absolute paths a closure file value-imports, in import order.
 *
 * @throws {@link Error} on a non-relative value import.
 */
function valueImports(file: ClosureFile): string[] {
  const sf = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.ES2022, false);
  return sf.statements.filter(ts.isImportDeclaration).flatMap((decl) => {
    if (isTypeOnly(decl)) return [];
    const specifier = (decl.moduleSpecifier as ts.StringLiteral).text;
    if (!specifier.startsWith('.')) {
      throw new Error(`workflow render: non-relative value import '${specifier}' in ${file.file}`);
    }
    return [resolve(dirname(file.path), specifier.replace(/\.js$/, '.ts'))];
  });
}

/**
 * Whether an import declaration binds types only (`import type`, or every named binding marked
 * `type`), so the render never follows it.
 */
function isTypeOnly(decl: ts.ImportDeclaration): boolean {
  const clause = decl.importClause;
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((e) => e.isTypeOnly)
  );
}

/** Transpile one closure file to plain JS with its module syntax dropped. */
function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
    },
    transformers: { before: [dropModuleSyntax], after: [dropExportDeclarations] },
  }).outputText;
}

/** Drop import and export declarations, and every `export` / `default` modifier, from a file. */
function dropModuleSyntax(): ts.Transformer<ts.SourceFile> {
  return (sf) =>
    ts.factory.updateSourceFile(
      sf,
      sf.statements.flatMap((s): ts.Statement[] => {
        if (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) return [];
        if (!ts.canHaveModifiers(s)) return [s];
        const modifiers = ts.getModifiers(s) ?? [];
        const kept = modifiers.filter((m) => !isExportModifier(m));
        return [kept.length === modifiers.length ? s : ts.factory.replaceModifiers(s, kept)];
      }),
    );
}

/** Drop the `export {};` the emitter appends to a module left without imports or exports. */
function dropExportDeclarations(): ts.Transformer<ts.SourceFile> {
  return (sf) =>
    ts.factory.updateSourceFile(
      sf,
      sf.statements.filter((s) => !ts.isExportDeclaration(s)),
    );
}

/** Whether a modifier is `export` or `default`. */
function isExportModifier(m: ts.ModifierLike): boolean {
  return m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword;
}

/**
 * Reject a forbidden token or word in one chunk of output.
 *
 * @param chunk - The chunk and the file it came from (`meta` for the meta literal).
 * @throws {@link Error} naming the first forbidden token and the file.
 */
function assertNoForbidden(chunk: { readonly file: string; readonly js: string }): void {
  const found =
    FORBIDDEN_TOKENS.find((t) => chunk.js.includes(t)) ??
    FORBIDDEN_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(chunk.js));
  if (found !== undefined) {
    throw new Error(`workflow render: forbidden token '${found}' in ${chunk.file}`);
  }
}

/**
 * Reject a top-level name another of the closure `chunks` declares too, or that a hook takes.
 *
 * @throws {@link Error} naming the name and the files.
 */
function assertNames(chunks: readonly { readonly file: string; readonly js: string }[]): void {
  const owner = new Map<string, string>();
  for (const chunk of chunks) {
    for (const name of topLevelNames(chunk.js)) {
      assertNotHook(name, chunk.file);
      const first = owner.get(name);
      if (first !== undefined) {
        throw new Error(
          `workflow render: top-level name '${name}' is declared in both ${first} and ${chunk.file}`,
        );
      }
      owner.set(name, chunk.file);
    }
  }
}

/**
 * Reject a top-level name a hook takes.
 *
 * @throws {@link Error} naming the name and the closure file declaring it.
 */
function assertNotHook(name: string, file: string): void {
  if (HOOK_NAMES.includes(name)) {
    throw new Error(`workflow render: top-level name '${name}' in ${file} is a workflow hook`);
  }
}

/**
 * The names a JS chunk declares at top level: function, class and variable names, destructured
 * bindings included.
 */
function topLevelNames(js: string): string[] {
  const sf = ts.createSourceFile('chunk.js', js, ts.ScriptTarget.ES2022, false, ts.ScriptKind.JS);
  return sf.statements.flatMap((s) => {
    if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) return s.name ? [s.name.text] : [];
    if (ts.isVariableStatement(s)) {
      return s.declarationList.declarations.flatMap((d) => bindingNames(d.name));
    }
    return [];
  });
}

/** Every identifier a binding introduces. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : bindingNames(e.name)));
}
