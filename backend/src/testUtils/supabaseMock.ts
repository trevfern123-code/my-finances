import { vi } from 'vitest';

/**
 * A minimal fake for supabase-js's chainable query builder. Every filter/modifier method
 * returns the same builder (so `.from().select().eq().eq()` chains work), and the builder
 * itself is thenable — awaiting it (with or without a trailing `.single()`/`.maybeSingle()`)
 * resolves to the given `{ data, error }`, matching how the real client behaves.
 */
export function createQueryBuilder(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  const chainMethods = [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'in',
    'not',
    'gte',
    'lt',
    'order',
    'limit',
  ];

  for (const method of chainMethods) {
    builder[method] = vi.fn(() => builder);
  }

  builder.single = vi.fn(() => Promise.resolve(result));
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = (
    onFulfilled: (value: typeof result) => unknown,
    onRejected?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(onFulfilled, onRejected);

  return builder as typeof builder & Record<string, ReturnType<typeof vi.fn>>;
}
