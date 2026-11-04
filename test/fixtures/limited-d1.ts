/** A D1 binding that, like a Free Worker invocation, refuses more than `limit` queries; a batch is one query (D1 limits). */
export function limitedD1(binding: D1Database) {
  let calls = 0, limit = Infinity;
  const tick = () => { if (++calls > limit) throw new Error('Too many API requests by single Worker invocation'); };
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = { bind: (...values: unknown[]) => wrap(statement.bind(...values)), all: async () => { tick(); return statement.all(); } } as unknown as D1PreparedStatement;
    real.set(wrapped, statement); return wrapped;
  };
  const db = { prepare: (query: string) => wrap(binding.prepare(query)),
    batch: async (statements: D1PreparedStatement[]) => { tick(); return binding.batch(statements.map(s => real.get(s)!)); } } as unknown as D1Database;
  return { db, calls: () => calls, invocation(max: number) { calls = 0; limit = max; } };
}
