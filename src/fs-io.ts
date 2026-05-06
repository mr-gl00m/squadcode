import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

export async function readText(filePath: string): Promise<string> {
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
): Promise<void> {
  const absolute = resolve(filePath);
  await fs.mkdir(dirname(absolute), { recursive: true });
  const tmp = `${absolute}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, absolute);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function atomicWriteJson<T>(
  filePath: string,
  data: T,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2) + "\n");
}
