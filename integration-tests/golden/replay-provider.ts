// Replay provider for offline agent-loop tests. Implements LLMProvider by
// yielding pre-recorded CanonicalEvents instead of calling a real backend, so
// the agent loop can be exercised end-to-end with no network and fully
// deterministic output. Each call to stream() consumes the next scripted turn;
// the loop calls stream() once per model turn, so an N-turn run needs N turns.

import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalUsage,
  LLMProvider,
  ProviderCallOptions,
} from "../../src/providers/types.js";

export type GoldenTurn = CanonicalEvent[];

export interface ReplayProvider extends LLMProvider {
  // How many turns have been consumed so far — lets a test assert the loop
  // stopped after the expected number of model turns.
  readonly turnsConsumed: number;
  // The requests the loop built per turn, captured so a test can assert what
  // tools/messages were sent upstream.
  readonly requests: readonly CanonicalRequest[];
}

const ZERO_USAGE: CanonicalUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export function createReplayProvider(
  turns: GoldenTurn[],
  name = "replay",
): ReplayProvider {
  let idx = 0;
  const requests: CanonicalRequest[] = [];

  async function* stream(
    req: CanonicalRequest,
    opts?: ProviderCallOptions,
  ): AsyncIterable<CanonicalEvent> {
    requests.push(req);
    const turn = turns[idx];
    idx += 1;
    if (!turn) {
      // Script exhausted — emit a clean terminal so the loop ends rather than
      // hang. A well-formed fixture ends with a no-tool-call turn before this.
      yield { type: "done", reason: "stop" };
      return;
    }
    for (const ev of turn) {
      if (opts?.signal?.aborted) return;
      yield ev;
    }
  }

  async function complete(
    req: CanonicalRequest,
    opts?: ProviderCallOptions,
  ): Promise<CanonicalResponse> {
    let text = "";
    const toolCalls: CanonicalResponse["toolCalls"] = [];
    let finishReason: CanonicalResponse["finishReason"] = "stop";
    let usage: CanonicalUsage = ZERO_USAGE;
    for await (const ev of stream(req, opts)) {
      if (ev.type === "text_delta") text += ev.text;
      else if (ev.type === "tool_call_done")
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
      else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "done") finishReason = ev.reason;
    }
    return { text, toolCalls, finishReason, usage };
  }

  return {
    name,
    stream,
    complete,
    get turnsConsumed() {
      return idx;
    },
    get requests() {
      return requests;
    },
  };
}
