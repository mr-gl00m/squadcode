import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { AgentPanel, KillPicker } from "../src/cli/agent-panel.js";
import { emptyPanelState, reducePanels } from "../src/cli/agent-panel-state.js";
import { PermissionOverlay, StatusFooter } from "../src/cli/repl.js";
import {
  BacktrackOverlay,
  ToolLedgerView,
} from "../src/cli/repl-presentation.js";
import {
  ledgerDelta,
  ledgerResult,
  ledgerRun,
  ledgerStart,
  type ToolCallRecord,
} from "../src/cli/tool-ledger.js";

function populatedPanel() {
  return reducePanels(emptyPanelState(4), [
    {
      kind: "spawned",
      agentId: "KT-4",
      type: "red-team",
      slotKey: 1,
      model: "deepseek-v4-pro",
      provider: "deepseek",
      at: "2026-07-10T00:00:00.000Z",
    },
    {
      kind: "action",
      agentId: "KT-4",
      action: "Shell npm test",
    },
    {
      kind: "anguish",
      agentId: "KT-4",
      value: 0.72,
      band: "urgent",
    },
  ]);
}

describe("Ink regression snapshots", () => {
  it("pins the status footer", () => {
    const view = render(
      <StatusFooter
        yoloOn
        mode="plan"
        provider="deepseek"
        model="deepseek-v4-pro"
        turnCount={3}
        lastTurnInputTokens={12_000}
        lastTurnCachedTokens={3_000}
        lastTurnOutputTokens={800}
        lastTurnCost={0.021}
        totalInputTokens={40_000}
        totalCachedTokens={10_000}
        totalOutputTokens={2_400}
        totalCost={0.084}
        pendingPermission={false}
        isStreaming
        viewMode="compact"
      />,
    );
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it("pins the compact tool ledger window", () => {
    const done = (
      ledger: readonly ToolCallRecord[],
      id: string,
      name: string,
      preview: string,
      result: Parameters<typeof ledgerResult>[3],
    ): readonly ToolCallRecord[] =>
      ledgerResult(
        ledgerRun(ledgerStart(ledger, id, name), id, name, preview),
        id,
        name,
        result,
      );
    let ledger: readonly ToolCallRecord[] = [];
    ledger = done(ledger, "c1", "Shell", "ran git log --oneline -20", {
      ok: true,
    });
    ledger = done(ledger, "c2", "Glob", "matched **/*parser*", { ok: true });
    ledger = done(ledger, "c3", "Grep", "searched (?i)parser|parse", {
      ok: false,
      error: "GREP_BAD_REGEX",
    });
    ledger = done(ledger, "c4", "Read", "read sigil_llm_adapter.py", {
      ok: true,
    });
    ledger = done(ledger, "c5", "Shell", "ran git diff --stat HEAD~3..HEAD", {
      ok: true,
    });
    ledger = done(ledger, "c6", "Shell", "ran rm -rf build", {
      ok: false,
      reason: "denied",
    });
    ledger = ledgerRun(
      ledgerStart(ledger, "c7", "Shell"),
      "c7",
      "Shell",
      "ran git log --all --oneline -30",
    );
    ledger = ledgerDelta(ledgerStart(ledger, "c8", "Grep"), "c8", 46);
    const view = render(<ToolLedgerView ledger={ledger} />);
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it("pins the agent panel", () => {
    const view = render(<AgentPanel state={populatedPanel()} />);
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it("pins the permission overlay", () => {
    const view = render(
      <PermissionOverlay
        request={{
          toolName: "Shell",
          callId: "call-1",
          argsPreview: "npm test",
          scopePattern: "npm test *",
          scopePatterns: ["npm test *"],
          guardianAdvice:
            "guardian llama3.2 [caution]: Confirm the command is scoped to this repository.",
        }}
        allowProjectPersist
      />,
    );
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it("pins the kill picker", () => {
    const view = render(<KillPicker state={populatedPanel()} />);
    expect(view.lastFrame()).toMatchSnapshot();
  });

  it("pins the backtrack overlay", () => {
    const view = render(
      <BacktrackOverlay
        state={{
          open: true,
          status: "ready",
          selected: 1,
          targets: [
            {
              turnId: "turn-1",
              turnNumber: 1,
              totalTokens: 100,
              label: "inspect the project",
              ts: "2026-07-10T00:00:00.000Z",
            },
            {
              turnId: "turn-2",
              turnNumber: 2,
              totalTokens: 200,
              label: "implement the fix",
              ts: "2026-07-10T00:01:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(view.lastFrame()).toMatchSnapshot();
  });
});
