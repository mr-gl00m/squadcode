import { createHash } from "node:crypto";
import type { CanonicalMessage, CanonicalRole } from "../providers/types.js";

export type FragmentMerge = "append" | "replace";
export type FragmentVisibility = "model" | "user" | "model-and-user" | "audit";
export type FragmentTrust =
  | "trusted-system"
  | "untrusted-user"
  | "untrusted-tool"
  | "untrusted-environment";

export interface ContextFragment {
  source: string;
  type: string;
  key?: string;
  role: CanonicalRole;
  merge: FragmentMerge;
  visibility: FragmentVisibility;
  trust: FragmentTrust;
  content: string;
  maxBytes: number;
  maxTokens: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface RenderedContextFragment {
  id: string;
  content: string;
  truncated: boolean;
  originalBytes: number;
  renderedBytes: number;
}

export const DEFAULT_FRAGMENT_MAX_BYTES = 16 * 1024;
export const DEFAULT_FRAGMENT_MAX_TOKENS = 4_096;

export function createContextFragment(
  input: Omit<ContextFragment, "maxBytes" | "maxTokens"> & {
    maxBytes?: number;
    maxTokens?: number;
  },
): ContextFragment {
  if (!input.source.trim() || !input.type.trim()) {
    throw new Error("context fragment source and type must be non-empty");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_FRAGMENT_MAX_BYTES;
  const maxTokens = input.maxTokens ?? DEFAULT_FRAGMENT_MAX_TOKENS;
  if (maxBytes <= 0 || maxTokens <= 0) {
    throw new Error("context fragment caps must be positive");
  }
  return { ...input, maxBytes, maxTokens };
}

export function fragmentId(fragment: ContextFragment): string {
  return [fragment.source, fragment.type, fragment.key]
    .filter((part): part is string => Boolean(part))
    .join(":");
}

export function renderContextFragment(
  fragment: ContextFragment,
): RenderedContextFragment {
  const id = fragmentId(fragment);
  const byteCap = Math.min(fragment.maxBytes, fragment.maxTokens * 4);
  const originalBytes = Buffer.byteLength(fragment.content, "utf8");
  const { content: body, truncated } = renderBoundedBody(
    fragment.content,
    byteCap,
    isUntrusted(fragment.trust),
  );
  const suffix = truncated
    ? `\n[CONTEXT_TRUNCATED originalBytes=${originalBytes} capBytes=${byteCap}]`
    : "";
  const tag = markerTag(fragment.type);
  const attributes = {
    source: fragment.source,
    type: fragment.type,
    id,
    trust: fragment.trust,
    visibility: fragment.visibility,
    ...(fragment.attributes ?? {}),
  };
  const rendered = `<${tag}${renderAttributes(attributes)}>\n${body}${suffix}\n</${tag}>`;
  return {
    id,
    content: rendered,
    truncated,
    originalBytes,
    renderedBytes: Buffer.byteLength(rendered, "utf8"),
  };
}

export function fragmentToMessage(
  fragment: ContextFragment,
  extras: Pick<CanonicalMessage, "toolCallId" | "toolName"> = {},
): CanonicalMessage {
  if (
    fragment.visibility !== "model" &&
    fragment.visibility !== "model-and-user"
  ) {
    throw new Error(
      `context fragment ${fragmentId(fragment)} is not visible to the model`,
    );
  }
  const rendered = renderContextFragment(fragment);
  return {
    role: fragment.role,
    content: rendered.content,
    contextFragmentId: rendered.id,
    ...(extras.toolCallId !== undefined && { toolCallId: extras.toolCallId }),
    ...(extras.toolName !== undefined && { toolName: extras.toolName }),
  };
}

export class ContextFragmentAccumulator {
  private readonly prior = new Map<
    string,
    { hash: string; messageIndex: number | null }
  >();

  apply(
    messages: CanonicalMessage[],
    fragments: readonly ContextFragment[],
  ): CanonicalMessage[] {
    const appended: CanonicalMessage[] = [];
    for (const fragment of fragments) {
      if (
        fragment.visibility !== "model" &&
        fragment.visibility !== "model-and-user"
      ) {
        continue;
      }
      const rendered = renderContextFragment(fragment);
      const hash = createHash("sha256").update(rendered.content).digest("hex");
      let previous = this.prior.get(rendered.id);
      if (!previous) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const existing = messages[index];
          if (existing?.contextFragmentId !== rendered.id) continue;
          previous = {
            hash: createHash("sha256").update(existing.content).digest("hex"),
            messageIndex: fragment.merge === "replace" ? index : null,
          };
          this.prior.set(rendered.id, previous);
          break;
        }
      }
      if (previous?.hash === hash) continue;
      const message: CanonicalMessage = {
        role: fragment.role,
        content: rendered.content,
        contextFragmentId: rendered.id,
      };
      if (
        fragment.merge === "replace" &&
        previous?.messageIndex !== null &&
        previous?.messageIndex !== undefined &&
        messages[previous.messageIndex]?.contextFragmentId === rendered.id
      ) {
        messages[previous.messageIndex] = message;
        this.prior.set(rendered.id, {
          hash,
          messageIndex: previous.messageIndex,
        });
        continue;
      }
      messages.push(message);
      appended.push(message);
      this.prior.set(rendered.id, {
        hash,
        messageIndex: fragment.merge === "replace" ? messages.length - 1 : null,
      });
    }
    return appended;
  }
}

function isUntrusted(trust: FragmentTrust): boolean {
  return trust !== "trusted-system";
}

function markerTag(type: string): string {
  if (type === "user_prompt") return "USER_PROMPT";
  if (type === "tool_output") return "TOOL_OUTPUT";
  return "CONTEXT_FRAGMENT";
}

function renderAttributes(
  attributes: Record<string, string | number | boolean>,
): string {
  return Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeForAttribute(String(value))}"`)
    .join("");
}

function escapeForMarker(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeForAttribute(value: string): string {
  return escapeForMarker(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderBoundedBody(
  value: string,
  maxBytes: number,
  escapeMarkup: boolean,
): { content: string; truncated: boolean } {
  let bytes = 0;
  let output = "";
  let consumed = 0;
  for (const character of value) {
    const rendered = escapeMarkup ? escapeForMarker(character) : character;
    const width = Buffer.byteLength(rendered, "utf8");
    if (bytes + width > maxBytes) break;
    output += rendered;
    bytes += width;
    consumed += character.length;
  }
  return { content: output, truncated: consumed < value.length };
}
