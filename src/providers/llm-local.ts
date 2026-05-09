import type { ModelCapabilities } from "./catalog.js";
import { createLlmChatProvider } from "./llm-chat.js";
import type { LLMProvider } from "./types.js";

// Local Ollama-style adapter. Ollama exposes an OpenAI-compatible endpoint at
// /v1, so the wire format is the same as llm-chat — the only differences are
// (a) the base URL needs /v1 appended if the user gives the bare host:port,
// and (b) there's no API key, so we hand a placeholder string to the OpenAI
// SDK (which requires the field to be set).

export interface LlmLocalProviderOptions {
  baseUrl: string;
  // Defaults to "ollama" — surfaces as LLMProvider.name for pricing / audit.
  providerId?: string;
  capabilities?: ModelCapabilities;
}

function appendV1Path(baseUrl: string): string {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/$/, "");
  if (pathname !== "/v1" && !pathname.endsWith("/v1")) {
    url.pathname = `${pathname}/v1`;
  }
  return url.toString();
}

export function createLlmLocalProvider(
  opts: LlmLocalProviderOptions,
): LLMProvider {
  return createLlmChatProvider({
    apiKey: "ollama",
    baseUrl: appendV1Path(opts.baseUrl),
    providerId: opts.providerId ?? "ollama",
    ...(opts.capabilities && { capabilities: opts.capabilities }),
  });
}
