import type { OutputStyle } from "../output-styles.js";
import type { Mode } from "../permissions/plan.js";
import type { SkillEntry } from "../skills.js";

export interface SlashContext {
  providerName: string;
  model: string;
  setProvider: (name: string) => string | null;
  setModel: (name: string) => void;
  clear: () => void;
  messageCount: () => number;
  skills: () => Map<string, SkillEntry>;
  outputStyles: () => Map<string, OutputStyle>;
  activeStyleName: () => string | null;
  setStyle: (name: string) => string | null;
  clearStyle: () => void;
  costSummary: () => string;
  usageReport: (arg: string) => string;
  toolList: () => string;
  sessionList: () => string;
  yoloStatus?: () => string;
  toggleYolo?: () => Promise<string>;
  notificationSoundEnabled?: () => boolean;
  setNotificationSound?: (enabled: boolean) => void;
  getMode?: () => Mode;
  setMode?: (mode: Mode) => string;
  recap?: () => string;
  // Resolves a /resume argument (session id, id prefix, or "" = most recent
  // other session in this dir) to a concrete target, or an error string. The
  // host actually loads + swaps the session when it sees the resume followup.
  resolveResume?: (arg: string) => ResumeTarget;
  // Renders the last N turns of the current session as a compact preroll.
  replay?: (arg: string) => string;
  diff?: () => string;
}

export type SlashFollowup =
  | { kind: "compact" }
  | { kind: "skill"; skill: SkillEntry; args: string }
  | { kind: "list-skills" }
  | { kind: "yolo-toggle" }
  | { kind: "mode-change"; mode: Mode }
  | { kind: "resume"; sessionId: string };

export type ResumeTarget =
  | { sessionId: string; turnCount: number }
  | { error: string };

export interface SlashResult {
  message: string;
  exit?: boolean;
  followup?: SlashFollowup;
}

export interface SlashCommandEntry {
  name: string;
  aliases?: string[];
  availableDuringTurn: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommandEntry[] = [
  { name: "help", availableDuringTurn: true },
  { name: "cost", availableDuringTurn: true },
  { name: "usage", availableDuringTurn: true },
  { name: "tools", availableDuringTurn: true },
  { name: "sessions", availableDuringTurn: true },
  { name: "replay", availableDuringTurn: true },
  { name: "diff", availableDuringTurn: true },
  { name: "receipt", availableDuringTurn: true },
  { name: "skills", aliases: ["list-skills"], availableDuringTurn: true },
  { name: "clear", availableDuringTurn: false },
  { name: "compact", availableDuringTurn: false },
  { name: "provider", availableDuringTurn: false },
  { name: "model", availableDuringTurn: false },
  {
    name: "sound",
    aliases: ["notification-sound"],
    availableDuringTurn: true,
  },
  { name: "yolo", availableDuringTurn: false },
  { name: "mode", availableDuringTurn: false },
  { name: "output-style", aliases: ["style"], availableDuringTurn: false },
  { name: "resume", availableDuringTurn: false },
  { name: "shootout", availableDuringTurn: false },
  { name: "exit", aliases: ["quit"], availableDuringTurn: false },
];

export function slashAvailableDuringTurn(line: string): boolean {
  const command = line.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (!command) return false;
  const entry = SLASH_COMMANDS.find(
    (candidate) =>
      candidate.name === command || candidate.aliases?.includes(command),
  );
  return entry?.availableDuringTurn ?? false;
}

const HELP = [
  "/provider <name>      switch provider",
  "/model <name>         switch model for the next turn",
  "/sound [on|off]       toggle the permission-request sound (alias: /notification-sound)",
  "/clear                reset the conversation history (prints a recap first)",
  "/receipt              print a markdown recap of this session (goal, files, shell, tokens, next action)",
  "/compact              summarize the conversation and replace history with the summary",
  "/cost                 show token usage and cost for this session",
  "/usage [scope] [N]    cross-session usage ledger (scope: session | cwd | all; N = days to include, default 14)",
  "/tools                list registered tools",
  "/sessions             list recent sessions in this directory",
  "/replay [n]           replay the last n turns of this session (default 5)",
  "/diff                 show the net file diff for the latest turn",
  "/yolo                 toggle YOLO mode (cwd path guard + archive-on-delete + checklist; not OS isolation; needs a checklist in cwd)",
  "/mode [plan|act]      show or switch permission mode. plan: read/grep/glob allowed, edit/write denied, shell asks. act: default.",
  "/skills, /list-skills list loaded skills",
  "/<skill-name>         invoke a loaded skill (run /skills to see what's available)",
  "/output-style [name]  list output styles, or activate one (alias: /style; pass 'none' to clear)",
  "/resume [id]          resume & continue a session in this dir (most recent other one, or one matching <id>)",
  "/shootout <models>    vet a prompt across models — run `squad shootout <prompt> --models <a,b,c>`",
  "/help                 this list",
  "/exit, /quit          exit the REPL",
].join("\n");

export function handleSlash(line: string, ctx: SlashContext): SlashResult {
  const parts = line.slice(1).trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "help":
      return { message: HELP };
    case "provider": {
      if (!arg) return { message: `current provider: ${ctx.providerName}` };
      const err = ctx.setProvider(arg);
      if (err) return { message: `provider switch failed: ${err}` };
      const count = ctx.messageCount();
      const carry =
        count > 0
          ? ` (${count} prior message${count === 1 ? "" : "s"} carried over)`
          : "";
      return { message: `provider switched to ${arg}${carry}` };
    }
    case "model": {
      if (!arg) return { message: `current model: ${ctx.model}` };
      ctx.setModel(arg);
      const count = ctx.messageCount();
      const carry =
        count > 0
          ? ` (${count} prior message${count === 1 ? "" : "s"} carried over)`
          : "";
      return { message: `model switched to ${arg}${carry}` };
    }
    case "sound":
    case "notification-sound": {
      if (!ctx.notificationSoundEnabled || !ctx.setNotificationSound) {
        return { message: "/sound not available in this REPL mode" };
      }
      const normalized = arg.toLowerCase();
      if (normalized && normalized !== "on" && normalized !== "off") {
        return { message: `unknown sound state "${arg}"; use on or off` };
      }
      const enabled = normalized
        ? normalized === "on"
        : !ctx.notificationSoundEnabled();
      ctx.setNotificationSound(enabled);
      return {
        message: `permission notification sound ${enabled ? "ON" : "OFF"} (saved globally)`,
      };
    }
    case "clear": {
      // Recap before clear so the user always has a record of what was
      // happening before context vanishes. Falls back gracefully when the
      // host REPL doesn't provide a recap callback.
      const recap = ctx.recap?.();
      ctx.clear();
      const cleared =
        "conversation cleared (session file unchanged; --resume still loads prior turns)";
      return {
        message: recap ? `${recap}\n\n${cleared}` : cleared,
      };
    }
    case "receipt": {
      if (!ctx.recap) {
        return { message: "/receipt not available in this REPL mode" };
      }
      return { message: ctx.recap() };
    }
    case "compact": {
      const count = ctx.messageCount();
      if (count === 0)
        return { message: "nothing to compact (history is empty)" };
      return {
        message: `compacting ${count} message${count === 1 ? "" : "s"}...`,
        followup: { kind: "compact" },
      };
    }
    case "cost":
      return { message: ctx.costSummary() };
    case "usage":
      return { message: ctx.usageReport(arg) };
    case "tools":
      return { message: ctx.toolList() };
    case "sessions":
      return { message: ctx.sessionList() };
    case "replay": {
      if (!ctx.replay) {
        return { message: "/replay not available in this REPL mode" };
      }
      return { message: ctx.replay(arg) };
    }
    case "diff":
      return {
        message: ctx.diff?.() ?? "/diff not available in this REPL mode",
      };
    case "resume": {
      if (!ctx.resolveResume) {
        return { message: "/resume not available in this REPL mode" };
      }
      const res = ctx.resolveResume(arg);
      if ("error" in res) return { message: res.error };
      return {
        message: `resuming session ${res.sessionId.slice(0, 8)} (${res.turnCount} prior turn${res.turnCount === 1 ? "" : "s"})...`,
        followup: { kind: "resume", sessionId: res.sessionId },
      };
    }
    case "yolo": {
      if (!ctx.toggleYolo) {
        return { message: "/yolo not available in this REPL mode" };
      }
      return {
        message: ctx.yoloStatus ? ctx.yoloStatus() : "toggling YOLO...",
        followup: { kind: "yolo-toggle" },
      };
    }
    case "mode": {
      if (!ctx.getMode || !ctx.setMode) {
        return { message: "/mode not available in this REPL mode" };
      }
      if (!arg) return { message: `current mode: ${ctx.getMode()}` };
      const next = arg.toLowerCase();
      if (next !== "plan" && next !== "act") {
        return {
          message: `unknown mode "${arg}" — use /mode plan or /mode act`,
        };
      }
      const msg = ctx.setMode(next);
      return {
        message: msg,
        followup: { kind: "mode-change", mode: next },
      };
    }
    case "shootout": {
      // A shootout fans the same prompt across N model backends concurrently,
      // each in its own loop + worktree. That's a batch run, not a turn in this
      // conversation, so it lives in the dedicated subcommand rather than
      // blocking the live REPL. Point the user at it.
      const models = arg || "<a,b,c>";
      return {
        message:
          "shootout runs as its own command, not in this session:\n" +
          `  squad shootout "<prompt>" --models ${models}\n` +
          "  squad shootout report <run-id>   # re-render a past run\n" +
          '(or one-shot: squad -p "<prompt>" --shootout <a,b,c>)',
      };
    }
    case "exit":
    case "quit":
      return { message: "bye", exit: true };
    case "":
      return { message: HELP };
    case "output-style":
    case "style": {
      const styles = ctx.outputStyles();
      if (!arg) {
        const active = ctx.activeStyleName();
        const list = Array.from(styles.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        if (list.length === 0) {
          return {
            message:
              "no output styles loaded (looked in ~/.squad/output-styles and ./.squad/output-styles)",
          };
        }
        const lines = list.map((s) => {
          const desc =
            s.description.length > 100
              ? s.description.slice(0, 97) + "..."
              : s.description;
          const tag = s.source === "project" ? " (project)" : "";
          const here =
            active && active.toLowerCase() === s.name.toLowerCase()
              ? " (active)"
              : "";
          return `  ${s.name}${tag}${here} — ${desc}`;
        });
        const header = active
          ? `active: ${active}\n${list.length} style${list.length === 1 ? "" : "s"}:`
          : `no active style\n${list.length} style${list.length === 1 ? "" : "s"}:`;
        return { message: `${header}\n${lines.join("\n")}` };
      }
      if (arg.toLowerCase() === "none" || arg.toLowerCase() === "off") {
        ctx.clearStyle();
        return { message: "output style cleared" };
      }
      const err = ctx.setStyle(arg);
      if (err) return { message: `output style switch failed: ${err}` };
      return { message: `output style switched to ${arg}` };
    }
    case "list-skills":
    case "skills": {
      const skills = ctx.skills();
      const list = Array.from(skills.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (list.length === 0) {
        return {
          message:
            "no skills loaded (configure SQUAD_USER_SKILL_DIRS in .env or add skills under ./.squad/skills)",
          followup: { kind: "list-skills" },
        };
      }
      const lines = list.map((s) => {
        const desc =
          s.description.length > 100
            ? s.description.slice(0, 97) + "..."
            : s.description;
        const tag = s.source === "project" ? " (project)" : "";
        return `  /${s.name}${tag} — ${desc}`;
      });
      return {
        message: `${list.length} skill${list.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
        followup: { kind: "list-skills" },
      };
    }
    default: {
      const skills = ctx.skills();
      const skill = skills.get(cmd);
      if (skill) {
        return {
          message: `running skill /${skill.name}${arg ? ` ${arg}` : ""}`,
          followup: { kind: "skill", skill, args: arg },
        };
      }
      return { message: `unknown command /${cmd} — try /help` };
    }
  }
}
