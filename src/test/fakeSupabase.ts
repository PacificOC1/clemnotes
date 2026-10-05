import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Just enough of the Supabase client for the sync engine to run against an
 * in-memory "cloud" in tests: `from(table)` with select / eq / gt / lt / in /
 * order / limit, upsert, and delete with a count. Rows are stored as the
 * engine sends them.
 *
 * Like PostgREST on Supabase, a select never returns more than `maxRows`
 * rows (1000 by default), whatever the query asks for — the cap that once let
 * a big table come back only partly. Every upsert's size is recorded in
 * `upserts` so tests can check requests stay small.
 */
export type CloudTables = Record<string, Map<string, Record<string, unknown>>>;

type Filter = (row: Record<string, unknown>) => boolean;

export interface FakeOptions {
  /** PostgREST's `max-rows`: the most rows any one select returns. */
  maxRows?: number;
}

export interface FakeLog {
  /** Row count of every upsert request, by table, in order. */
  upserts: Array<{ table: string; rows: number }>;
  /** Every select request, by table. */
  selects: string[];
}

function compare(a: unknown, b: unknown): number {
  return a === b ? 0 : (a as string | number) < (b as string | number) ? -1 : 1;
}

class Query {
  private filters: Filter[] = [];
  private columns: string[] | null = null;
  private mode: 'select' | 'delete' = 'select';
  private orderBy: string | null = null;
  private max = Infinity;

  private readonly rows: Map<string, Record<string, unknown>>;
  private readonly table: string;
  private readonly options: Required<FakeOptions>;
  private readonly log: FakeLog;

  constructor(table: string, rows: Map<string, Record<string, unknown>>, options: Required<FakeOptions>, log: FakeLog) {
    this.table = table;
    this.rows = rows;
    this.options = options;
    this.log = log;
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
  gt(column: string, value: number | string) {
    this.filters.push((row) => typeof row[column] === typeof value && compare(row[column], value) > 0);
    return this;
  }
  order(column: string) {
    this.orderBy = column;
    return this;
  }
  limit(n: number) {
    this.max = n;
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
    this.log.upserts.push({ table: this.table, rows: Array.isArray(input) ? input.length : 1 });
    for (const row of Array.isArray(input) ? input : [input]) {
      this.rows.set(String(row.id), { ...(this.rows.get(String(row.id)) ?? {}), ...structuredClone(row) });
    }
    return Promise.resolve({ error: null });
  }
  then<T>(resolve: (value: { data: unknown; error: null; count: number }) => T) {
    let matching = [...this.rows.values()].filter((row) => this.filters.every((f) => f(row)));
    if (this.mode === 'delete') {
      for (const row of matching) this.rows.delete(String(row.id));
      return Promise.resolve(resolve({ data: null, error: null, count: matching.length }));
    }
    this.log.selects.push(this.table);
    const orderBy = this.orderBy;
    if (orderBy) matching.sort((a, b) => compare(a[orderBy], b[orderBy]));
    matching = matching.slice(0, Math.min(this.max, this.options.maxRows));
    const data = matching.map((row) =>
      this.columns ? Object.fromEntries(this.columns.map((c) => [c, row[c]])) : structuredClone(row)
    );
    return Promise.resolve(resolve({ data, error: null, count: data.length }));
  }
}

export function fakeSupabase(
  cloud: CloudTables = {},
  options: FakeOptions = {}
): { client: SupabaseClient; cloud: CloudTables; log: FakeLog } {
  const resolved: Required<FakeOptions> = { maxRows: options.maxRows ?? 1000 };
  const log: FakeLog = { upserts: [], selects: [] };
  const client = {
    from(table: string) {
      cloud[table] ??= new Map();
      return new Query(table, cloud[table]!, resolved, log);
    },
    storage: {
      from: () => ({ upload: async () => ({ error: null }) }),
    },
  };
  return { client: client as unknown as SupabaseClient, cloud, log };
}
