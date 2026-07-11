import { describe, expect, it } from "vitest";
import {
  BELL,
  CLEAR_TITLE_SEQUENCE,
  deriveTabTitle,
  tabTitleSequence,
} from "../src/cli/tab-title.js";

describe("deriveTabTitle", () => {
  it("returns Permission needed when a prompt is pending, regardless of activity", () => {
    expect(
      deriveTabTitle({ pendingPermission: true, activityKind: "idle" }),
    ).toBe("Squad ▸ Permission needed");
    expect(
      deriveTabTitle({ pendingPermission: true, activityKind: "tool" }),
    ).toBe("Squad ▸ Permission needed");
  });

  it("returns Ready when idle and no permission pending", () => {
    expect(
      deriveTabTitle({ pendingPermission: false, activityKind: "idle" }),
    ).toBe("Squad ▸ Ready");
  });

  it("returns Working when thinking, responding, or tool", () => {
    expect(
      deriveTabTitle({ pendingPermission: false, activityKind: "thinking" }),
    ).toBe("Squad ▸ Working");
    expect(
      deriveTabTitle({ pendingPermission: false, activityKind: "responding" }),
    ).toBe("Squad ▸ Working");
    expect(
      deriveTabTitle({ pendingPermission: false, activityKind: "tool" }),
    ).toBe("Squad ▸ Working");
  });
});

describe("tabTitleSequence", () => {
  it("wraps the title in OSC 2 / BEL", () => {
    expect(tabTitleSequence("hello")).toBe("\x1b]2;hello\x07");
  });
});

describe("constants", () => {
  it("BELL is the ASCII bell character", () => {
    expect(BELL).toBe("\x07");
  });

  it("CLEAR_TITLE_SEQUENCE writes an empty OSC 2 string", () => {
    expect(CLEAR_TITLE_SEQUENCE).toBe("\x1b]2;\x07");
  });
});
