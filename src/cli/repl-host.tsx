import { render } from "ink";
import { logger } from "../logger.js";
import { ReplApp } from "./repl-app.js";
import type { ReplControl, ReplOptions } from "./repl-types.js";

export async function runInkRepl(initialOpts: ReplOptions): Promise<void> {
  const stdoutTty = process.stdout.isTTY === true;
  if (stdoutTty) process.stdout.write("\x1b[?2004h\x1b[?1004h");
  const restore = (): void => {
    if (stdoutTty) process.stdout.write("\x1b[?1004l\x1b[?2004l");
  };
  process.once("exit", restore);
  try {
    let opts = initialOpts;
    for (;;) {
      const control: ReplControl = {};
      const instance = render(<ReplApp {...opts} control={control} />);
      await instance.waitUntilExit();
      const target = control.resumeSessionId;
      if (target === undefined) break;
      try {
        const resumed = await opts.store.resume(target);
        opts = {
          ...opts,
          sessionId: resumed.metadata.sessionId,
          metadata: resumed.metadata,
          messages: resumed.messages,
          resumed: true,
        };
        if (stdoutTty) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      } catch (err: unknown) {
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            sessionId: target,
          },
          "in-repl resume failed; exiting",
        );
        break;
      }
    }
  } finally {
    restore();
    process.removeListener("exit", restore);
  }
}
