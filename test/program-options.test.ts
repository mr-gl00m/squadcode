import { describe, expect, it } from "vitest";
import { parseOnOff, runtimeCliConfig } from "../src/cli/program-options.js";

describe("notification sound CLI option", () => {
  it("parses on and off case-insensitively", () => {
    expect(parseOnOff("ON")).toBe(true);
    expect(parseOnOff("off")).toBe(false);
  });

  it("rejects other values", () => {
    expect(() => parseOnOff("maybe")).toThrow('expected "on" or "off"');
  });

  it("forwards an explicit override into runtime configuration", () => {
    expect(runtimeCliConfig({ notificationSound: false })).toEqual({
      notificationSound: false,
    });
  });
});
