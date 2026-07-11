import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteText } from "../fs-io.js";
import { logger } from "../logger.js";
import { redactSecretsInValue } from "../redact.js";
import type { SessionRecord } from "./types.js";

interface QueuedWrite {
  line: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface SessionWriterOptions {
  maxWriteAttempts?: number;
  beforeWrite?: (input: { attempt: number; line: string }) => Promise<void>;
  afterWriteBeforeSync?: (input: {
    attempt: number;
    line: string;
  }) => Promise<void>;
  beforeRewriteRename?: (paths: {
    tmp: string;
    target: string;
  }) => Promise<void>;
}

export class SessionWriter {
  private fileHandle: FileHandle | null = null;
  private readonly queue: QueuedWrite[] = [];
  private draining = false;
  private closed = false;
  private terminalError: Error | null = null;
  private rewriting = false;
  private idleResolvers: Array<() => void> = [];

  constructor(
    public readonly path: string,
    private readonly options: SessionWriterOptions = {},
  ) {}

  async open(): Promise<void> {
    if (this.fileHandle) return;
    await fs.mkdir(dirname(this.path), { recursive: true });
    this.fileHandle = await fs.open(this.path, "a");
  }

  async append(record: SessionRecord): Promise<void> {
    if (this.closed) {
      throw new Error(`session writer for ${this.path} is closed`);
    }
    if (this.terminalError) throw this.terminalError;
    if (this.rewriting) {
      throw new Error(`session writer for ${this.path} is being rewritten`);
    }
    if (!this.fileHandle) {
      throw new Error(`session writer for ${this.path} is not open`);
    }
    const line = `${JSON.stringify(redactSecretsInValue(record))}\n`;
    return await new Promise<void>((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        if (!item) continue;
        const maxAttempts = this.options.maxWriteAttempts ?? 3;
        let written = false;
        let lastError: Error | null = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          let startSize: number | null = null;
          try {
            await this.ensureHandle();
            const handle = this.fileHandle;
            if (!handle) throw new Error("session writer handle did not open");
            startSize = (await fs.stat(this.path)).size;
            await this.options.beforeWrite?.({ attempt, line: item.line });
            await handle.write(item.line);
            await this.options.afterWriteBeforeSync?.({
              attempt,
              line: item.line,
            });
            await handle.sync();
            this.queue.shift();
            item.resolve();
            written = true;
            break;
          } catch (err: unknown) {
            lastError = asWriterError(err);
            await this.discardHandle();
            if (startSize !== null) {
              await fs.truncate(this.path, startSize).catch(() => undefined);
            }
          }
        }
        if (!written) {
          const terminal =
            lastError ?? new Error(`session writer failed for ${this.path}`);
          this.terminalError = terminal;
          logger.error(
            { path: this.path, err: terminal.message },
            "session writer failed permanently",
          );
          while (this.queue.length > 0) {
            this.queue.shift()?.reject(terminal);
          }
          break;
        }
      }
    } finally {
      this.draining = false;
      const resolvers = this.idleResolvers.splice(0);
      for (const r of resolvers) r();
    }
  }

  async flush(): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    if (this.queue.length === 0 && !this.draining) return;
    await new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
      void this.drain();
    });
    if (this.terminalError) throw this.terminalError;
  }

  async rewrite(records: readonly SessionRecord[]): Promise<void> {
    if (this.closed) {
      throw new Error(`session writer for ${this.path} is closed`);
    }
    if (this.terminalError) throw this.terminalError;
    if (this.rewriting) {
      throw new Error(
        `session writer for ${this.path} is already being rewritten`,
      );
    }
    this.rewriting = true;
    try {
      await this.flush();
      await this.discardHandle();
      const content = records
        .map((record) => JSON.stringify(redactSecretsInValue(record)))
        .join("\n");
      await atomicWriteText(
        this.path,
        content.length > 0 ? `${content}\n` : "",
        {
          ...(this.options.beforeRewriteRename && {
            beforeRename: this.options.beforeRewriteRename,
          }),
        },
      );
      await this.ensureHandle();
    } catch (error: unknown) {
      try {
        await this.ensureHandle();
      } catch (reopenError: unknown) {
        throw new AggregateError(
          [error, reopenError],
          `session writer rewrite and reopen failed for ${this.path}`,
        );
      }
      throw error;
    } finally {
      this.rewriting = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let closeError: Error | null = null;
    try {
      await this.flush();
    } catch (error: unknown) {
      closeError = asWriterError(error);
    }
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
    if (closeError) throw closeError;
  }

  private async ensureHandle(): Promise<void> {
    if (this.fileHandle) return;
    await fs.mkdir(dirname(this.path), { recursive: true });
    this.fileHandle = await fs.open(this.path, "a");
  }

  private async discardHandle(): Promise<void> {
    const failed = this.fileHandle;
    this.fileHandle = null;
    await failed?.close().catch(() => undefined);
  }
}

function asWriterError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(`session writer error: ${String(error)}`);
}

export async function readSessionFile(path: string): Promise<SessionRecord[]> {
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
