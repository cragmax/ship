/**
 * The run gate's `gh` boundary: fetch, validate and normalise the issue data
 * the pure core (`ship/src/core/gate/run-gate.ts`) decides over, through an injected
 * {@link GhJson} port. The real port lives only in the CLI (`ship/src/cli/run-gate.ts`).
 *
 * **Three fetches, each zod-parsed**: an epic (`EPIC_FIELDS`), a run-set
 * issue (`FACTS_FIELDS`) and an out-of-set blocker (`STATE_FIELDS`). Each
 * schema requires only the fields the gate reads and tolerates unknown keys.
 * A shape mismatch throws: the gate never guesses at gh output. An attached run adds one
 * git read, its landed set ({@link landedIssues}), through an injected {@link GitText} port.
 *
 * **Never gate on a partial list.** A gh connection may hold only a page, so every one passes
 * {@link complete} before it is read.
 *
 * **Same-repo assumption.** A native link's node carries no repository, so its number is read
 * as a same-repo issue (Ship PF-1).
 */

import { z } from 'zod';

import { formatZodIssues } from '../../../src/contracts/index.js';

import { parseBlockedBySection } from '../core/gate/run-gate-blocked-by.js';
import {
  checkIssue,
  evaluateRunGate,
  outOfSetBlockers,
  resolveRunSet,
  type EpicChild,
  type GateMode,
  type GateVerdict,
  type IssueCheck,
  type IssueFacts,
  type IssueState,
  type LaunchSpec,
} from '../core/gate/run-gate.js';
import { runSetIssues } from '../core/run-set.js';

/**
 * The injected `gh` port: run `gh <args>` and resolve its stdout parsed as
 * JSON. A rejection propagates out of every gather unchanged.
 */
export type GhJson = (args: readonly string[]) => Promise<unknown>;

/** The injected git port: run `git <args>` and resolve its stdout. A rejection propagates. */
export type GitText = (args: readonly string[]) => Promise<string>;

/** An attached run's target: its branch (`ship/<slug>`) and the git port that reads it. */
interface AttachTarget {
  readonly branch: string;
  readonly git: GitText;
}

const EPIC_FIELDS = 'number,subIssues';
const FACTS_FIELDS = 'number,state,labels,body,blockedBy';
const STATE_FIELDS = 'number,state';

const StateSchema = z.enum(['OPEN', 'CLOSED']);
const LinkSchema = z.object({ number: z.number().int().positive(), state: StateSchema });
const ConnectionSchema = z.object({
  nodes: z.array(LinkSchema),
  totalCount: z.number().int().nonnegative(),
});
const EpicSchema = z.object({ number: z.number().int().positive(), subIssues: ConnectionSchema });
const FactsSchema = z.object({
  number: z.number().int().positive(),
  state: StateSchema,
  labels: z.array(z.object({ name: z.string() })),
  body: z.string(),
  blockedBy: ConnectionSchema,
});
const StateOnlySchema = z.object({ number: z.number().int().positive(), state: StateSchema });

/** A parsed `issue view --json number,state,labels,body,blockedBy` answer. */
type GhFacts = z.infer<typeof FactsSchema>;

/** A parsed `subIssues` / `blockedBy` connection. */
type GhConnection = z.infer<typeof ConnectionSchema>;

/**
 * Normalise a parsed facts answer into the core's {@link IssueFacts}.
 *
 * @returns The facts. `blockedBy` is the body's `## Blocked by` section ∪ the
 *   native link numbers, deduped, ascending.
 */
export function toIssueFacts(raw: GhFacts): IssueFacts {
  const blockedBy = new Set([
    ...parseBlockedBySection(raw.body),
    ...raw.blockedBy.nodes.map((n) => n.number),
  ]);

  return {
    number: raw.number,
    state: raw.state,
    labels: raw.labels.map((l) => l.name),
    blockedBy: [...blockedBy].sort((a, b) => a - b),
  };
}

/**
 * Gather every fact the gate needs through `gh`, then evaluate it: epic
 * sub-issues → run-set facts → out-of-set blocker states → `attach`'s landed
 * set, when given → the core's verdict. Each phase's fetches run
 * concurrently. Output order is the core's.
 *
 * @throws When an answer fails its schema or a list is truncated (the message
 *   names the issue), or when a {@link GhJson} or {@link GitText} call rejects.
 */
export async function gatherAndEvaluate(
  spec: LaunchSpec,
  mode: GateMode,
  gh: GhJson,
  attach?: AttachTarget,
): Promise<GateVerdict> {
  const epics = spec.kind === 'epics' ? spec.epics : [];
  const epicChildren = new Map(
    await Promise.all(epics.map(async (e) => [e, await fetchEpicChildren(e, gh)] as const)),
  );
  const runSet = resolveRunSet(spec, epicChildren);
  const facts = await Promise.all(runSetIssues(runSet).map((n) => fetchFacts(n, gh)));
  const blockerStates = new Map(
    await Promise.all(
      outOfSetBlockers(runSet, facts).map(async (b) => [b, await fetchState(b, gh)] as const),
    ),
  );
  const landed =
    attach === undefined ? new Set<number>() : await landedIssues(attach.branch, attach.git);

  return evaluateRunGate({ runSet, facts, blockerStates, mode, landed });
}

/**
 * An attached run's landed set: each issue a `fixes #N` line cites in the body of a first-parent,
 * non-merge commit of `origin/master..origin/<branch>`. A `see #N` line never counts: the issue
 * did not fully land.
 *
 * @param branch - The attach target, `ship/<slug>`.
 * @throws When the {@link GitText} call rejects (an unknown ref among its causes).
 */
export async function landedIssues(branch: string, git: GitText): Promise<ReadonlySet<number>> {
  const bodies = await git([
    'log',
    '--first-parent',
    '--no-merges',
    '--format=%b',
    `origin/master..origin/${branch}`,
  ]);

  return new Set([...bodies.matchAll(/^fixes #(\d+)\s*$/gm)].map((m) => Number(m[1])));
}

/**
 * Check one issue from a single facts fetch. Its blockers are never fetched.
 *
 * @throws As {@link gatherAndEvaluate}.
 */
export async function gatherCheck(issue: number, gh: GhJson): Promise<IssueCheck> {
  return checkIssue(await fetchFacts(issue, gh));
}

/** Fetch every sub-issue of an epic, open and closed. */
async function fetchEpicChildren(epic: number, gh: GhJson): Promise<readonly EpicChild[]> {
  const raw = parseAnswer(EpicSchema, await ghView(gh, epic, EPIC_FIELDS), epic);

  return complete(raw.subIssues, epic, 'subIssues').nodes;
}

/** Fetch and normalise one run-set issue's facts. */
async function fetchFacts(issue: number, gh: GhJson): Promise<IssueFacts> {
  const raw = parseAnswer(FactsSchema, await ghView(gh, issue, FACTS_FIELDS), issue);
  complete(raw.blockedBy, issue, 'blockedBy');

  return toIssueFacts(raw);
}

/** Fetch an out-of-set blocker's state. */
async function fetchState(blocker: number, gh: GhJson): Promise<IssueState> {
  return parseAnswer(StateOnlySchema, await ghView(gh, blocker, STATE_FIELDS), blocker).state;
}

/** Run `gh issue view N --json FIELDS`: the raw answer. */
function ghView(gh: GhJson, issue: number, fields: string): Promise<unknown> {
  return gh(['issue', 'view', String(issue), '--json', fields]);
}

/**
 * Validate a gh answer about `issue` against its schema.
 *
 * @throws When the answer fails the schema. The message names the issue and each failing field
 *   path.
 */
function parseAnswer<S extends z.ZodType>(schema: S, raw: unknown, issue: number): z.infer<S> {
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw new Error(
      `run-gate: gh answer for #${String(issue)} has an unexpected shape: ${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

/**
 * The truncation guard over a parsed `subIssues` / `blockedBy` connection, returned unchanged.
 *
 * @throws When `totalCount` exceeds `nodes.length`: gh returned only a page (unprobed).
 */
function complete(connection: GhConnection, issue: number, field: string): GhConnection {
  if (connection.totalCount > connection.nodes.length) {
    throw new Error(
      `run-gate: #${String(issue)} ${field} is truncated (${String(connection.nodes.length)} of ${String(connection.totalCount)}); refusing to gate on a partial list`,
    );
  }

  return connection;
}
