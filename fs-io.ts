import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

async function readText(filePath: string): Promise<string> {
  return fs.readFile(resolve(filePath), "utf-8");
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readText(filePath);
  return JSON.parse(raw) as T;
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(resolve(filePath));
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteText(
  filePath: string,
  content: string,
  hooks: AtomicWriteHooks = {},
): Promise<void> {
  const absolute = resolve(filePath);
  const parent = dirname(absolute);
  await fs.mkdir(parent, { recursive: true });
  const existingMode = await fs
    .stat(absolute)
    .then((stats) => stats.mode & 0o7777)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
  // Per-call tmp suffix: pid + 8 random bytes so concurrent writers to the
  // same target each stage to their own file. Last rename wins; no writer
  // observes another writer's payload silently overwriting its tmp.
  const tmp = `${absolute}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(tmp, "wx", existingMode ?? 0o666);
    await handle.writeFile(content, "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (existingMode !== undefined) await fs.chmod(tmp, existingMode);
    await hooks.beforeRename?.({ tmp, target: absolute });
    await fs.rename(tmp, absolute);
    await syncDirectory(parent);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export interface AtomicWriteHooks {
  beforeRename?: (paths: { tmp: string; target: string }) => Promise<void>;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(path, "r");
    await handle.sync();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === "win32" &&
      (code === "EISDIR" || code === "EPERM" || code === "EINVAL")
    ) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWriteJson<T>(
  filePath: string,
  data: T,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
}
