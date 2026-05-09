export interface TabTitleState {
  pendingPermission: boolean;
  activityKind: "idle" | "thinking" | "responding" | "tool";
}

export function deriveTabTitle(state: TabTitleState): string {
  if (state.pendingPermission) return "Squad ▸ Permission needed";
  if (state.activityKind === "idle") return "Squad ▸ Ready";
  return "Squad ▸ Working";
}

export function tabTitleSequence(title: string): string {
  return `\x1b]2;${title}\x07`;
}

export const BELL = "\x07";
export const CLEAR_TITLE_SEQUENCE = "\x1b]2;\x07";
