/**
 * The workflow runtime's vocabulary, as the workflow sources see it
 * (ADR-0045 decision 1): the hooks a saved workflow's body is given, the
 * options of one `agent()` call, and the `meta` export. The runtime binds
 * the hooks as globals; the sources take them as one object instead, so a
 * test can drive the body with fakes, and only the rendered tail
 * (`tooling/lib/workflow-render.ts`) names the globals.
 *
 * Type-only — erased at render, so it adds nothing to the render closure.
 */

/** A per-call reasoning effort. */
export type Effort = 'low' | 'medium' | 'high';

/** A per-call model alias; absent means the call inherits the session's model. */
export type ModelAlias = 'opus' | 'sonnet' | 'haiku';

/** A JSON Schema object an agent's structured output must satisfy. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * The options of one `agent()` call. The runtime honours a per-call `model`
 * and `effort` — `effort` with a non-default model included (PF-95).
 *
 * **No working directory.** Every agent starts in the main checkout the
 * session runs in, whatever worktree it works in (PF-94; #1054). No option here sets another: none
 * was observed (#1026's capability questions never asked), and none can be
 * probed inside an unattended run. So a worktree agent reaches its worktree
 * by absolute path (`cd`, `git -C`), and the CLAUDE.md, rules and skills its
 * session loads are the main checkout's. Each worktree agent's file has it
 * read the worktree's copies by path.
 */
export interface AgentOptions {
  /** The call's label in the run's transcript: `<stage>` or `<stage>:<detail>`. */
  readonly label: string;
  /** The project agent to run (`.claude/agents/<agentType>.md`). */
  readonly agentType?: string;
  /** The model; absent inherits. */
  readonly model?: ModelAlias;
  /** The effort; absent inherits. */
  readonly effort?: Effort;
  /**
   * The structured output's schema; the runtime validates the answer against
   * it, constraints such as `minimum` included.
   */
  readonly schema?: JsonSchema;
}

/** The hooks the workflow body is given. */
export interface WorkflowHooks {
  /** Run one agent; resolves to its structured output, or `null` when it returned none. */
  readonly agent: (prompt: string, options: AgentOptions) => Promise<unknown>;
  /** Run thunks concurrently; a thunk that threw yields `null`. */
  readonly parallel: <T>(thunks: readonly (() => Promise<T>)[]) => Promise<(T | null)[]>;
  /** Run `step` over each item. */
  readonly pipeline: <T, R>(items: readonly T[], step: (item: T) => Promise<R>) => Promise<R[]>;
  /** Enter the named phase of `meta.phases`. */
  readonly phase: (title: string) => void;
  /** Append a line to the run's log. */
  readonly log: (message: string) => void;
}

/** One phase of a workflow, as `meta.phases` lists it. */
export interface WorkflowPhase {
  /** The title `phase()` is called with. */
  readonly title: string;
  /** One line on what the phase does. */
  readonly detail: string;
}

/** A saved workflow's `meta` export. */
export interface WorkflowMeta {
  /** The workflow's name. */
  readonly name: string;
  /** What it does. */
  readonly description: string;
  /** When to launch it, and with which arguments. */
  readonly whenToUse: string;
  /** Its phases, in run order. */
  readonly phases: readonly WorkflowPhase[];
}
