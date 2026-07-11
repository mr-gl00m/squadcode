import type { ComposerState } from "./repl-composer.js";

export interface RapidInputRun {
  text: string;
  events: number;
  startedAt: number;
  lastAt: number;
  startState: ComposerState;
}

export function extendRapidRun(
  previous: RapidInputRun | null,
  fragment: string,
  at: number,
  startState: ComposerState,
): RapidInputRun {
  if (!previous || at - previous.lastAt > 12) {
    return { text: fragment, events: 1, startedAt: at, lastAt: at, startState };
  }
  return {
    ...previous,
    text: previous.text + fragment,
    events: previous.events + 1,
    lastAt: at,
  };
}

export function qualifiesAsPasteBurst(
  run: RapidInputRun | null,
  returnAt: number,
): run is RapidInputRun {
  if (!run || run.events < 2 || run.text.length < 2) return false;
  const eventSpan = run.lastAt - run.startedAt;
  return returnAt - run.lastAt <= 12 && eventSpan <= run.events * 4;
}

export function replaceComposerText(
  state: ComposerState,
  from: string,
  to: string,
): ComposerState {
  const index = state.value.indexOf(from);
  if (index < 0) return state;
  const beforePoints = [...state.value.slice(0, index)].length;
  const fromPoints = [...from].length;
  const toPoints = [...to].length;
  const value =
    state.value.slice(0, index) + to + state.value.slice(index + from.length);
  const cursor =
    state.cursor <= beforePoints
      ? state.cursor
      : state.cursor <= beforePoints + fromPoints
        ? beforePoints + toPoints
        : state.cursor + toPoints - fromPoints;
  return { value, cursor };
}
