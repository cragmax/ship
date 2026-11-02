import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';

import * as prettier from 'prettier';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FORBIDDEN_TOKENS,
  FORBIDDEN_WORDS,
  renderWorkflow,
  workflowClosure,
  writeRenderedWorkflows,
  type WorkflowSpec,
} from '../../../src/build/workflow-render.js';
import { RESYNC_META } from '../../../src/workflow/resync.meta.js';
import { SHIP_META } from '../../../src/workflow/ship.meta.js';
import { FIXTURE_PRETTIER_CONFIG, fixtureGitignore } from '../../helpers/fixtures.js';
import { fixtureEnv } from '../../helpers/worktree-fixture.js';
import { workflowSpec } from '../workflow/_render.js';

const ROOT = resolve(import.meta.dirname, '../../../..');
const TAIL = 'return await runShip({ agent, parallel, pipeline, phase, log }, args);\n';

// Hand-written: the union of run-scheduler.test.ts's render-safety list.
const FORBIDDEN = [
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

/** A source reader over in-memory files, keyed by repo-relative path. */
const fixture = (files: Readonly<Record<string, string>>) => {
  const byPath = new Map(Object.entries(files).map(([p, src]) => [resolve(ROOT, p), src]));

  return (path: string): string => {
    const src = byPath.get(path);
    if (src === undefined) throw new Error(`no fixture file ${path}`);

    return src;
  };
};

/**
 * A thunk compiling a render, meta `export` dropped, as the body of the
 * runtime's async workflow function, compiled only, never run.
 */
const compileAsBody = (out: string) => (): vm.Script =>
  // eslint-disable-next-line sonarjs/code-eval -- test-owned render output, compiled not run
  new vm.Script(
    `(async function(agent,parallel,pipeline,phase,log,args,budget,workflow){\n${out.replace(/^export /, '')}\n})`,
  );

const FIXTURE_SPEC: WorkflowSpec = {
  name: 'a',
  entry: 'fx/a.ts',
  meta: { name: 'a', description: 'd', whenToUse: 'w', phases: [] },
  out: 'fx/a.js',
};

describe('the ship render', () => {
  let out = '';
  beforeAll(async () => {
    out = await renderWorkflow(workflowSpec('ship'), ROOT);
  });

  it('opens with the meta literal, deep-equal to SHIP_META, then the generated-by line', () => {
    expectMetaHead(out, SHIP_META, 'ship');
  });

  it('has exactly one export and no import', () => {
    expect(out.match(/^export\s/gm)).toHaveLength(1);
    expect(out.split('\n').filter((line) => /^import[\s{*'"]/.test(line.trim()))).toEqual([]);
    expect(out).not.toMatch(/\bimport\s*\(/);
  });

  it('ends with the runShip tail', () => {
    expect(out.endsWith(TAIL)).toBe(true);
  });

  it('places run-set, then the scheduler, then the drive loop, lease timings inlined too', () => {
    const at = (declaration: string): number => {
      const index = out.indexOf(declaration);
      expect(index, declaration).toBeGreaterThan(-1);

      return index;
    };

    expect(at('function runSetIssues(')).toBeLessThan(at('function createScheduler('));
    expect(at('function createScheduler(')).toBeLessThan(at('async function drive('));
    expect(at('function parseLeaseLines(')).toBeLessThan(at('function renderPrBody('));
  });

  it('compiles as the body of the async workflow function once the meta export is dropped', () => {
    expect(compileAsBody(out)).not.toThrow();
  });

  it.each(FORBIDDEN)('never contains %s', (token) => {
    expect(out).not.toContain(token);
  });

  it('never names Date', () => {
    expect(out).not.toMatch(/\bDate\b/);
  });

  it('is already prettier-formatted', async () => {
    expect(await formatted(workflowSpec('ship').out, out)).toBe(out);
  });

  it('guards the whole render-safety list', () => {
    expect([...FORBIDDEN_TOKENS]).toEqual(FORBIDDEN);
    expect([...FORBIDDEN_WORDS]).toEqual(['Date']);
  });

  it('renders the same from LF and CRLF sources', async () => {
    // A Windows checkout (autocrlf) reads the sources CRLF, a Linux one LF.
    const eol = (to: string) => (path: string) => readFileSync(path, 'utf8').replace(/\r?\n/g, to);

    const fromLf = await renderWorkflow(workflowSpec('ship'), ROOT, eol('\n'));

    expect(await renderWorkflow(workflowSpec('ship'), ROOT, eol('\r\n'))).toBe(fromLf);
    expect(fromLf).toBe(out);
    expect(fromLf).not.toContain('\r');
  });
});

/** `source` as Prettier formats it at `filepath` under the fixture config. */
async function formatted(filepath: string, source: string): Promise<string> {
  const config = await prettier.resolveConfig(filepath, { config: FIXTURE_PRETTIER_CONFIG });

  return prettier.format(source, { ...config, filepath });
}

/** Asserts `out` opens with a meta literal deep-equal to `expected`, then the generated-by line. */
function expectMetaHead(out: string, expected: unknown, source: 'ship' | 'resync'): void {
  const head = 'export const meta = ';
  const end = out.indexOf('\n};\n');

  expect(out.startsWith(head)).toBe(true);
  // Evaluates the rendered literal alone, in an empty context: the literal is the subject.
  // eslint-disable-next-line sonarjs/code-eval -- test-owned render output, never user input
  const meta: unknown = vm.runInNewContext(`(${out.slice(head.length, end + 2)})`);
  expect(JSON.parse(JSON.stringify(meta))).toEqual(expected);
  expect(out.slice(end + 4).split('\n')[0]).toBe(
    `// Generated by ship/src/build/render-workflows.ts from ship/src/workflow/${source}.ts — do not edit; run \`npm run codegen\`.`,
  );
}

describe('the resync render', () => {
  let out = '';
  beforeAll(async () => {
    out = await renderWorkflow(workflowSpec('resync'), ROOT);
  });

  it('opens with the meta literal, deep-equal to RESYNC_META, then the generated-by line', () => {
    expectMetaHead(out, RESYNC_META, 'resync');
  });

  it('has exactly one export and no import, and ends with the runResync tail', () => {
    expect(out.match(/^export\s/gm)).toHaveLength(1);
    expect(out.split('\n').filter((line) => /^import[\s{*'"]/.test(line.trim()))).toEqual([]);
    expect(out).not.toMatch(/\bimport\s*\(/);
    expect(
      out.endsWith('return await runResync({ agent, parallel, pipeline, phase, log }, args);\n'),
    ).toBe(true);
  });

  it('compiles as the body of the async workflow function, never naming Date', () => {
    expect(compileAsBody(out)).not.toThrow();
    expect(out).not.toMatch(/\bDate\b/);
  });

  it('is already prettier-formatted', async () => {
    expect(await formatted(workflowSpec('resync').out, out)).toBe(out);
  });

  it('shares the merge step with ship, and reaches no worktree CLI and no epic end', () => {
    const resync = workflowClosure(ROOT, workflowSpec('resync').entry);
    const ship = workflowClosure(ROOT, workflowSpec('ship').entry);

    expect(resync).toContain('ship/src/workflow/epic-end/sync-master-step.ts');
    expect(ship).toContain('ship/src/workflow/epic-end/sync-master-step.ts');
    expect(resync.filter((f) => f.startsWith('ship/src/cli/'))).toEqual([]);
    expect(resync).not.toContain('ship/src/workflow/epic-end/epic-end.ts');
  });
});

describe('the render closure', () => {
  it('renders a closure a → b → c in dependency post-order: c, b, a', async () => {
    const read = fixture({
      'fx/a.ts': "import { b } from './b.js';\nexport function runA(): number { return b(); }\n",
      'fx/b.ts': "import { c } from './c.js';\nexport function b(): number { return c(); }\n",
      'fx/c.ts': 'export function c(): number { return 1; }\n',
    });

    const out = await renderWorkflow(FIXTURE_SPEC, ROOT, read);

    expect(out.indexOf('function c(')).toBeGreaterThan(0);
    expect(out.indexOf('function c(')).toBeLessThan(out.indexOf('function b('));
    expect(out.indexOf('function b(')).toBeLessThan(out.indexOf('function runA('));
    expect(
      out.endsWith('return await runA({ agent, parallel, pipeline, phase, log }, args);\n'),
    ).toBe(true);
  });

  it('takes the ship closure through run-set.ts and leaves out type-only modules', () => {
    const files = workflowClosure(ROOT, workflowSpec('ship').entry);

    expect(files).toContain('ship/src/core/run-set.ts');
    expect(files).not.toContain('ship/src/workflow/runtime.types.ts');
    expect(files).not.toContain('ship/src/core/gate/run-gate.ts');
    expect(files.at(-1)).toBe('ship/src/workflow/ship.ts');
  });

  it('takes the scheduler and the lease-line parser into the ship closure, never the CLIs', () => {
    const files = workflowClosure(ROOT, workflowSpec('ship').entry);
    const at = (file: string): number => files.indexOf(file);

    expect(files).toContain('ship/src/core/scheduler/run-scheduler.ts');
    expect(files).toContain('ship/src/workflow/pr/lease-timings.ts');
    expect(files).not.toContain('ship/src/core/scheduler/run-scheduler.types.ts');
    expect(files.filter((f) => f.startsWith('ship/src/cli/'))).toEqual([]);
    expect(at('ship/src/core/run-set.ts')).toBeLessThan(
      at('ship/src/core/scheduler/run-scheduler.ts'),
    );
    expect(at('ship/src/core/scheduler/run-scheduler.ts')).toBeLessThan(
      at('ship/src/workflow/drive.ts'),
    );
  });

  it.each(['ship', 'resync'])(
    'takes the emitted schema module into the %s closure, never its zod sources',
    async (name) => {
      const spec = workflowSpec(name);
      const files = workflowClosure(ROOT, spec.entry);

      expect(files).toContain('ship/src/workflow/schemas.generated.ts');
      expect(files.filter((f) => f.startsWith('ship/src/schemas/'))).toEqual([]);
      expect(await renderWorkflow(spec, ROOT)).not.toMatch(/\bzod\b/);
    },
  );

  it('follows no non-relative type-only import', async () => {
    const read = fixture({
      'fx/a.ts':
        "import type { ZodType } from 'zod';\nexport function runA(t: ZodType): unknown { return t; }\n",
    });

    await expect(renderWorkflow(FIXTURE_SPEC, ROOT, read)).resolves.toContain('function runA(t)');
  });
});

describe('the render guards', () => {
  it.each([
    [
      'a top-level name two closure files declare',
      {
        'fx/a.ts': "import { x } from './b.js';\nexport function dup(): number { return x; }\n",
        'fx/b.ts': 'export const x = 1;\nexport function dup(): number { return 2; }\n',
      },
      /'dup' .*fx\/b\.ts.*fx\/a\.ts/,
    ],
    [
      'a top-level name equal to a hook',
      { 'fx/a.ts': 'export const log = 1;\n' },
      /'log' .*fx\/a\.ts/,
    ],
    [
      'a non-relative value import',
      { 'fx/a.ts': "import { z } from 'zod';\nexport const s = z;\n" },
      /'zod' .*fx\/a\.ts/,
    ],
    [
      'a forbidden token',
      {
        'fx/a.ts': "import { now } from './b.js';\nexport const t = now;\n",
        'fx/b.ts': 'export const now = () => Date.now();\n',
      },
      /'Date\.now' .*fx\/b\.ts/,
    ],
    ['a forbidden word', { 'fx/a.ts': 'export const clock = Date;\n' }, /'Date' .*fx\/a\.ts/],
  ])('throws on %s, naming the files', async (_name, files, message) => {
    await expect(renderWorkflow(FIXTURE_SPEC, ROOT, fixture(files))).rejects.toThrow(message);
  });

  it('throws on a forbidden token in the meta literal, naming it', async () => {
    const spec = { ...FIXTURE_SPEC, meta: { ...FIXTURE_SPEC.meta, description: 'see console' } };
    const read = fixture({ 'fx/a.ts': 'export function runA(): void {}\n' });

    await expect(renderWorkflow(spec, ROOT, read)).rejects.toThrow(/'console' in meta/);
  });
});

describe('writeRenderedWorkflows', () => {
  let dir = '';
  let spec: WorkflowSpec = workflowSpec('ship');
  let rendered = '';
  beforeAll(async () => {
    rendered = await renderWorkflow(workflowSpec('ship'), ROOT);
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'workflow-render-'));
    spec = { ...workflowSpec('ship'), out: join(dir, 'ship.js') };
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites an existing CRLF file LF', async () => {
    writeFileSync(spec.out, 'stale\r\ncontent\r\n');

    await writeRenderedWorkflows([spec], ROOT);

    expect(readFileSync(spec.out, 'utf8')).toBe(rendered);
  });

  it('writes a new file LF', async () => {
    await writeRenderedWorkflows([spec], ROOT);

    expect(readFileSync(spec.out, 'utf8')).toBe(rendered);
    expect(rendered).not.toContain('\r');
  });
});

describe('the rendered workflow directory', () => {
  let repo = '';
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'workflow-ignore-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("is ignored by the main checkout's .gitignore, and the installed copy is not", () => {
    // A hook's inherited GIT_DIR would point both commands at the repository under commit.
    const options = { cwd: repo, env: fixtureEnv() };
    writeFileSync(join(repo, '.gitignore'), fixtureGitignore());
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git resolved via PATH intentionally, fixed argv, no shell
    expect(spawnSync('git', ['init', '-q'], options).status).toBe(0);
    // --no-index: judge the ignore rules even once the file is tracked.
    const ignored = (path: string): number | null =>
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- git resolved via PATH intentionally, fixed argv, no shell
      spawnSync('git', ['check-ignore', '-q', '--no-index', path], options).status;

    expect(ignored(workflowSpec('ship').out)).toBe(0);
    expect(ignored('ship/workflows/ship.js')).toBe(0);
    expect(ignored('.claude/workflows/ship.js')).toBe(1);
  });
});
