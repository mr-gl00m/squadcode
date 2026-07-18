// Captures one ANSI frame per timeline step by mounting the scripted scene
// through ink-testing-library, the same harness the snapshot tests use. Each
// frame is an independent mount so no timer or effect state leaks between
// frames.
import { render } from "ink-testing-library";
// Classic-transform requirement, same as demo-scene.tsx.
// biome-ignore lint/correctness/noUnusedImports: JSX below compiles to React.createElement
import React from "react";
import { DemoFrame, FPS, sceneAt, TOTAL_FRAMES } from "./demo-scene.js";

export function renderDemoFrames(): string[] {
  const frames: string[] = [];
  for (let index = 0; index < TOTAL_FRAMES; index += 1) {
    const instance = render(<DemoFrame s={sceneAt(index / FPS)} />);
    frames.push(instance.lastFrame() ?? "");
    instance.unmount();
  }
  return frames;
}
