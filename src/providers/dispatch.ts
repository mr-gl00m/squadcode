import type { ModelEntry } from "./catalog.js";
import { createLlmChatProvider } from "./llm-chat.js";
import { createLlmLocalProvider } from "./llm-local.js";
import { createLlmMessageProvider } from "./llm-message.js";
import { createLlmResponseProvider } from "./llm-response.js";
import type { LLMProvider } from "./types.js";

// Dispatch a resolved catalog entry to the right adapter factory. Returns
// either a working LLMProvider or a string error message naming the missing
// piece (env var unset, kind not yet implemented, SSRF-blocked URL). The
// CLI surfaces the string to the user instead of crashing.

export interface DispatchEnv {
  // Lookup an env var by name. Used to read API keys and base-URL overrides
  // declared on catalog rows. Caller passes process.env or a test double.
  get(name: string): string | undefined;
  // SSRF guard for llm-local: when false (default), reject non-localhost
  // base URLs to prevent a hostile catalog override from reaching out to a
  // remote endpoint. Mirrors the OLLAMA_ALLOW_REMOTE escape hatch from v1.0.
  allowRemoteLocal?: boolean;
}

export function readEnv(env: DispatchEnv): DispatchEnv {
  return env;
}

export function makeEnvFromProcess(allowRemoteLocal: boolean): DispatchEnv {
  return {
    get: (name) => process.env[name],
    allowRemoteLocal,
  };
}

function resolvedBaseUrl(entry: ModelEntry, env: DispatchEnv): string {
  if (entry.base_url_env_var) {
    const fromEnv = env.get(entry.base_url_env_var);
    if (fromEnv && fromEnv.length > 0) return fromEnv;
  }
  return entry.base_url;
}

function isLocalUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function dispatchProvider(
  entry: ModelEntry,
  env: DispatchEnv,
): LLMProvider | string {
  const baseUrl = resolvedBaseUrl(entry, env);

  switch (entry.kind) {
    case "llm-chat": {
      if (!entry.env_key_var) {
        return `model "${entry.id}": kind=llm-chat requires env_key_var on the catalog entry`;
      }
      const apiKey = env.get(entry.env_key_var);
      if (!apiKey || apiKey.length === 0) {
        return `${entry.env_key_var} is not set`;
      }
      return createLlmChatProvider({
        apiKey,
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "llm-local": {
      if (!env.allowRemoteLocal && !isLocalUrl(baseUrl)) {
        return `${entry.base_url_env_var ?? "base_url"} must be localhost unless OLLAMA_ALLOW_REMOTE=1`;
      }
      return createLlmLocalProvider({
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "llm-message": {
      if (!entry.env_key_var) {
        return `model "${entry.id}": kind=llm-message requires env_key_var on the catalog entry`;
      }
      const apiKey = env.get(entry.env_key_var);
      if (!apiKey || apiKey.length === 0) {
        return `${entry.env_key_var} is not set`;
      }
      return createLlmMessageProvider({
        apiKey,
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
    case "llm-response": {
      if (!entry.env_key_var) {
        return `model "${entry.id}": kind=llm-response requires env_key_var on the catalog entry`;
      }
      const apiKey = env.get(entry.env_key_var);
      if (!apiKey || apiKey.length === 0) {
        return `${entry.env_key_var} is not set`;
      }
      return createLlmResponseProvider({
        apiKey,
        baseUrl,
        providerId: entry.provider_id,
        ...(entry.capabilities && { capabilities: entry.capabilities }),
      });
    }
  }
}
