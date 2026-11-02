import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { emitJsonSchema } from '../../../src/build/json-schema-normalise.js';

describe('emitJsonSchema — nullables', () => {
  it('writes a nullable string as a two-type string', () => {
    expect(emitJsonSchema(z.string().nullable())).toEqual({ type: ['string', 'null'] });
  });

  it('writes a nullable enum with null appended to the enum', () => {
    expect(emitJsonSchema(z.enum(['a', 'b']).nullable())).toEqual({
      type: ['string', 'null'],
      enum: ['a', 'b', null],
    });
  });

  it('writes a nullable object as a two-type object, its properties kept', () => {
    expect(emitJsonSchema(z.object({ x: z.string() }).nullable())).toEqual({
      type: ['object', 'null'],
      properties: { x: { type: 'string' } },
      required: ['x'],
    });
  });
});

describe('emitJsonSchema — what zod adds beyond the construct set', () => {
  it('drops $schema, additionalProperties, readOnly and the safe-integer bounds', () => {
    const schema = z.object({
      n: z.int(),
      s: z.array(z.string()).readonly(),
      o: z.string().optional(),
    });

    expect(emitJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        s: { type: 'array', items: { type: 'string' } },
        o: { type: 'string' },
      },
      required: ['n', 's'],
    });
  });
});

describe('emitJsonSchema — outside the construct set', () => {
  it('throws on a string bound, naming the key and its path', () => {
    expect(() => emitJsonSchema(z.object({ s: z.string().min(1) }))).toThrow(
      /'minLength'.*properties\.s/,
    );
  });

  it('throws on an integer bound other than the safe-integer one, naming the key and its path', () => {
    expect(() => emitJsonSchema(z.object({ n: z.int().min(0) }))).toThrow(
      /'minimum'.*properties\.n/,
    );
  });

  it('throws on an object that admits unlisted keys, naming additionalProperties at the root', () => {
    expect(() => emitJsonSchema(z.object({}).catchall(z.string()))).toThrow(
      /'additionalProperties' at \(root\)/,
    );
  });

  it('throws on a union, naming anyOf', () => {
    expect(() => emitJsonSchema(z.union([z.string(), z.int()]))).toThrow(/'anyOf'/);
  });

  it('throws on a nullable whose inner schema names no type, naming anyOf', () => {
    expect(() => emitJsonSchema(z.object({ u: z.unknown().nullable() }))).toThrow(
      /'anyOf'.*properties\.u/,
    );
  });
});
