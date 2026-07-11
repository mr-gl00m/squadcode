import type Database from "better-sqlite3";

export interface UsageRecord {
  ts: string;
  sessionId: string;
  cwd: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  slashCommand?: string;
  source: "turn" | "compact";
}

export interface UsageFilter {
  sessionId?: string;
  cwd?: string;
  sinceIso?: string;
  provider?: string;
  model?: string;
}

export interface UsageTotals {
  rows: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  toolCalls: number;
  firstTs: string | null;
  lastTs: string | null;
}

export interface UsageGroupRow {
  key: string;
  rows: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

interface RawTotalsRow {
  rows: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  tool_calls: number | null;
  first_ts: string | null;
  last_ts: string | null;
}

interface RawGroupRow {
  key: string;
  rows: number;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export class UsageLedger {
  private readonly insertStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO usage_ledger
        (ts, session_id, cwd, provider, model,
         input_tokens, cached_input_tokens, output_tokens, total_tokens,
         cost_usd, tool_calls, slash_command, source)
      VALUES
        (@ts, @session_id, @cwd, @provider, @model,
         @input_tokens, @cached_input_tokens, @output_tokens, @total_tokens,
         @cost_usd, @tool_calls, @slash_command, @source)
    `);
  }

  record(rec: UsageRecord): void {
    this.insertStmt.run({
      ts: rec.ts,
      session_id: rec.sessionId,
      cwd: rec.cwd,
      provider: rec.provider,
      model: rec.model,
      input_tokens: rec.inputTokens,
      cached_input_tokens: rec.cachedInputTokens,
      output_tokens: rec.outputTokens,
      total_tokens: rec.totalTokens,
      cost_usd: rec.costUsd,
      tool_calls: rec.toolCalls,
      slash_command: rec.slashCommand ?? null,
      source: rec.source,
    });
  }

  totals(filter: UsageFilter = {}): UsageTotals {
    const { where, params } = buildWhere(filter);
    const sql = `
      SELECT
        COUNT(*) AS rows,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd,
        COALESCE(SUM(tool_calls), 0) AS tool_calls,
        MIN(ts) AS first_ts,
        MAX(ts) AS last_ts
      FROM usage_ledger
      ${where}
    `;
    const row = this.db.prepare(sql).get(params) as RawTotalsRow | undefined;
    if (!row) return emptyTotals();
    return {
      rows: row.rows ?? 0,
      inputTokens: row.input_tokens ?? 0,
      cachedInputTokens: row.cached_input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      totalTokens: row.total_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
      toolCalls: row.tool_calls ?? 0,
      firstTs: row.first_ts,
      lastTs: row.last_ts,
    };
  }

  groupByDay(filter: UsageFilter = {}, limit = 14): UsageGroupRow[] {
    const { where, params } = buildWhere(filter);
    const sql = `
      SELECT
        substr(ts, 1, 10) AS key,
        COUNT(*) AS rows,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM usage_ledger
      ${where}
      GROUP BY key
      ORDER BY key DESC
      LIMIT @row_limit
    `;
    return this.runGroup(sql, { ...params, row_limit: limit });
  }

  groupBySession(filter: UsageFilter = {}, limit = 10): UsageGroupRow[] {
    const { where, params } = buildWhere(filter);
    const sql = `
      SELECT
        session_id AS key,
        COUNT(*) AS rows,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM usage_ledger
      ${where}
      GROUP BY key
      ORDER BY MAX(ts) DESC
      LIMIT @row_limit
    `;
    return this.runGroup(sql, { ...params, row_limit: limit });
  }

  groupByModel(filter: UsageFilter = {}): UsageGroupRow[] {
    const { where, params } = buildWhere(filter);
    const sql = `
      SELECT
        provider || '/' || model AS key,
        COUNT(*) AS rows,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd), 0) AS cost_usd
      FROM usage_ledger
      ${where}
      GROUP BY key
      ORDER BY SUM(total_tokens) DESC
    `;
    return this.runGroup(sql, params);
  }

  private runGroup(
    sql: string,
    params: Record<string, unknown>,
  ): UsageGroupRow[] {
    const rows = this.db.prepare(sql).all(params) as RawGroupRow[];
    return rows.map((r) => ({
      key: r.key,
      rows: r.rows ?? 0,
      inputTokens: r.input_tokens ?? 0,
      cachedInputTokens: r.cached_input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      totalTokens: r.total_tokens ?? 0,
      costUsd: r.cost_usd ?? 0,
    }));
  }
}

function buildWhere(filter: UsageFilter): {
  where: string;
  params: Record<string, unknown>;
} {
  const conds: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.sessionId !== undefined) {
    conds.push("session_id = @session_id");
    params["session_id"] = filter.sessionId;
  }
  if (filter.cwd !== undefined) {
    conds.push("cwd = @cwd");
    params["cwd"] = filter.cwd;
  }
  if (filter.sinceIso !== undefined) {
    conds.push("ts >= @since_iso");
    params["since_iso"] = filter.sinceIso;
  }
  if (filter.provider !== undefined) {
    conds.push("provider = @provider");
    params["provider"] = filter.provider;
  }
  if (filter.model !== undefined) {
    conds.push("model = @model");
    params["model"] = filter.model;
  }
  return {
    where: conds.length === 0 ? "" : `WHERE ${conds.join(" AND ")}`,
    params,
  };
}

function emptyTotals(): UsageTotals {
  return {
    rows: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    firstTs: null,
    lastTs: null,
  };
}
