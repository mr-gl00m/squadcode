import { openSessionStore } from "../sessions/store.js";
import { sanitizeForTerminal } from "../terminal.js";
import { formatUsageReport } from "./usage-format.js";

export interface UsageCliInput {
  cwd?: string;
  allCwds?: boolean;
  sessionId?: string;
  daysBack?: number;
  provider?: string;
  model?: string;
}

export async function runUsageCli(input: UsageCliInput): Promise<void> {
  const store = openSessionStore();
  try {
    const filter: {
      sessionId?: string;
      cwd?: string;
      sinceIso?: string;
      provider?: string;
      model?: string;
    } = {};
    let scopeLabel: string;
    if (input.sessionId) {
      filter.sessionId = input.sessionId;
      scopeLabel = `session ${input.sessionId.slice(0, 8)}`;
    } else if (input.allCwds) {
      scopeLabel = "all sessions";
    } else {
      filter.cwd = input.cwd ?? process.cwd();
      scopeLabel = `cwd ${filter.cwd}`;
    }
    if (input.provider) {
      filter.provider = input.provider;
      scopeLabel += `, provider ${input.provider}`;
    }
    if (input.model) {
      filter.model = input.model;
      scopeLabel += `, model ${input.model}`;
    }
    if (input.daysBack !== undefined) {
      const since = new Date(Date.now() - input.daysBack * 86_400_000);
      filter.sinceIso = since.toISOString();
      scopeLabel += `, last ${input.daysBack} day${input.daysBack === 1 ? "" : "s"}`;
    }
    const totals = store.usageTotals(filter);
    const byDay = store.usageByDay(filter, input.daysBack ?? 14);
    const byModel = store.usageByModel(filter);
    const bySession = store.usageBySession(filter, 10);
    const out = formatUsageReport(
      { totals, byDay, byModel, bySession },
      {
        scopeLabel,
        ...(input.daysBack !== undefined && { daysBack: input.daysBack }),
      },
    );
    process.stdout.write(`${sanitizeForTerminal(out)}\n`);
  } finally {
    await store.shutdown();
  }
}
