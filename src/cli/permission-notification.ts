import { useEffect, useRef, useState } from "react";
import type { ActivityState } from "./repl-types.js";
import {
  BELL,
  CLEAR_TITLE_SEQUENCE,
  deriveTabTitle,
  tabTitleSequence,
} from "./tab-title.js";

interface TerminalWriter {
  write(value: string): void;
}

export interface PermissionNotificationState {
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}

export function permissionNotificationSequence(args: {
  pending: boolean;
  wasPending: boolean;
  activityKind: ActivityState["kind"];
  soundEnabled: boolean;
}): string {
  const title = deriveTabTitle({
    pendingPermission: args.pending,
    activityKind: args.activityKind,
  });
  const ring = args.pending && !args.wasPending && args.soundEnabled;
  return `${tabTitleSequence(title)}${ring ? BELL : ""}`;
}

export function usePermissionNotification(args: {
  stdout?: TerminalWriter;
  pending: boolean;
  activityKind: ActivityState["kind"];
  initialSoundEnabled: boolean;
}): PermissionNotificationState {
  const [soundEnabled, setSoundEnabled] = useState(args.initialSoundEnabled);
  const wasPendingRef = useRef(false);

  useEffect(() => {
    if (!args.stdout) return;
    args.stdout.write(
      permissionNotificationSequence({
        pending: args.pending,
        wasPending: wasPendingRef.current,
        activityKind: args.activityKind,
        soundEnabled,
      }),
    );
    wasPendingRef.current = args.pending;
  }, [args.activityKind, args.pending, args.stdout, soundEnabled]);

  useEffect(
    () => () => {
      args.stdout?.write(CLEAR_TITLE_SEQUENCE);
    },
    [args.stdout],
  );

  return { soundEnabled, setSoundEnabled };
}
