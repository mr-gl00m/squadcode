import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureProjectTrust,
  projectDefaultMode,
  projectTrustKey,
} from "../src/cli/project-trust.js";
import type { SquadSettings } from "../src/settings.js";

function settings(overrides: Partial<SquadSettings> = {}): SquadSettings {
  return { version: "0.1.0", createdAt: "now", ...overrides };
}

describe("per-project trust", () => {
  it("prompts once and persists the canonical directory decision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-trust-"));
    const persist = vi.fn(async () => undefined);
    const trusted = await ensureProjectTrust(cwd, settings(), {
      interactive: true,
      ask: async () => "yes",
      persist,
    });

    expect(trusted).toBe(true);
    expect(persist).toHaveBeenCalledWith(await projectTrustKey(cwd), true);
  });

  it("uses a stored decision without prompting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-trust-"));
    const key = await projectTrustKey(cwd);
    const ask = vi.fn(async () => "yes");
    const trusted = await ensureProjectTrust(
      cwd,
      settings({
        projectTrust: {
          [key]: { trusted: false, updatedAt: "now" },
        },
      }),
      { interactive: true, ask },
    );

    expect(trusted).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it("defaults unseen non-interactive projects to plan mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "squad-trust-"));
    expect(
      await ensureProjectTrust(cwd, settings(), { interactive: false }),
    ).toBe(false);
    expect(projectDefaultMode(undefined, false, "act")).toBe("plan");
    expect(projectDefaultMode(undefined, true, "act")).toBe("act");
    expect(projectDefaultMode("act", false, "plan")).toBe("act");
  });
});
