import { logger } from "../logger.js";
import type {
  CanonicalEvent,
  CanonicalRequest,
  LLMProvider,
} from "../providers/types.js";

export async function* runTurn(
  provider: LLMProvider,
  req: CanonicalRequest,
  signal?: AbortSignal,
): AsyncIterable<CanonicalEvent> {
  logger.debug(
    {
      provider: provider.name,
      model: req.model,
      messageCount: req.messages.length,
      hasTools: Boolean(req.tools && req.tools.length > 0),
    },
    "turn start",
  );
  let outputChars = 0;
  let toolCallCount = 0;
  let lastReason: string | undefined;
  const callOpts: { signal?: AbortSignal } = {};
  if (signal) callOpts.signal = signal;
  for await (const ev of provider.stream(req, callOpts)) {
    if (ev.type === "text_delta") outputChars += ev.text.length;
    if (ev.type === "tool_call_done") toolCallCount += 1;
    if (ev.type === "done") lastReason = ev.reason;
    yield ev;
  }
  logger.debug(
    {
      provider: provider.name,
      model: req.model,
      outputChars,
      toolCallCount,
      finishReason: lastReason,
    },
    "turn end",
  );
}
