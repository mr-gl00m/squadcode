import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProtectedPath } from "../src/tools/protected.js";
import { walkFiles } from "../src/tools/scan.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-protected-"));
}

describe("isProtectedPath - darwin", () => {
  const home = "/Users/cid";
  const opts = { platform: "darwin" as NodeJS.Platform, home };

  it("flags ~/Library/Mail as protected", () => {
    expect(isProtectedPath("/Users/cid/Library/Mail", opts)).toBe(true);
  });

  it("flags subdirectories under ~/Library/Mail as protected", () => {
    expect(isProtectedPath("/Users/cid/Library/Mail/V9/foo.mbox", opts)).toBe(
      true,
    );
  });

  it("flags ~/Pictures as protected", () => {
    expect(isProtectedPath("/Users/cid/Pictures/snap.png", opts)).toBe(true);
  });

  it("flags /.Spotlight-V100 as protected", () => {
    expect(isProtectedPath("/.Spotlight-V100/Store", opts)).toBe(true);
  });

  it("does not flag ~/code/project as protected", () => {
    expect(isProtectedPath("/Users/cid/code/project", opts)).toBe(false);
  });

  it("does not flag ~/Library/Application Support/some-app", () => {
    // Only specific TCC-triggering Application Support paths are protected.
    expect(
      isProtectedPath("/Users/cid/Library/Application Support/foo", opts),
    ).toBe(false);
  });

  it("treats path matching exactly (no trailing sep) as protected", () => {
    expect(isProtectedPath("/Users/cid/Music", opts)).toBe(true);
  });

  it("does not falsely match a similar-prefix path", () => {
    // /Users/cid/MusicLibrary should NOT match /Users/cid/Music
    expect(isProtectedPath("/Users/cid/MusicLibrary", opts)).toBe(false);
  });
});

describe("isProtectedPath - win32", () => {
  const home = "C:\\Users\\cid";
  const opts = { platform: "win32" as NodeJS.Platform, home };

  it("flags AppData subtree", () => {
    expect(isProtectedPath("C:\\Users\\cid\\AppData\\Local\\foo", opts)).toBe(
      true,
    );
  });

  it("flags OneDrive subtree", () => {
    expect(
      isProtectedPath("C:\\Users\\cid\\OneDrive\\Documents\\note.txt", opts),
    ).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isProtectedPath("C:\\users\\cid\\appdata\\Local\\x", opts)).toBe(
      true,
    );
  });

  it("does not flag a normal project directory", () => {
    expect(isProtectedPath("C:\\Users\\cid\\code\\proj", opts)).toBe(false);
  });
});

describe("isProtectedPath - linux", () => {
  it("returns false for any path on Linux (no protected list)", () => {
    const opts = { platform: "linux" as NodeJS.Platform, home: "/home/cid" };
    expect(isProtectedPath("/home/cid/anything", opts)).toBe(false);
    expect(isProtectedPath("/etc/passwd", opts)).toBe(false);
  });
});

describe("isProtectedPath - cwd opt-in", () => {
  it("allows access when cwd is inside the same protected dir", () => {
    // User explicitly chose to operate inside OneDrive — allow tool access there.
    const opts = {
      platform: "win32" as NodeJS.Platform,
      home: "C:\\Users\\cid",
      cwd: "C:\\Users\\cid\\OneDrive\\code\\proj",
    };
    expect(
      isProtectedPath("C:\\Users\\cid\\OneDrive\\code\\proj\\file.ts", opts),
    ).toBe(false);
  });

  it("still blocks when cwd is not inside the same protected dir", () => {
    const opts = {
      platform: "win32" as NodeJS.Platform,
      home: "C:\\Users\\cid",
      cwd: "C:\\Users\\cid\\code\\proj",
    };
    expect(
      isProtectedPath("C:\\Users\\cid\\OneDrive\\Documents\\secrets.txt", opts),
    ).toBe(true);
  });

  it("still blocks when cwd is in a different protected dir", () => {
    // cwd is in AppData; target is in OneDrive — still block (different dirs).
    const opts = {
      platform: "win32" as NodeJS.Platform,
      home: "C:\\Users\\cid",
      cwd: "C:\\Users\\cid\\AppData\\Local\\proj",
    };
    expect(
      isProtectedPath("C:\\Users\\cid\\OneDrive\\Documents\\secrets.txt", opts),
    ).toBe(true);
  });
});

describe("walkFiles ignore patterns", () => {
  it("skips node_modules, .git, dist, target, .venv, __pycache__", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "node_modules", "foo"), { recursive: true });
    await mkdir(join(dir, ".git", "objects"), { recursive: true });
    await mkdir(join(dir, "dist"), { recursive: true });
    await mkdir(join(dir, "target", "debug"), { recursive: true });
    await mkdir(join(dir, ".venv", "lib"), { recursive: true });
    await mkdir(join(dir, "__pycache__"), { recursive: true });
    await writeFile(join(dir, "src", "real.ts"), "real content");
    await writeFile(join(dir, "node_modules", "foo", "index.js"), "skip");
    await writeFile(join(dir, ".git", "objects", "abc"), "skip");
    await writeFile(join(dir, "dist", "bundle.js"), "skip");
    await writeFile(join(dir, "target", "debug", "app"), "skip");
    await writeFile(join(dir, ".venv", "lib", "stuff"), "skip");
    await writeFile(join(dir, "__pycache__", "x.pyc"), "skip");

    const found: string[] = [];
    for await (const file of walkFiles(dir)) {
      found.push(file.replace(dir, "").replace(/\\/g, "/"));
    }

    expect(found).toEqual(["/src/real.ts"]);
  });

  it("includes files in non-pruned directories", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "src", "sub"), { recursive: true });
    await writeFile(join(dir, "top.md"), "top");
    await writeFile(join(dir, "src", "a.ts"), "a");
    await writeFile(join(dir, "src", "sub", "b.ts"), "b");

    const found: string[] = [];
    for await (const file of walkFiles(dir)) {
      found.push(file.replace(dir, "").replace(/\\/g, "/"));
    }

    expect(found.sort()).toEqual(["/src/a.ts", "/src/sub/b.ts", "/top.md"]);
  });
});
