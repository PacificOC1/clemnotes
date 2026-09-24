import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Just enough of the Supabase client for the sync engine to run against an
 * in-memory "cloud" in tests: `from(table)` with select / eq / gt / lt / in,
 * upsert, and delete with a count. Rows are stored as the engine sends them.
 */
export type CloudTables = Record<string, Map<string, Record<string, unknown>>>;

type Filter = (row: Record<string, unknown>) => boolean;

class Query {
  private filters: Filter[] = [];
  private columns: string[] | null = null;
  private mode: 'select' | 'delete' = 'select';

  private readonly rows: Map<string, Record<string, unknown>>;

  constructor(rows: Map<string, Record<string, unknown>>) {
    this.rows = rows;
  }

  select(columns = '*') {
    this.columns = columns === '*' ? null : columns.split(',').map((c) => c.trim());
    return this;
  }
  delete() {
    this.mode = 'delete';
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  gt(column: string, value: number) {
    this.filters.push((row) => typeof row[column] === 'number' && (row[column] as number) > value);
    return this;
  }
  lt(column: string, value: number) {
    // Like SQL: a null never compares less than anything.
    this.filters.push((row) => typeof row[column] === 'number' && (row[column] as number) < value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  upsert(input: Record<string, unknown> | Record<string, unknown>[]) {
    for (const row of Array.isArray(input) ? input : [input]) {
      this.rows.set(String(row.id), { ...(this.rows.get(String(row.id)) ?? {}), ...structuredClone(row) });
    }
    return Promise.resolve({ error: null });
  }
  then<T>(resolve: (value: { data: unknown; error: null; count: number }) => T) {
    const matching = [...this.rows.values()].filter((row) => this.filters.every((f) => f(row)));
    if (this.mode === 'delete') {
      for (const row of matching) this.rows.delete(String(row.id));
      return Promise.resolve(resolve({ data: null, error: null, count: matching.length }));
    }
    const data = matching.map((row) =>
      this.columns ? Object.fromEntries(this.columns.map((c) => [c, row[c]])) : structuredClone(row)
    );
    return Promise.resolve(resolve({ data, error: null, count: data.length }));
  }
}

export function fakeSupabase(cloud: CloudTables = {}): { client: SupabaseClient; cloud: CloudTables } {
  const client = {
    from(table: string) {
      cloud[table] ??= new Map();
      return new Query(cloud[table]!);
    },
    storage: {
      from: () => ({ upload: async () => ({ error: null }) }),
    },
  };
  return { client: client as unknown as SupabaseClient, cloud };
}
