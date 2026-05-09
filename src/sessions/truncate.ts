export const PERSIST_CAP_BYTES = 20_000;

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

export function truncateForPersistence(
  text: string,
  cap: number = PERSIST_CAP_BYTES,
): TruncateResult {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= cap) return { text, truncated: false };
  const slice = buf.subarray(0, cap).toString("utf-8");
  return {
    text: `${slice}\n... (truncated for persistence at ${cap} bytes)`,
    truncated: true,
  };
}
