import type { HowlBus } from "../agents/howl.js";
import type { PermissionResponder } from "../agents/message-bus.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import type { JobRegistry } from "../engine/job-registry.js";
import type { DiagnosticsSetup } from "../engine/post-edit-diagnostics.js";
import type { TimerRegistry } from "../engine/timer-registry.js";
import type { PermissionGuardian } from "../guardian.js";
import type { HookRunner } from "../hooks/runner.js";
import type { NotificationConfig } from "../notifications.js";
import type { PolicyConfig } from "../permissions/policy.js";
import type { CanonicalMessage, LLMProvider } from "../providers/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { SessionMetadata } from "../sessions/types.js";
import type { SkillSource } from "../skills.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { TodoItem } from "../tools/todo.js";
import type { YoloSession } from "../yolo/index.js";
import { BANNER, bannerSubtitle } from "./banner.js";

const VERSION = "1.9.0";

export interface ReplControl {
  resumeSessionId?: string;
}

export interface ReplOptions {
  provider: LLMProvider;
  providerName: string;
  model: string;
  registry: ToolRegistry;
  policy: PolicyConfig;
  cwd: string;
  systemPrompt: string;
  baseSystemPrompt: string;
  buildProvider: (name: string) => LLMProvider | string;
  store: SessionStore;
  sessionId: string;
  metadata: SessionMetadata;
  messages: CanonicalMessage[];
  resumed: boolean;
  allowProjectPersist: boolean;
  hookRunner: HookRunner;
  yolo: YoloSession | null;
  allowDeletes: boolean;
  recapIdleMinutes: number;
  notifications: NotificationConfig;
  fileMentions?: string[];
  guardian?: PermissionGuardian;
  jobs?: JobRegistry;
  timers?: TimerRegistry;
  diagnostics?: DiagnosticsSetup;
  howl?: HowlBus;
  slotRegistry?: AgentRegistry;
  controllers?: Map<AgentId, AbortController>;
  setAgentResponder?: (responder: PermissionResponder) => void;
  control?: ReplControl;
}

export interface HistoryEntry {
  id: number;
  kind: "user" | "assistant" | "system" | "tool" | "error" | "header" | "skill";
  text: string;
  subtitle?: string;
  skillName?: string;
  skillSource?: SkillSource;
}

export type ActivityState =
  | { kind: "idle"; label: "" }
  | { kind: "thinking" | "responding"; label: string }
  | { kind: "tool"; label: string; toolName: string };

export function buildInitialHistory(opts: ReplOptions): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    {
      id: 0,
      kind: "header",
      text: BANNER,
      subtitle: bannerSubtitle(VERSION, opts.providerName, opts.model),
    },
  ];
  if (opts.resumed) {
    entries.push({
      id: 1,
      kind: "system",
      text: `resumed session ${opts.sessionId.slice(0, 8)} with ${opts.messages.length} prior messages`,
    });
  }
  return entries;
}

export function snapshotTodos(items: TodoItem[]): TodoItem[] {
  return items.map((item) => ({ ...item }));
}
