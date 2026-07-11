import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_EDITOR_BYTES = 1024 * 1024;

export function splitEditorCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (quote) throw new Error("EDITOR contains an unterminated quote");
  if (token) tokens.push(token);
  return tokens;
}

export async function openExternalEditor(
  initial: string,
  cwd: string,
  editor = process.env.VISUAL ?? process.env.EDITOR,
): Promise<string> {
  if (!editor?.trim()) {
    throw new Error("set VISUAL or EDITOR to use the external prompt editor");
  }
  const [executable, ...args] = splitEditorCommand(editor);
  if (!executable) throw new Error("VISUAL/EDITOR is empty");
  const dir = await fs.mkdtemp(join(tmpdir(), "squad-editor-"));
  const path = join(dir, "prompt.md");
  try {
    await fs.writeFile(path, initial, { encoding: "utf8", mode: 0o600 });
    await runEditor(executable, [...args, path], cwd);
    const stat = await fs.stat(path);
    if (stat.size > MAX_EDITOR_BYTES) {
      throw new Error("edited prompt exceeds the 1 MiB limit");
    }
    return await fs.readFile(path, "utf8");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runEditor(
  executable: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: "inherit",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`editor exited with ${signal ?? `code ${code}`}`));
    });
  });
}
