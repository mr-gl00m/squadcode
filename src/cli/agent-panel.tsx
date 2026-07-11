import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  anguishMeter,
  bandColor,
  type PanelCard,
  type PanelState,
} from "./agent-panel-state.js";

// One card per concurrent subagent slot: designator (KT-4), type, model stack,
// current action, and an anguish meter colored by band. Renders empty slots too
// so Tab has a stable set of targets. Pure presentation over PanelState — all
// the logic lives in agent-panel-state.ts.
function Card({
  card,
  focused,
}: {
  card: PanelCard;
  focused: boolean;
}): ReactElement {
  const title = card.agentId
    ? `${card.agentId} ${card.type ?? ""}`.trim()
    : `slot ${card.slot} · empty`;
  const stack =
    card.provider && card.model ? ` · ${card.provider}/${card.model}` : "";
  const status = card.status ? ` · ${card.status}` : "";
  const occupied = card.live || card.status !== undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
    >
      <Text bold={focused}>{`${title}${stack}${status}`}</Text>
      {occupied ? (
        <Box flexDirection="column">
          <Text dimColor>{card.action ? `▶ ${card.action}` : "…"}</Text>
          <Text>
            {"anguish "}
            <Text color={bandColor(card.band)}>
              {anguishMeter(card.anguish)}
            </Text>
            {` ${card.band}`}
          </Text>
        </Box>
      ) : (
        <Text dimColor>idle</Text>
      )}
    </Box>
  );
}

export function AgentPanel({ state }: { state: PanelState }): ReactElement {
  return (
    <Box flexDirection="column">
      {state.cards.map((card) => (
        <Card key={card.slot} card={card} focused={state.focus === card.slot} />
      ))}
    </Box>
  );
}

// The Ctrl+K kill-picker overlay: lists live slots with their [n] key.
export function KillPicker({ state }: { state: PanelState }): ReactElement {
  const live = state.cards.filter((c) => c.live);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      paddingX={1}
    >
      <Text bold color="red">
        Kill which subagent? (esc to cancel)
      </Text>
      {live.length === 0 ? (
        <Text dimColor>no live subagents</Text>
      ) : (
        live.map((c) => (
          <Text key={c.slot}>{`[${c.slot}] ${c.agentId} ${c.type ?? ""}`}</Text>
        ))
      )}
    </Box>
  );
}
