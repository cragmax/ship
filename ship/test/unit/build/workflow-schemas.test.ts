import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it, onTestFailed } from 'vitest';

import { checkSchemaModule, SCHEMA_MODULE } from '../../../src/build/workflow-schemas.js';
import { compareStrings } from '../../../../tooling/lib/strings.js';
import { AGENT_CALLS } from '../../../src/workflow/calls/agent-calls.js';
import type { JsonSchema } from '../../../src/workflow/runtime.types.js';
import {
  AGENT_OUTPUT_SCHEMAS,
  TOOL_ENVELOPE_SCHEMAS,
} from '../../../src/workflow/schemas.generated.js';
import { runTool, TOOL_SCHEMAS } from '../../../src/workflow/calls/tool-calls.js';

import { fakeHooks, LAND_OK } from '../workflow/_fake-hooks.js';

const ROOT = resolve(import.meta.dirname, '../../../..');

/** A schema's child node, when it is one. */
const nodeOf = (value: unknown): JsonSchema | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;

/** Every property path (`a.b`, `a[].b`) no `required` list names, at every object level. */
function optionalPaths(schema: JsonSchema, prefix = ''): string[] {
  const items = nodeOf(schema['items']);
  if (items !== undefined) return optionalPaths(items, `${prefix}[]`);
  const properties = nodeOf(schema['properties']) ?? {};
  const required = (schema['required'] ?? []) as readonly string[];
  return Object.entries(properties).flatMap(([key, sub]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const own = required.includes(key) ? [] : [path];
    const node = nodeOf(sub);
    return node === undefined ? own : [...own, ...optionalPaths(node, path)];
  });
}

/** A schema and every node under its `properties` and `items`. */
function nodes(schema: JsonSchema): JsonSchema[] {
  const children = [...Object.values(nodeOf(schema['properties']) ?? {}), schema['items']].flatMap(
    (child) => {
      const node = nodeOf(child);
      return node === undefined ? [] : nodes(node);
    },
  );
  return [schema, ...children];
}

/** Each node's keys and `type` names, deduplicated and sorted. */
function constructs(schemas: readonly JsonSchema[]): { keys: string[]; types: string[] } {
  const all = schemas.flatMap(nodes);
  const keys = new Set(all.flatMap((n) => Object.keys(n)));
  const types = new Set(all.flatMap((n) => [n['type'] ?? []].flat() as string[]));
  return { keys: [...keys].sort(compareStrings), types: [...types].sort(compareStrings) };
}

const optionalOf = (schemas: Readonly<Record<string, JsonSchema>>) =>
  Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      optionalPaths(schema).sort(compareStrings),
    ]),
  );

const WORKTREE_OPTIONAL = ['reason', 'stderrTail'];

// The construct set the workflow runtime has been seen to accept.
const ALLOWED_KEYS = ['description', 'enum', 'items', 'properties', 'required', 'type'];
const ALLOWED_TYPES = ['array', 'boolean', 'integer', 'null', 'object', 'string'];

/** {@link LAND_OK} with its required `at` dropped. */
const LAND_WITHOUT_AT = Object.fromEntries(Object.entries(LAND_OK).filter(([key]) => key !== 'at'));

const SLICE_REVIEW_VALUES = {
  issue: 7,
  slice: 'C:/r/slice-7-1',
  base: 'cut1',
  reportDir: 'C:/r/reports',
  sha: 'slice1',
  files: ['a.ts'],
  reportPath: 'C:/r/reports/spec-review-7-1.md',
  passed: {
    sha: 'slice1',
    tests: ['a.test.ts'],
    evidence: {
      kind: 'none' as const,
      test: '',
      pseudocode: '',
      red: '',
      green: '',
      reason: 'config only',
    },
    amended: [],
  },
  lease: { main: 'C:/r/main', projectDir: 'C:/r/slice-7-1', registry: 'C:/r/reports/pool.json' },
};

const SPEC_REVIEW_OK = {
  verdict: 'fixed',
  sha: 'spec1',
  summary: 'covered criterion 3',
  leaseLines: [],
};

describe('consumed fields are required', () => {
  it('leaves only the legitimately absent fields optional in every tool schema', () => {
    expect(optionalOf(TOOL_SCHEMAS)).toEqual({
      preflight: WORKTREE_OPTIONAL,
      'run-gate': ['excluded[].blockers', 'failures[].issue', 'stderrTail'],
      'live-runs': WORKTREE_OPTIONAL,
      check: ['stderrTail'],
      'comment-only': ['stderrTail'],
      'cut-batch': WORKTREE_OPTIONAL,
      'provision-batch': WORKTREE_OPTIONAL,
      'cut-slice': WORKTREE_OPTIONAL,
      provision: WORKTREE_OPTIONAL,
      land: WORKTREE_OPTIONAL,
      teardown: WORKTREE_OPTIONAL,
      'retire-run': WORKTREE_OPTIONAL,
      'sync-master': WORKTREE_OPTIONAL,
      bump: WORKTREE_OPTIONAL,
      publish: WORKTREE_OPTIONAL,
      'check-master': WORKTREE_OPTIONAL,
      'append-pr-body': WORKTREE_OPTIONAL,
      'post-pr-comment': WORKTREE_OPTIONAL,
      'post-issue-comment': WORKTREE_OPTIONAL,
      'changed-files': WORKTREE_OPTIONAL,
    });
  });

  it('leaves only the tdd’s reason optional in every agent output schema', () => {
    expect(optionalOf(AGENT_OUTPUT_SCHEMAS)).toEqual({
      issueReadiness: [],
      issueOverlap: [],
      tdd: ['reason'],
      specReview: [],
      testReview: [],
      standardsReview: [],
      scriptApiTsdoc: [],
      epicReview: [],
      retro: [],
      prWriter: [],
    });
  });

  // Hand-written: a probe record's measured duration, whole seconds.
  it('requires the tdd probe record’s duration in whole seconds', () => {
    const probe = AGENT_OUTPUT_SCHEMAS.tdd.properties.probes.items;

    expect(probe.properties.seconds).toEqual({ type: 'integer' });
    expect(probe.required).toContain('seconds');
  });

  it('requires the tdd’s evidence: a kind of tracer or none and five strings', () => {
    expect(AGENT_OUTPUT_SCHEMAS.tdd.required).toContain('evidence');
    expect(AGENT_OUTPUT_SCHEMAS.tdd.properties.evidence).toEqual({
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tracer', 'none'] },
        test: { type: 'string' },
        pseudocode: { type: 'string' },
        red: { type: 'string' },
        green: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['kind', 'test', 'pseudocode', 'red', 'green', 'reason'],
    });
  });

  it('requires the tdd’s recorded values, an array of strings', () => {
    expect(AGENT_OUTPUT_SCHEMAS.tdd.required).toContain('recorded');
    expect(AGENT_OUTPUT_SCHEMAS.tdd.properties.recorded).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('requires the PR writer’s summary, door, door note, blast radius and ramifications', () => {
    expect(AGENT_OUTPUT_SCHEMAS.prWriter).toEqual({
      type: 'object',
      properties: {
        summary: { type: 'string' },
        door: { type: 'string', enum: ['one-way', 'two-way'] },
        doorNote: { type: 'string' },
        blastRadius: { type: 'string' },
        ramifications: { type: 'string' },
      },
      required: ['summary', 'door', 'doorNote', 'blastRadius', 'ramifications'],
    });
  });
});

describe('a slice review’s output schema', () => {
  it.each(['verdict', 'sha', 'summary', 'leaseLines'])(
    'records a spec review answer lacking %s',
    async (field) => {
      const answer = Object.fromEntries(
        Object.entries(SPEC_REVIEW_OK).filter(([key]) => key !== field),
      );
      const run = fakeHooks({ specReview: answer }, { offSchema: true });

      await AGENT_CALLS.specReview(run.hooks, SLICE_REVIEW_VALUES, '7-1');

      expect(run.violations).toEqual([`specReview:7-1: lacks required ${field}`]);
    },
  );
});

describe('the construct set', () => {
  it('hands the runtime only the keywords and types it has been seen to accept', async () => {
    const run = fakeHooks();
    await AGENT_CALLS.issueOverlap(run.hooks, {
      runSet: [{ epic: null, issues: [7, 8] }],
      edges: [],
      liveRuns: [],
    });
    const overlap = run.calls[0]?.schema;
    expect(overlap).toBeDefined();

    const { keys, types } = constructs([
      ...Object.values(TOOL_SCHEMAS),
      ...Object.values(AGENT_OUTPUT_SCHEMAS),
      overlap ?? {},
    ]);

    expect(ALLOWED_KEYS).toEqual(expect.arrayContaining(keys));
    expect(ALLOWED_TYPES).toEqual(expect.arrayContaining(types));
  });

  it('emits no description into the generated module', () => {
    const { keys } = constructs([
      ...Object.values(TOOL_ENVELOPE_SCHEMAS),
      ...Object.values(AGENT_OUTPUT_SCHEMAS),
    ]);

    expect(keys).not.toContain('description');
  });
});

describe('checkSchemaModule', () => {
  const committed = readFileSync(resolve(ROOT, SCHEMA_MODULE), 'utf8');

  it('reports the committed module ok', async () => {
    await expect(checkSchemaModule(ROOT)).resolves.toEqual({ target: SCHEMA_MODULE, ok: true });
  });

  it('reports a module with one property renamed as differing', async () => {
    const renamed = committed.replace('batchClean:', 'batchIsClean:');
    expect(renamed).not.toBe(committed);

    const check = await checkSchemaModule(ROOT, () => renamed);

    expect(check).toEqual({
      target: SCHEMA_MODULE,
      ok: false,
      reason: 'differs from the emitted output',
    });
  });

  it('reports an equal module stored CRLF ok', async () => {
    const crlf = committed.replace(/\r?\n/g, '\r\n');

    await expect(checkSchemaModule(ROOT, () => crlf)).resolves.toEqual({
      target: SCHEMA_MODULE,
      ok: true,
    });
  });

  it('reports a missing module', async () => {
    await expect(checkSchemaModule(ROOT, () => undefined)).resolves.toEqual({
      target: SCHEMA_MODULE,
      ok: false,
      reason: 'missing — never emitted',
    });
  });
});

describe('the fake hooks check types against the emitted schema', () => {
  it('records a string where land’s schema wants a boolean', async () => {
    const run = fakeHooks(
      { 'runner:land': { ...LAND_OK, batchClean: 'yes' } },
      { offSchema: true },
    );

    await runTool(run.hooks, 'land', []);

    expect(run.violations).toEqual([expect.stringMatching(/\.batchClean\b.*\bboolean\b/)]);
  });

  it('records a null where land’s schema admits none', async () => {
    const run = fakeHooks({ 'runner:land': { ...LAND_OK, batchClean: null } }, { offSchema: true });

    await runTool(run.hooks, 'land', []);

    expect(run.violations).toEqual([expect.stringMatching(/\.batchClean: null is not boolean$/)]);
  });

  it('records a fraction where the schema wants an integer', async () => {
    const run = fakeHooks({ 'runner:land': { ...LAND_OK, exitCode: 0.5 } }, { offSchema: true });

    await runTool(run.hooks, 'land', []);

    expect(run.violations).toEqual([expect.stringMatching(/\.exitCode: 0\.5 is not integer$/)]);
  });

  it('records a required key present as undefined as lacking', async () => {
    const run = fakeHooks({ 'runner:land': { ...LAND_OK, at: undefined } }, { offSchema: true });

    await runTool(run.hooks, 'land', []);

    expect(run.violations).toEqual(['runner:land: lacks required at']);
  });
});

describe('the fake hooks fail a test on a schema violation', () => {
  // The it.fails test's error messages, read by the test after it: a file's tests run in order.
  let failure: string[] | undefined;

  // it.fails inverts the result: this passes only because the harness's finish check
  // fails the test.
  it.fails(
    'fails a test whose fake answer lacks a required field, with no assertion on violations',
    async () => {
      onTestFailed(({ task }) => {
        failure = task.result?.errors?.map((error) => error.message);
      });
      const run = fakeHooks({ 'runner:land': LAND_WITHOUT_AT });

      await runTool(run.hooks, 'land', []);
    },
  );

  // it.fails passes on any failure: this pins the finish check as its one cause.
  it('fails that test through the finish check alone, naming each violation', () => {
    expect(failure).toEqual([
      'fake answers broke their call schemas:\nrunner:land: lacks required at',
    ]);
  });

  it('records the dropped field for a run that opts out, and passes', async () => {
    const run = fakeHooks({ 'runner:land': LAND_WITHOUT_AT }, { offSchema: true });

    await runTool(run.hooks, 'land', []);

    expect(run.violations).toEqual(['runner:land: lacks required at']);
  });
});

/**
 * What `fn` threw.
 *
 * @param fn - The call.
 * @returns The thrown value; `undefined` when it returned.
 */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('the fake hooks outside a running test', () => {
  let byDefault: unknown;
  let offSchema: unknown;

  // A beforeAll hook runs with no current test, as a describe body does.
  beforeAll(() => {
    byDefault = thrownBy(() => fakeHooks());
    offSchema = thrownBy(() => fakeHooks({}, { offSchema: true }));
  });

  it('throw by default, as the finish check needs a running test', () => {
    expect(byDefault).toBeInstanceOf(Error);
    expect((byDefault as Error).message).toMatch(/onTestFinished/);
  });

  it('build a run that opts out, registering no finish check', () => {
    expect(offSchema).toBeUndefined();
  });
});
