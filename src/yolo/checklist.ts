import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface ChecklistInfo {
  path: string;
  contents: string;
}

const CANDIDATES = [
  "checklist.txt",
  "CHECKLIST.md",
  "checklist.md",
  "CHECKLIST.txt",
];

export async function findChecklist(cwd: string): Promise<ChecklistInfo | null> {
  for (const name of CANDIDATES) {
    const full = join(cwd, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      const contents = await fs.readFile(full, "utf-8");
      return { path: name, contents };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function checklistMissingMessage(): string {
  const list = CANDIDATES.join(", ");
  return [
    "YOLO refused: no checklist in cwd.",
    `Looked for: ${list}.`,
    "Draft checklist.txt with the steps you want me to work, then re-run /yolo.",
    "Each line is one step; I'll work them top-down and mark them done as I go.",
  ].join("\n");
}
