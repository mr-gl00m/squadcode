import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderContextFragment } from "../src/context/fragment.js";
import {
  buildDiagnosticsFragment,
  collectSyntaxDiagnostics,
  createDiagnosticsTracker,
  loadDiagnosticsCommand,
  runDiagnosticsCommand,
} from "../src/engine/post-edit-diagnostics.js";
import { makePreTurnInjector } from "../src/engine/pre-turn.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-diag-test-"));
}

describe("diagnostics tracker", () => {
  it("dedupes and drains touched files", () => {
    const t = createDiagnosticsTracker();
    expect(t.hasPending()).toBe(false);
    t.recordTouched("/a/b.ts");
    t.recordTouched("/a/b.ts");
    t.recordTouched("/a/c.ts");
    expect(t.hasPending()).toBe(true);
    expect(t.drainTouched()).toEqual(["/a/b.ts", "/a/c.ts"]);
    expect(t.hasPending()).toBe(false);
    expect(t.drainTouched()).toEqual([]);
  });
});

describe("syntax diagnostics", () => {
  it("flags a TypeScript file with a syntax error", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "broken.ts");
    await writeFile(path, "function f( {\n  return 1;\n", "utf-8");
    const out = await collectSyntaxDiagnostics([path], { cwd: dir });
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe("broken.ts");
    expect(out[0]!.problems.length).toBeGreaterThan(0);
    expect(out[0]!.problems[0]).toMatch(/^\d+:\d+ /);
  });

  it("stays silent on a clean TypeScript file", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "clean.ts");
    await writeFile(path, "export const x: number = 1;\n", "utf-8");
    const out = await collectSyntaxDiagnostics([path], { cwd: dir });
    expect(out).toEqual([]);
  });

  it("flags invalid JSON and passes valid JSON", async () => {
    const dir = await makeTempDir();
    const bad = join(dir, "bad.json");
    const good = join(dir, "good.json");
    await writeFile(bad, '{ "a": 1, }', "utf-8");
    await writeFile(good, '{ "a": 1 }', "utf-8");
    const out = await collectSyntaxDiagnostics([bad, good], { cwd: dir });
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe("bad.json");
    expect(out[0]!.problems[0]).toContain("invalid JSON");
  });

  it("skips unknown extensions and vanished files", async () => {
    const dir = await makeTempDir();
    const md = join(dir, "notes.md");
    await writeFile(md, "# whatever ((( \n", "utf-8");
    const out = await collectSyntaxDiagnostics([md, join(dir, "gone.ts")], {
      cwd: dir,
    });
    expect(out).toEqual([]);
  });

  it("flags a Python file with a syntax error", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "broken.py");
    await writeFile(path, "def f(:\n    pass\n", "utf-8");
    const out = await collectSyntaxDiagnostics([path], { cwd: dir });
    expect(out).toHaveLength(1);
  });
});

describe("diagnostics command tier", () => {
  it("returns null on exit 0", async () => {
    const dir = await makeTempDir();
    const out = await runDiagnosticsCommand(
      { command: `node -e "process.exit(0)"` },
      { cwd: dir },
    );
    expect(out).toBeNull();
  });

  it("returns capped output on non-zero exit", async () => {
    const dir = await makeTempDir();
    const out = await runDiagnosticsCommand(
      {
        command: `node -e "console.error('type error at x.ts:3'); process.exit(1)"`,
      },
      { cwd: dir },
    );
    expect(out).toContain("type error at x.ts:3");
  });

  it("survives an unrunnable command", async () => {
    const dir = await makeTempDir();
    const out = await runDiagnosticsCommand(
      { command: "definitely-not-a-real-binary-xyz" },
      { cwd: dir },
    );
    // cmd/sh report unknown commands via non-zero exit + stderr text; the
    // point is it must not throw.
    expect(typeof out === "string" || out === null).toBe(true);
  });

  it("loads command config from project settings", async () => {
    const dir = await makeTempDir();
    await mkdir(join(dir, ".squad"), { recursive: true });
    await writeFile(
      join(dir, ".squad", "settings.json"),
      JSON.stringify({
        diagnostics: { command: "npm run typecheck", timeoutMs: 90000 },
      }),
      "utf-8",
    );
    const cfg = await loadDiagnosticsCommand(dir);
    expect(cfg).toEqual({ command: "npm run typecheck", timeoutMs: 90000 });
  });

  it("returns undefined when settings have no diagnostics block", async () => {
    const dir = await makeTempDir();
    expect(await loadDiagnosticsCommand(dir)).toBeUndefined();
  });
});

describe("diagnostics injection", () => {
  it("injects nothing when touched files parse clean", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "ok.ts");
    await writeFile(path, "export const a = 1;\n", "utf-8");
    const tracker = createDiagnosticsTracker();
    tracker.recordTouched(path);
    const fragment = await buildDiagnosticsFragment({ tracker, cwd: dir });
    expect(fragment).toBeNull();
    expect(tracker.hasPending()).toBe(false);
  });

  it("builds a marked-up message for broken files", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "broken.ts");
    await writeFile(path, "const = ;\n", "utf-8");
    const tracker = createDiagnosticsTracker();
    tracker.recordTouched(path);
    const fragment = await buildDiagnosticsFragment({ tracker, cwd: dir });
    expect(fragment).not.toBeNull();
    expect(fragment?.source).toBe("post-edit-diagnostics");
    expect(fragment?.type).toBe("findings");
    expect(fragment?.merge).toBe("replace");
    if (!fragment) throw new Error("expected diagnostics fragment");
    const body = renderContextFragment(fragment).content;
    expect(body).toContain('type="findings"');
    expect(body).toContain("broken.ts");
    expect(body).toContain("Fix them before continuing");
  });

  it("flows through the pre-turn injector as a user fragment", async () => {
    const dir = await makeTempDir();
    const path = join(dir, "broken.ts");
    await writeFile(path, "function ( {\n", "utf-8");
    const tracker = createDiagnosticsTracker();
    const inject = makePreTurnInjector({
      diagnostics: { tracker, cwd: dir },
    });
    // Nothing pending: no messages.
    expect(await inject()).toEqual([]);
    tracker.recordTouched(path);
    const fragments = await inject();
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.role).toBe("user");
    expect(fragments[0]?.type).toBe("findings");
    expect(fragments[0]?.content).toContain("broken.ts");
  });
});
