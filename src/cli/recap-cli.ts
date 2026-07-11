import { formatRecap } from "../sessions/recap.js";
import { openSessionStore } from "../sessions/store.js";
import { sanitizeForTerminal } from "../terminal.js";

export async function runRecapCli(sessionId: string): Promise<void> {
  const store = openSessionStore();
  try {
    let read: Awaited<ReturnType<typeof store.read>>;
    try {
      read = await store.read(sessionId);
    } catch (err) {
      process.stderr.write(
        `session not found: ${sanitizeForTerminal(sessionId)} (${
          err instanceof Error ? err.message : String(err)
        })\n`,
      );
      process.exitCode = 2;
      return;
    }
    const usage = store.usageTotals({ sessionId });
    const text = formatRecap({
      metadata: read.metadata,
      records: read.records,
      usage,
    });
    process.stdout.write(`${text}\n`);
  } finally {
    await store.shutdown();
  }
}
