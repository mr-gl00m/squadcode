const FENCE_PATTERN = /^\s*(```|~~~)/;
const BLOCK_START_PATTERN =
  /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|[-*_]{3,}\s*$|\|)/;

export class AssistantTextReflow {
  private pending: string | null = null;
  private inFence = false;
  private carry = "";
  private sawLineBreak = false;
  private trailingNewlines = 0;

  push(text: string): string {
    this.carry += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let out = "";
    let nl = this.carry.indexOf("\n");
    while (nl !== -1) {
      out += this.processLine(this.carry.slice(0, nl));
      this.carry = this.carry.slice(nl + 1);
      nl = this.carry.indexOf("\n");
    }
    if (this.carry.length > 0) {
      out += this.processTextFragment(this.carry);
      this.carry = "";
    }
    return out;
  }

  preview(): string {
    return this.pending ?? "";
  }

  flush(): string {
    const out = this.pending ?? "";
    this.pending = null;
    this.carry = "";
    return out;
  }

  private processTextFragment(fragment: string): string {
    if (this.sawLineBreak && this.pending !== null) {
      this.sawLineBreak = false;
      if (shouldKeepLineBreak(this.pending, fragment, this.inFence)) {
        const out = this.emitLine(this.pending);
        this.pending = fragment;
        return out;
      }
      this.pending = `${this.pending.trimEnd()} ${fragment.trimStart()}`;
      return "";
    }

    this.sawLineBreak = false;
    if (this.pending === null) {
      this.pending = fragment;
    } else {
      this.pending += fragment;
    }
    return "";
  }

  private processLine(line: string): string {
    if (this.pending === null) {
      this.pending = line;
      this.sawLineBreak = true;
      return "";
    }

    if (shouldKeepLineBreak(this.pending, line, this.inFence)) {
      const out = this.emitLine(this.pending);
      this.pending = line;
      this.sawLineBreak = true;
      return out;
    }

    this.pending = `${this.pending.trimEnd()} ${line.trimStart()}`;
    this.sawLineBreak = true;
    return "";
  }

  private updateFenceState(line: string): void {
    if (FENCE_PATTERN.test(line)) {
      this.inFence = !this.inFence;
    }
  }

  private emitLine(line: string): string {
    const preserveBlankLine = this.inFence;
    const isBlank = line.trim() === "";

    if (isBlank && !preserveBlankLine && this.trailingNewlines >= 2) {
      return "";
    }

    const out = `${line}\n`;
    this.updateFenceState(line);
    this.trailingNewlines = isBlank ? this.trailingNewlines + 1 : 1;
    return out;
  }
}

function shouldKeepLineBreak(
  previous: string,
  next: string,
  inFence: boolean,
): boolean {
  if (inFence) return true;
  if (previous.trim() === "" || next.trim() === "") return true;
  if (FENCE_PATTERN.test(previous) || FENCE_PATTERN.test(next)) return true;
  if (BLOCK_START_PATTERN.test(previous) || BLOCK_START_PATTERN.test(next)) {
    return true;
  }
  if (/\s{2}$/.test(previous)) return true;
  return false;
}

export function reflowAssistantText(text: string): string {
  const reflow = new AssistantTextReflow();
  return reflow.push(text) + reflow.flush();
}
