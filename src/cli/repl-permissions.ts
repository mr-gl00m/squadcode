import { useInput } from "ink";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { killAllAgents } from "../agents/kill.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { AgentId } from "../agents/types.js";
import type { PromptOutcome, PromptRequest } from "../permissions/prompt.js";
import type { ActivityState, HistoryEntry } from "./repl-types.js";

export interface PendingPermission {
  req: PromptRequest;
  resolve: (outcome: PromptOutcome) => void;
}

export function usePermissionInput(opts: {
  abortRef: MutableRefObject<AbortController | null>;
  allowProjectPersist: boolean;
  append: (kind: HistoryEntry["kind"], text: string) => void;
  controllers?: Map<AgentId, AbortController>;
  exit: () => void;
  isStreaming: boolean;
  pendingPermission: PendingPermission | null;
  setActivity: Dispatch<SetStateAction<ActivityState>>;
  setPendingPermission: Dispatch<SetStateAction<PendingPermission | null>>;
  slotRegistry?: AgentRegistry;
}): void {
  useInput((inputChar, key) => {
    const pending = opts.pendingPermission;
    if (key.ctrl && inputChar === "c") {
      if (pending) {
        pending.resolve("deny");
        opts.setPendingPermission(null);
        opts.setActivity({ kind: "thinking", label: "Resuming" });
        opts.append("system", "permission denied (Ctrl-C)");
        return;
      }
      if (opts.isStreaming && opts.abortRef.current) {
        opts.abortRef.current.abort();
        if (opts.slotRegistry && opts.controllers) {
          const killed = killAllAgents(opts.slotRegistry, opts.controllers);
          if (killed.length > 0) {
            opts.append(
              "system",
              `cascaded abort to ${killed.length} subagent(s)`,
            );
          }
        }
        opts.append("system", "aborted by Ctrl-C");
      } else {
        opts.exit();
      }
      return;
    }

    if (!pending) return;
    const character = inputChar.toLowerCase();
    if (character === "y" || character === "1") {
      resolvePermission(opts, pending, "allow", "allowed");
    } else if (character === "a" || character === "2") {
      resolvePermission(
        opts,
        pending,
        "always-allow",
        "always-allowed for this session",
      );
    } else if (character === "p" && opts.allowProjectPersist) {
      resolvePermission(
        opts,
        pending,
        "always-project",
        "always-allowed for this project (saved to .squad/settings.json)",
      );
    } else if (character === "u") {
      resolvePermission(
        opts,
        pending,
        "always-user",
        "always-allowed user-wide (saved to ~/.squad/permissions.json)",
      );
    } else if (
      character === "n" ||
      character === "3" ||
      key.escape ||
      key.return
    ) {
      pending.resolve("deny");
      opts.setPendingPermission(null);
      opts.setActivity({ kind: "thinking", label: "Resuming" });
      opts.append("system", `[${pending.req.toolName}] denied`);
    }
  });
}

function resolvePermission(
  opts: Parameters<typeof usePermissionInput>[0],
  pending: PendingPermission,
  outcome: PromptOutcome,
  message: string,
): void {
  pending.resolve(outcome);
  opts.setPendingPermission(null);
  opts.setActivity({
    kind: "tool",
    label: `Running ${pending.req.toolName}`,
    toolName: pending.req.toolName,
  });
  opts.append("system", `[${pending.req.toolName}] ${message}`);
}
