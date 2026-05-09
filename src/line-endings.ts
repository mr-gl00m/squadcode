export type LineEnding = "\r\n" | "\n";

const SAMPLE_BYTES = 64_000;

export function detectLineEnding(content: string): LineEnding {
  const sample =
    content.length > SAMPLE_BYTES ? content.slice(0, SAMPLE_BYTES) : content;
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample.charCodeAt(i) === 0x0a) {
      if (i > 0 && sample.charCodeAt(i - 1) === 0x0d) crlf++;
      else lf++;
    }
  }
  return crlf > lf ? "\r\n" : "\n";
}

export function normalizeToLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function restoreLineEnding(
  content: string,
  eol: LineEnding,
): string {
  if (eol === "\n") return content;
  return content.replace(/\n/g, "\r\n");
}
