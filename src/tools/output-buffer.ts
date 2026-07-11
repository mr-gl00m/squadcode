export interface HeadTailOutput {
  text: string;
  truncated: boolean;
  omittedBytes: number;
  totalBytes: number;
}

export class HeadTailBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 2) {
      throw new Error("head/tail buffer maxBytes must be an integer >= 2");
    }
    this.headLimit = Math.floor(maxBytes / 2);
    this.tailLimit = maxBytes - this.headLimit;
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.totalBytes += chunk.length;
    let remainder = chunk;
    if (this.head.length < this.headLimit) {
      const take = Math.min(
        this.headLimit - this.head.length,
        remainder.length,
      );
      this.head = Buffer.concat([this.head, remainder.subarray(0, take)]);
      remainder = remainder.subarray(take);
    }
    if (remainder.length === 0) return;
    const combined = Buffer.concat([this.tail, remainder]);
    this.tail =
      combined.length <= this.tailLimit
        ? combined
        : combined.subarray(combined.length - this.tailLimit);
  }

  get isEmpty(): boolean {
    return this.totalBytes === 0;
  }

  render(): HeadTailOutput {
    const truncated = this.totalBytes > this.maxBytes;
    const omittedBytes = truncated ? this.totalBytes - this.maxBytes : 0;
    if (!truncated) {
      return {
        text: Buffer.concat([this.head, this.tail]).toString("utf8"),
        truncated,
        omittedBytes,
        totalBytes: this.totalBytes,
      };
    }
    return {
      text:
        `${this.head.toString("utf8")}\n` +
        `... [${omittedBytes} bytes omitted; showing head and tail] ...\n` +
        this.tail.toString("utf8"),
      truncated,
      omittedBytes,
      totalBytes: this.totalBytes,
    };
  }
}
