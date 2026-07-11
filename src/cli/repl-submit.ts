import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { SteeringQueue } from "../engine/steering-queue.js";
import { formatSkillForLLM, type SkillEntry } from "../skills.js";
import { expandFileMentions } from "./file-mentions.js";
import {
  type ComposerState,
  expandPastes,
  isLiteralSlashCommand,
  type PasteEntry,
} from "./repl-composer.js";
import type { HistoryEntry, ReplControl } from "./repl-types.js";
import {
  handleSlash,
  type SlashContext,
  slashAvailableDuringTurn,
} from "./slash.js";

export interface SubmitHandlerOptions {
  append: (kind: HistoryEntry["kind"], text: string) => void;
  bumpIdle: () => void;
  controlRef: MutableRefObject<ReplControl | undefined>;
  draftRef: MutableRefObject<string>;
  exit: () => void;
  historyPosRef: MutableRefObject<number | null>;
  idRef: MutableRefObject<number>;
  inputHistoryRef: MutableRefObject<string[]>;
  recordHistory?: (entry: string) => Promise<void>;
  cwd?: string;
  fileMentions?: readonly string[];
  isStreaming: boolean;
  pastesRef: MutableRefObject<Map<number, PasteEntry>>;
  runCompact: () => Promise<void>;
  runUserTurn: (content: string, displayLabel: string) => Promise<void>;
  setComposer: Dispatch<SetStateAction<ComposerState>>;
  setHistory: Dispatch<SetStateAction<HistoryEntry[]>>;
  skillsRef: MutableRefObject<Map<string, SkillEntry>>;
  slashContext: SlashContext;
  steeringQueue: SteeringQueue;
}

export function createSubmitHandler(
  opts: SubmitHandlerOptions,
): (rawValue: string) => Promise<void> {
  return async (rawValue: string): Promise<void> => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    opts.bumpIdle();

    if (isLiteralSlashCommand(trimmed)) {
      opts.setComposer({ value: "", cursor: 0 });
      opts.pastesRef.current.clear();
      opts.inputHistoryRef.current.push(trimmed);
      void opts.recordHistory?.(trimmed);
      opts.historyPosRef.current = null;
      opts.draftRef.current = "";
      if (opts.isStreaming && !slashAvailableDuringTurn(trimmed)) {
        const command = trimmed.split(/\s+/, 1)[0] ?? trimmed;
        opts.append(
          "system",
          `${command} is unavailable during an active turn`,
        );
        return;
      }
      const result = handleSlash(trimmed, opts.slashContext);

      if (result.followup?.kind === "list-skills") {
        const list = Array.from(opts.skillsRef.current.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        if (list.length === 0) {
          opts.append(
            "system",
            "no skills loaded (configure SQUAD_USER_SKILL_DIRS in .env or add skills under ./.squad/skills)",
          );
        } else {
          opts.setHistory((previous) => [
            ...previous,
            {
              id: opts.idRef.current++,
              kind: "system",
              text: `${list.length} skill${list.length === 1 ? "" : "s"}:`,
            },
            ...list.map((skill) => ({
              id: opts.idRef.current++,
              kind: "skill" as const,
              text:
                skill.description.length > 100
                  ? `${skill.description.slice(0, 97)}...`
                  : skill.description,
              skillName: skill.name,
              skillSource: skill.source,
            })),
          ]);
        }
        return;
      }

      opts.append("system", result.message);
      if (result.followup?.kind === "compact") {
        await opts.runCompact();
        return;
      }
      if (result.followup?.kind === "skill") {
        const { skill, args } = result.followup;
        const llm = formatSkillForLLM(skill, args);
        const display = `(invoked /${skill.name}${args ? ` ${args}` : ""})`;
        await opts.runUserTurn(llm, display);
        return;
      }
      if (
        result.followup?.kind === "yolo-toggle" &&
        opts.slashContext.toggleYolo
      ) {
        const message = await opts.slashContext.toggleYolo();
        opts.append("system", message);
        return;
      }
      if (result.followup?.kind === "resume") {
        if (opts.controlRef.current) {
          opts.controlRef.current.resumeSessionId = result.followup.sessionId;
          setTimeout(() => opts.exit(), 0);
        } else {
          opts.append("system", "/resume is unavailable in this REPL host");
        }
        return;
      }
      if (result.exit) setTimeout(() => opts.exit(), 0);
      return;
    }

    const pasted = expandPastes(trimmed, opts.pastesRef.current);
    const value = await expandFileMentions(
      pasted,
      opts.cwd ?? process.cwd(),
      opts.fileMentions ?? [],
    );
    opts.pastesRef.current.clear();
    opts.setComposer({ value: "", cursor: 0 });
    opts.inputHistoryRef.current.push(trimmed);
    void opts.recordHistory?.(trimmed);
    opts.historyPosRef.current = null;
    opts.draftRef.current = "";
    if (opts.isStreaming) {
      const position = opts.steeringQueue.enqueue(value);
      opts.append("user", value);
      opts.append(
        "system",
        `queued steering message ${position} for the next model boundary`,
      );
      return;
    }
    await opts.runUserTurn(value, value);
  };
}
