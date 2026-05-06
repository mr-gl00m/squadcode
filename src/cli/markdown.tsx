import { Fragment, type ReactElement, type ReactNode } from "react";
import { Text } from "ink";

export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string };

export function parseInline(line: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  let buf = "";
  let i = 0;
  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (c === "*" && line.charAt(i + 1) === "*") {
      const end = line.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ kind: "bold", text: line.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    if (
      c === "*" &&
      line.charAt(i + 1) !== "*" &&
      (i === 0 || line.charAt(i - 1) !== "*")
    ) {
      const end = findItalicClose(line, i + 1);
      if (end > i + 1) {
        flush();
        out.push({ kind: "italic", text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function findItalicClose(line: string, from: number): number {
  let i = from;
  while (i < line.length) {
    if (
      line.charAt(i) === "*" &&
      line.charAt(i + 1) !== "*" &&
      line.charAt(i - 1) !== "*"
    ) {
      return i;
    }
    i++;
  }
  return -1;
}

export type Block =
  | { kind: "paragraph"; content: string }
  | { kind: "header"; level: number; content: string }
  | { kind: "bullet"; indent: string; content: string }
  | { kind: "numbered"; indent: string; marker: string; content: string }
  | { kind: "fence"; lang: string };

const FENCE_RULE = "─".repeat(40);

export function parseBlock(line: string): Block {
  const f = /^```(\w*)\s*$/.exec(line);
  if (f) {
    return { kind: "fence", lang: f[1] ?? "" };
  }
  const h = /^(#{1,6})\s+(.+)$/.exec(line);
  if (h) {
    return { kind: "header", level: h[1]!.length, content: h[2]! };
  }
  const b = /^(\s*)[-*+]\s+(.+)$/.exec(line);
  if (b) {
    return { kind: "bullet", indent: b[1]!, content: b[2]! };
  }
  const n = /^(\s*)(\d+)\.\s+(.+)$/.exec(line);
  if (n) {
    return { kind: "numbered", indent: n[1]!, marker: n[2]!, content: n[3]! };
  }
  return { kind: "paragraph", content: line };
}

function renderInlineNodes(line: string, keyBase: string): ReactNode[] {
  const segs = parseInline(line);
  return segs.map((s, idx) => {
    const k = `${keyBase}-${idx}`;
    switch (s.kind) {
      case "text":
        return <Fragment key={k}>{s.text}</Fragment>;
      case "bold":
        return (
          <Text key={k} bold>
            {s.text}
          </Text>
        );
      case "italic":
        return (
          <Text key={k} italic>
            {s.text}
          </Text>
        );
      case "code":
        return (
          <Text key={k} inverse>
            {s.text}
          </Text>
        );
    }
  });
}

export function renderAssistantLine(line: string): ReactElement {
  const block = parseBlock(line);
  switch (block.kind) {
    case "header":
      return <Text bold>{renderInlineNodes(block.content, "h")}</Text>;
    case "bullet":
      return (
        <Text>
          {block.indent}
          <Text dimColor>{"• "}</Text>
          {renderInlineNodes(block.content, "b")}
        </Text>
      );
    case "numbered":
      return (
        <Text>
          {block.indent}
          <Text dimColor>{`${block.marker}. `}</Text>
          {renderInlineNodes(block.content, "n")}
        </Text>
      );
    case "fence":
      return (
        <Text dimColor>
          {block.lang.length > 0
            ? `─ ${block.lang} ${FENCE_RULE.slice(block.lang.length + 3)}`
            : FENCE_RULE}
        </Text>
      );
    case "paragraph":
      return <Text>{renderInlineNodes(block.content, "p")}</Text>;
  }
}
