import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { guardianYoloAdvice, type PermissionGuardian } from "../guardian.js";
import type { OutputStyle } from "../output-styles.js";
import { applyModeAddendums, type Mode } from "../permissions/plan.js";
import type { PolicyConfig, RuleMap } from "../permissions/policy.js";
import { formatCost, lookupPricing } from "../pricing.js";
import type { CanonicalMessage, LLMProvider } from "../providers/types.js";
import { formatRecapFromMessages } from "../sessions/recap.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import type { SkillEntry } from "../skills.js";
import type { ToolRegistry } from "../tools/registry.js";
import { checklistMissingMessage, findChecklist } from "../yolo/checklist.js";
import {
  createYoloSession,
  type YoloSession,
  yoloSystemPromptAddendum,
} from "../yolo/index.js";
import { parseUsageArgs } from "./repl-composer.js";
import { formatReplay, parseReplayLimit } from "./replay.js";
import { pickResumeTarget } from "./resume-target.js";
import { persistDefaultSelection } from "./runtime-resolution.js";
import type { SlashContext } from "./slash.js";
import { formatUsageReport } from "./usage-format.js";

export interface ReplSlashContextOptions {
  activeStyle: OutputStyle | null;
  basePolicyRef: MutableRefObject<PolicyConfig>;
  baseSystemPrompt: string;
  buildProvider: (name: string) => LLMProvider | string;
  clearConversation: () => void;
  cwd: string;
  metadata: SessionMetadata;
  messagesRef: MutableRefObject<CanonicalMessage[]>;
  model: string;
  outputStylesRef: MutableRefObject<Map<string, OutputStyle>>;
  policyRef: MutableRefObject<PolicyConfig>;
  providerName: string;
  providerRef: MutableRefObject<LLMProvider>;
  registry: ToolRegistry;
  sessionId: string;
  sessionRulesRef: MutableRefObject<RuleMap>;
  setActiveStyle: Dispatch<SetStateAction<OutputStyle | null>>;
  setMode: Dispatch<SetStateAction<Mode>>;
  setModel: Dispatch<SetStateAction<string>>;
  setProviderName: Dispatch<SetStateAction<string>>;
  setYoloOn: Dispatch<SetStateAction<boolean>>;
  skillsRef: MutableRefObject<Map<string, SkillEntry>>;
  store: SessionStore;
  systemPromptRef: MutableRefObject<string>;
  totalCachedTokens: number;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  lastTurnCachedTokens: number;
  lastTurnCost: number;
  lastTurnInputTokens: number;
  lastTurnOutputTokens: number;
  lastTurnTokens: number;
  turnCount: number;
  turnDiff: () => string;
  yoloRef: MutableRefObject<YoloSession | null>;
  guardian?: PermissionGuardian;
}

export function createReplSlashContext(
  opts: ReplSlashContextOptions,
): SlashContext {
  return {
    get providerName() {
      return opts.providerName;
    },
    get model() {
      return opts.model;
    },
    setProvider: (name: string) => {
      const next = opts.buildProvider(name);
      if (typeof next === "string") return next;
      opts.providerRef.current = next;
      opts.setProviderName(name);
      persistDefaultSelection(name, opts.model);
      return null;
    },
    setModel: (name: string) => {
      opts.setModel(name);
      persistDefaultSelection(opts.providerName, name);
    },
    messageCount: () => opts.messagesRef.current.length,
    skills: () => opts.skillsRef.current,
    outputStyles: () => opts.outputStylesRef.current,
    activeStyleName: () => opts.activeStyle?.name ?? null,
    setStyle: (name: string) => {
      const next = opts.outputStylesRef.current.get(name.toLowerCase());
      if (!next) {
        return `unknown output style "${name}"; run /output-style to list available`;
      }
      opts.setActiveStyle(next);
      return null;
    },
    clearStyle: () => opts.setActiveStyle(null),
    usageReport: (arg: string) => usageReport(opts, arg),
    costSummary: () => costSummary(opts),
    toolList: () => {
      const tools = opts.registry.list();
      const lines = tools.map((tool) => {
        const tag = tool.isReadOnly ? "ro" : "rw";
        const description =
          tool.description.length > 80
            ? `${tool.description.slice(0, 77)}...`
            : tool.description;
        return `  ${tool.name.padEnd(12)} [${tag}, ${tool.defaultPermission}] — ${description}`;
      });
      return `${tools.length} tool${tools.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
    },
    sessionList: () => {
      const recent = opts.store.list({ cwd: opts.cwd, limit: 10 });
      if (recent.length === 0) return `no sessions yet for ${opts.cwd}`;
      const lines = recent.map((session) => {
        const id = session.sessionId.slice(0, 8);
        const when = session.updatedAt.replace("T", " ").slice(0, 19);
        const here = session.sessionId === opts.sessionId ? " (current)" : "";
        return `  ${id}  ${when}  ${session.provider}/${session.model}  ${session.turnCount} turn${session.turnCount === 1 ? "" : "s"}${here}`;
      });
      return `recent sessions in ${opts.cwd}:\n${lines.join("\n")}`;
    },
    resolveResume: (arg) =>
      pickResumeTarget(opts.store.list({ cwd: opts.cwd }), opts.sessionId, arg),
    replay: (arg) =>
      formatReplay(
        opts.messagesRef.current,
        opts.sessionId.slice(0, 8),
        parseReplayLimit(arg),
      ),
    diff: opts.turnDiff,
    clear: opts.clearConversation,
    recap: () => {
      const usage = opts.store.usageTotals({ sessionId: opts.sessionId });
      return formatRecapFromMessages({
        metadata: {
          ...opts.metadata,
          turnCount: opts.turnCount,
          totalTokens: opts.totalTokens,
          provider: opts.providerName,
          model: opts.model,
        },
        messages: opts.messagesRef.current,
        usage,
      });
    },
    yoloStatus: () => {
      const yolo = opts.yoloRef.current;
      if (yolo) {
        return `YOLO is ON. PathGuard=${opts.cwd}. Archive=${yolo.archiveDir}. Checklist=${yolo.checklistPath ?? "(none)"}.`;
      }
      return "YOLO is OFF.";
    },
    toggleYolo: () => toggleYolo(opts),
    getMode: () => opts.policyRef.current.mode,
    setMode: (next: Mode) => {
      opts.policyRef.current.mode = next;
      const yolo = opts.yoloRef.current;
      const yoloAddendum = yolo
        ? `${yoloSystemPromptAddendum(yolo)}${
            yolo.checklistPath
              ? `\n\n## Loaded checklist (${yolo.checklistPath})`
              : ""
          }`
        : null;
      opts.systemPromptRef.current = applyModeAddendums(opts.baseSystemPrompt, {
        yolo: yoloAddendum,
        plan: next === "plan",
      });
      opts.setMode(next);
      return next === "plan"
        ? "mode → plan. Edit/Write/ApplyPatch will be denied; Shell will ask. /mode act to resume."
        : "mode → act. Default permissions restored.";
    },
  };
}

function usageReport(opts: ReplSlashContextOptions, arg: string): string {
  const parsed = parseUsageArgs(arg);
  const filter: { sessionId?: string; cwd?: string; sinceIso?: string } = {};
  let scopeLabel: string;
  if (parsed.scope === "session") {
    filter.sessionId = opts.sessionId;
    scopeLabel = `current session (${opts.sessionId.slice(0, 8)})`;
  } else if (parsed.scope === "all") {
    scopeLabel = "all sessions";
  } else {
    filter.cwd = opts.cwd;
    scopeLabel = `cwd ${opts.cwd}`;
  }
  if (parsed.daysBack !== undefined) {
    const since = new Date(Date.now() - parsed.daysBack * 86_400_000);
    filter.sinceIso = since.toISOString();
    scopeLabel += `, last ${parsed.daysBack} day${parsed.daysBack === 1 ? "" : "s"}`;
  }
  const sessionTotals =
    parsed.scope === "session"
      ? undefined
      : opts.store.usageTotals({ sessionId: opts.sessionId });
  return formatUsageReport(
    {
      totals: opts.store.usageTotals(filter),
      byDay: opts.store.usageByDay(filter, parsed.daysBack ?? 14),
      byModel: opts.store.usageByModel(filter),
      bySession: opts.store.usageBySession(filter, 10),
    },
    {
      scopeLabel,
      ...(parsed.daysBack !== undefined && { daysBack: parsed.daysBack }),
      ...(sessionTotals !== undefined && { thisSessionTotals: sessionTotals }),
    },
  );
}

function costSummary(opts: ReplSlashContextOptions): string {
  const pricing = lookupPricing(opts.providerName, opts.model);
  const totalMissTokens = Math.max(
    0,
    opts.totalInputTokens - opts.totalCachedTokens,
  );
  const lastMissTokens = Math.max(
    0,
    opts.lastTurnInputTokens - opts.lastTurnCachedTokens,
  );
  const totalHitPct =
    opts.totalInputTokens > 0
      ? Math.round((opts.totalCachedTokens / opts.totalInputTokens) * 100)
      : 0;
  const lastHitPct =
    opts.lastTurnInputTokens > 0
      ? Math.round((opts.lastTurnCachedTokens / opts.lastTurnInputTokens) * 100)
      : 0;
  const lines = [
    `provider/model:  ${opts.providerName}/${opts.model}`,
    `turns:           ${opts.turnCount}`,
    `input (total):   ${opts.totalInputTokens.toLocaleString()}  (hit ${opts.totalCachedTokens.toLocaleString()} / miss ${totalMissTokens.toLocaleString()}, ${totalHitPct}% cached)`,
    `output (total):  ${opts.totalOutputTokens.toLocaleString()}`,
    `input (last):    ${opts.lastTurnInputTokens.toLocaleString()}  (hit ${opts.lastTurnCachedTokens.toLocaleString()} / miss ${lastMissTokens.toLocaleString()}, ${lastHitPct}% cached)`,
    `output (last):   ${opts.lastTurnOutputTokens.toLocaleString()}`,
    `tokens (total):  ${opts.totalTokens.toLocaleString()}`,
    `tokens (last):   ${opts.lastTurnTokens.toLocaleString()}`,
  ];
  if (pricing) {
    lines.push(`cost (total):    ${formatCost(opts.totalCost)}`);
    lines.push(`cost (last):     ${formatCost(opts.lastTurnCost)}`);
  } else {
    lines.push(
      `cost:            (no pricing for ${opts.providerName}/${opts.model})`,
    );
  }
  return lines.join("\n");
}

async function toggleYolo(opts: ReplSlashContextOptions): Promise<string> {
  if (opts.yoloRef.current) {
    const planActive = opts.policyRef.current.mode === "plan";
    opts.yoloRef.current = null;
    opts.systemPromptRef.current = applyModeAddendums(opts.baseSystemPrompt, {
      plan: planActive,
    });
    opts.policyRef.current = {
      ...opts.basePolicyRef.current,
      mode: opts.policyRef.current.mode,
    };
    opts.setYoloOn(false);
    return "YOLO disarmed. Permission prompts are back on.";
  }
  const checklist = await findChecklist(opts.cwd);
  if (!checklist) return checklistMissingMessage();
  const guardianAdvice = await guardianYoloAdvice(
    opts.guardian,
    opts.cwd,
    checklist.path,
  );
  const next = createYoloSession({
    cwd: opts.cwd,
    checklistPath: checklist.path,
  });
  const addendum = `${yoloSystemPromptAddendum(next)}\n\n## Loaded checklist (${checklist.path})\n${checklist.contents}`;
  opts.yoloRef.current = next;
  opts.systemPromptRef.current = applyModeAddendums(opts.baseSystemPrompt, {
    yolo: addendum,
    plan: opts.policyRef.current.mode === "plan",
  });
  opts.policyRef.current = {
    ...opts.basePolicyRef.current,
    dangerouslySkipPermissions: true,
    mode: opts.policyRef.current.mode,
  };
  opts.setYoloOn(true);
  const armed = `YOLO armed. PathGuard=${opts.cwd}. Archive=${next.archiveDir}. Checklist=${checklist.path}.`;
  return guardianAdvice ? `[advisory] ${guardianAdvice}\n${armed}` : armed;
}
