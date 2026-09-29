/**
 * The `ship` workflow's prompt builders, one per stage. A prompt carries
 * values only — the command, the paths, the issues; each stage's
 * discipline lives in its agent file (`.claude/agents/<agentType>.md`), so
 * a prompt never restates it.
 *
 * Render-safe (`tooling/lib/workflow-render.ts`): ECMAScript built-ins only,
 * no top-level side effect.
 */

/** A live run's changed files, for the scout's overlap judgment. */
export interface LiveRunFiles {
  /** The run branch, e.g. `ship/epic-1025`. */
  readonly branch: string;
  /** The paths it changed since its merge-base, repository-relative. */
  readonly landed: readonly string[];
}

/** The runner's values: one command and where its envelope goes. */
export interface RunnerValues {
  /** The command words, run from the main checkout; each free of shell metacharacters. */
  readonly argv: readonly string[];
  /** The path stem of `<stem>.json`, `<stem>.err` and `<stem>.exit`, relative to the main checkout. */
  readonly envelopeStem: string;
}

/** The scout's values: the run set and the live runs. */
export interface ScoutValues {
  /** The run-set issues, ascending. */
  readonly issues: readonly number[];
  /** The unspent live runs — those whose files the run could still collide with. */
  readonly liveRuns: readonly LiveRunFiles[];
}

/** Every stage's prompt builder. */
export const PROMPTS = {
  runner: (values: RunnerValues): string =>
    [`Command: ${values.argv.join(' ')}`, `Envelope stem: ${values.envelopeStem}`].join('\n'),
  scout: (values: ScoutValues): string =>
    [
      `Run-set issues: ${values.issues.map((n) => `#${String(n)}`).join(', ')}`,
      `Live runs (JSON): ${JSON.stringify(values.liveRuns)}`,
    ].join('\n'),
};
