import { config } from "dotenv";
import { createLlmChatProvider } from "../../src/providers/llm-chat.js";

config();

const apiKey = process.env["DEEPSEEK_API_KEY"];
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY not set");
  process.exit(2);
}

const provider = createLlmChatProvider({
  apiKey,
  baseUrl: process.env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com",
  providerId: "deepseek",
  capabilities: { tool_use: true, reasoning: true, cache_control: true },
});

const abort = new AbortController();
let chunks = 0;
let textChunks = 0;
let reasoningChunks = 0;
let chunksAtAbort: number | null = null;
let lastEventAfterAbort: string | null = null;
let endedAt = 0;
const startTs = Date.now();

const ABORT_AFTER_MS = 2000;
const HARD_TIMEOUT_MS = 30_000;

const hardTimer = setTimeout(() => {
  console.error("\n>>> hard timeout reached, force exit");
  process.exit(3);
}, HARD_TIMEOUT_MS);

setTimeout(() => {
  chunksAtAbort = chunks;
  console.log(
    `\n\n>>> aborting after ${ABORT_AFTER_MS}ms (chunks so far: ${chunks})`,
  );
  abort.abort();
}, ABORT_AFTER_MS);

try {
  for await (const ev of provider.stream(
    {
      model: process.env["DEEPSEEK_MODEL"] ?? "deepseek-v4-flash",
      messages: [
        {
          role: "user",
          content:
            "Write a detailed 2000-word fictional story about a programmer and a malfunctioning AI. Take your time, include lots of detail and dialogue.",
        },
      ],
    },
    { signal: abort.signal },
  )) {
    if (ev.type === "text_delta") {
      chunks += 1;
      textChunks += 1;
      process.stdout.write(".");
      if (chunksAtAbort !== null && lastEventAfterAbort === null) {
        lastEventAfterAbort = "text_delta";
      }
    } else if (ev.type === "reasoning_delta") {
      chunks += 1;
      reasoningChunks += 1;
      process.stdout.write("·");
      if (chunksAtAbort !== null && lastEventAfterAbort === null) {
        lastEventAfterAbort = "reasoning_delta";
      }
    } else {
      if (chunksAtAbort !== null && lastEventAfterAbort === null) {
        lastEventAfterAbort = ev.type;
      }
      if (ev.type === "error") {
        console.log(`\n[error event] ${ev.code}: ${ev.message}`);
      }
      if (ev.type === "done") {
        console.log(`\n[done: ${ev.reason}]`);
      }
    }
  }
} catch (err: unknown) {
  console.log(
    `\n[exception] ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
  );
}

endedAt = Date.now();
clearTimeout(hardTimer);

console.log(`\n--- abort-stream test result ---`);
console.log(`total elapsed: ${endedAt - startTs}ms`);
console.log(`chunks at abort: ${chunksAtAbort ?? "n/a"} (text=${textChunks - (lastEventAfterAbort === "text_delta" ? 1 : 0)} reasoning=${reasoningChunks})`);
console.log(`final chunk count: ${chunks} (text=${textChunks} reasoning=${reasoningChunks})`);
console.log(`chunks after abort fired: ${chunks - (chunksAtAbort ?? 0)}`);
console.log(`time from abort to stream end: ${endedAt - startTs - ABORT_AFTER_MS}ms`);
console.log(`first event after abort: ${lastEventAfterAbort ?? "(none)"}`);

const passed =
  chunksAtAbort !== null &&
  chunksAtAbort > 0 &&
  chunks - chunksAtAbort < 50 &&
  endedAt - startTs - ABORT_AFTER_MS < 5000;
console.log(`\nresult: ${passed ? "PASS" : "FAIL"}`);
process.exit(passed ? 0 : 1);
