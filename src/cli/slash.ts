import type { OutputStyle } from "../output-styles.js";
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
}

export type SlashFollowup =
  | { kind: "compact" }
  | { kind: "skill"; skill: SkillEntry; args: string }
  | { kind: "list-skills" }
  | { kind: "yolo-toggle" };

export interface SlashResult {
  message: string;
  exit?: boolean;
  followup?: SlashFollowup;
}

const HELP = [
  "/provider <name>      switch provider",
  "/model <name>         switch model for the next turn",
  "/clear                reset the conversation history",
  "/compact              summarize the conversation and replace history with the summary",
  "/cost                 show token usage and cost for this session",
  "/usage [scope] [N]    cross-session usage ledger (scope: session | cwd | all; N = days to include, default 14)",
  "/tools                list registered tools",
  "/sessions             list recent sessions in this directory",
  "/yolo                 toggle YOLO mode (sandbox + archive-on-delete + checklist; needs checklist.txt or CHECKLIST.md in cwd)",
  "/skills               list loaded skills",
  "/<skill-name>         invoke a loaded skill (run /skills to see what's available)",
  "/output-style [name]  list output styles, or activate one (alias: /style; pass 'none' to clear)",
  "/resume               resume the most recent session (lands in Phase 4)",
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
      const carry = count > 0 ? ` (${count} prior message${count === 1 ? "" : "s"} carried over)` : "";
      return { message: `provider switched to ${arg}${carry}` };
    }
    case "model": {
      if (!arg) return { message: `current model: ${ctx.model}` };
      ctx.setModel(arg);
      const count = ctx.messageCount();
      const carry = count > 0 ? ` (${count} prior message${count === 1 ? "" : "s"} carried over)` : "";
      return { message: `model switched to ${arg}${carry}` };
    }
    case "clear":
      ctx.clear();
      return { message: "conversation cleared (session file unchanged; --resume still loads prior turns)" };
    case "compact": {
      const count = ctx.messageCount();
      if (count === 0) return { message: "nothing to compact (history is empty)" };
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
    case "resume":
      return {
        message: "/resume lands in Phase 4 (sessions). Stub for now.",
      };
    case "yolo": {
      if (!ctx.toggleYolo) {
        return { message: "/yolo not available in this REPL mode" };
      }
      return {
        message: ctx.yoloStatus ? ctx.yoloStatus() : "toggling YOLO...",
        followup: { kind: "yolo-toggle" },
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
          const here = active && active.toLowerCase() === s.name.toLowerCase()
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
    case "skills": {
      const skills = ctx.skills();
      const list = Array.from(skills.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      if (list.length === 0) {
        return {
          message:
            "no skills loaded (looked in ~/.codex/skills, ~/.claude/skills, and ./.squad/skills)",
          followup: { kind: "list-skills" },
        };
      }
      const lines = list.map((s) => {
        const desc =
          s.description.length > 100
            ? s.description.slice(0, 97) + "..."
            : s.description;
        const tag =
          s.source === "project"
            ? " (project)"
            : s.source === "codex"
              ? " (codex)"
              : "";
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
