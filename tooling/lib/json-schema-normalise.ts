/**
 * Emit a zod schema as the JSON Schema a saved workflow hands the workflow
 * runtime (`AgentOptions.schema`): zod's own draft-07 output, rewritten
 * into the construct set the runtime has been seen to accept — `type`
 * (a name, or a name plus `'null'`), `properties`, `required`, `items` and
 * `enum`, nothing else (#1047). What that runtime does with any other
 * keyword is unobserved, so anything outside the set fails the emit rather
 * than reaching it.
 *
 * Rewrites, each exactly as zod 4 writes the construct:
 *
 * - the root `$schema` is dropped;
 * - `additionalProperties: false` (every `z.object`) is dropped;
 * - `readOnly: true` (`.readonly()`) is dropped;
 * - on an `integer`, `minimum` / `maximum` at the safe-integer bounds
 *   (`z.int()`'s own) are dropped;
 * - a nullable — `anyOf: [X, { type: 'null' }]` and no other key, X naming
 *   one `type` — becomes X with `type` widened to `[X.type, 'null']` and
 *   `null` appended to X's `enum` when it has one.
 *
 * Pure: no filesystem access.
 */

import { z } from 'zod';

import type { JsonSchema } from '../workflows/lib/hooks.types.js';

/** A schema node as zod emits it. */
type Node = Readonly<Record<string, unknown>>;

/** The keys an emitted node may keep. */
const KEPT_KEYS: readonly string[] = ['type', 'properties', 'required', 'items', 'enum'];

/** The integer bounds `z.int()` writes, which the emit drops. */
const SAFE_BOUNDS: Readonly<Record<string, number>> = {
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
};

/**
 * Emit a zod schema in the runtime's construct set.
 *
 * @param schema - The schema.
 * @returns Its JSON Schema, rewritten as the file header lists.
 * @throws {@link Error} `schema emit: unsupported construct '<key>' at <path>`
 *   for the first key outside the construct set that no rewrite removes —
 *   `<path>` is the key's node as `properties.a.items` steps, `(root)` for
 *   the root.
 */
export function emitJsonSchema(schema: z.ZodType): JsonSchema {
  const emitted = z.toJSONSchema(schema, { target: 'draft-07' }) as Node;
  const root = Object.fromEntries(Object.entries(emitted).filter(([key]) => key !== '$schema'));
  return normaliseNode(root, []);
}

/**
 * Rewrite one node and every node under it.
 *
 * @param node - The node.
 * @param path - Its path from the root.
 * @returns The rewritten node.
 * @throws {@link Error} on a key outside the construct set.
 */
function normaliseNode(node: Node, path: readonly string[]): JsonSchema {
  const inner = nullableInner(node);
  if (inner !== undefined) return withNull(normaliseNode(inner, path));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!isDropped(node, key, value)) {
      assertKept(key, path);
      out[key] = normaliseChild(key, value, path);
    }
  }
  return out;
}

/**
 * The inner node of a nullable as zod writes it.
 *
 * @param node - The node.
 * @returns X for `{ anyOf: [X, { type: 'null' }] }` with no other key,
 *   when X names exactly one `type`; `undefined` for anything else, whose
 *   `anyOf` the emit then refuses.
 */
function nullableInner(node: Node): Node | undefined {
  const anyOf = node['anyOf'];
  if (!Array.isArray(anyOf) || anyOf.length !== 2 || Object.keys(node).length !== 1) {
    return undefined;
  }
  const [inner, second] = anyOf as readonly unknown[];
  const isNull = JSON.stringify(second) === JSON.stringify({ type: 'null' });
  return isNull && isNode(inner) && typeof inner['type'] === 'string' ? inner : undefined;
}

/**
 * A rewritten node that also admits `null`.
 *
 * @param node - The rewritten inner node.
 * @returns It, `type` widened by `'null'` and `null` appended to its `enum`
 *   when it has one.
 */
function withNull(node: JsonSchema): JsonSchema {
  const values = node['enum'];
  return {
    ...node,
    type: [node['type'], 'null'],
    ...(Array.isArray(values) && { enum: [...(values as unknown[]), null] }),
  };
}

/**
 * Whether a key is one zod adds that the emit drops.
 *
 * @param node - The node holding it.
 * @param key - The key.
 * @param value - Its value.
 * @returns `true` for `additionalProperties: false`, `readOnly: true`, and a
 *   safe-integer bound on an `integer`.
 */
function isDropped(node: Node, key: string, value: unknown): boolean {
  if (key === 'additionalProperties') return value === false;
  if (key === 'readOnly') return value === true;
  return (
    node['type'] === 'integer' && Object.hasOwn(SAFE_BOUNDS, key) && SAFE_BOUNDS[key] === value
  );
}

/**
 * Refuse a key outside the construct set.
 *
 * @param key - The key.
 * @param path - Its node's path.
 * @throws {@link Error} naming the key and the path, unless it is kept.
 */
function assertKept(key: string, path: readonly string[]): void {
  if (KEPT_KEYS.includes(key)) return;
  const at = path.length === 0 ? '(root)' : path.join('.');
  throw new Error(`schema emit: unsupported construct '${key}' at ${at}`);
}

/**
 * Rewrite a kept key's value: the nodes under `properties` and `items`.
 *
 * @param key - The key.
 * @param value - Its value.
 * @param path - Its node's path.
 * @returns The rewritten value; `type`, `required` and `enum` as they are.
 */
function normaliseChild(key: string, value: unknown, path: readonly string[]): unknown {
  if (key === 'items' && isNode(value)) return normaliseNode(value, [...path, 'items']);
  if (key !== 'properties' || !isNode(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, sub]) => [
      name,
      isNode(sub) ? normaliseNode(sub, [...path, 'properties', name]) : sub,
    ]),
  );
}

/**
 * Whether a value is a schema node (a plain object).
 *
 * @param value - The value.
 * @returns `true` for a non-array object.
 */
function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
