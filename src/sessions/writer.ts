import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../logger.js";
import type { SessionRecord } from "./types.js";

interface QueuedWrite {
  line: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class SessionWriter {
  private fileHandle: FileHandle | null = null;
  private readonly queue: QueuedWrite[] = [];
  private draining = false;
  private closed = false;
  private idleResolvers: Array<() => void> = [];

  constructor(public readonly path: string) {}

  async open(): Promise<void> {
    if (this.fileHandle) return;
    await fs.mkdir(dirname(this.path), { recursive: true });
    this.fileHandle = await fs.open(this.path, "a");
  }

  async append(record: SessionRecord): Promise<void> {
    if (this.closed) {
      throw new Error(`session writer for ${this.path} is closed`);
    }
    if (!this.fileHandle) {
      throw new Error(`session writer for ${this.path} is not open`);
    }
    const line = `${JSON.stringify(record)}\n`;
    return await new Promise<void>((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    if (!this.fileHandle) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;
        try {
          await this.fileHandle.write(item.line);
          await this.fileHandle.sync();
          item.resolve();
        } catch (err: unknown) {
          const wrapped =
            err instanceof Error
              ? err
              : new Error(`session writer error: ${String(err)}`);
          logger.error(
            { path: this.path, err: wrapped.message },
            "session writer failed",
          );
          item.reject(wrapped);
        }
      }
    } finally {
      this.draining = false;
      const resolvers = this.idleResolvers.splice(0);
      for (const r of resolvers) r();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.draining) return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
      void this.drain();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    if (this.fileHandle) {
      try {
        await this.fileHandle.sync();
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "final fsync failed",
        );
      }
      try {
        await this.fileHandle.close();
      } catch (err: unknown) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "session writer close failed",
        );
      }
      this.fileHandle = null;
    }
  }
}

export async function readSessionFile(
  path: string,
): Promise<SessionRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const records: SessionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as SessionRecord);
    } catch (err: unknown) {
      logger.warn(
        { path, err: err instanceof Error ? err.message : String(err) },
        "skipping malformed session record",
      );
    }
  }
  return records;
}
