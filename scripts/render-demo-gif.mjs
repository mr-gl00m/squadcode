// Renders assets/squad-code-demo.gif from the real REPL. The frames come out
// of the actual Ink components in src/cli (mounted via ink-testing-library,
// the snapshot-test harness), so the gif shows what the app renders, not a
// mockup. Pipeline: scripted scene -> ANSI frames -> SVG -> PNG (headless
// Chrome/Edge) -> gif (ffmpeg).
//
// Chalk locks its color level at import, so force truecolor before the scene
// modules load. Both scene imports below stay dynamic for the same reason.
process.env.FORCE_COLOR = "3";

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { ansiFrameToSvg } from "./lib/ansi-svg.mjs";
import { rasterizeSvgFrames } from "./lib/browser-rasterizer.mjs";

const COLS = 100;
const ROWS = 40;
const FONT_SIZE = 14;
const CHAR_WIDTH = 8.4;
const LINE_HEIGHT = 18;
const outputPath = resolve(process.argv[2] ?? "assets/squad-code-demo.gif");

const { register } = await import("tsx/esm/api");
register();
const { renderDemoFrames } = await import("./lib/demo-frames.tsx");
const { FPS } = await import("./lib/demo-scene.tsx");

async function render() {
  const frames = renderDemoFrames();
  const frameDir = mkdtempSync(resolve(tmpdir(), "squad-code-demo-"));
  try {
    await rasterizeSvgFrames({
      outputDir: frameDir,
      frameCount: frames.length,
      width: Math.round(COLS * CHAR_WIDTH + 44),
      height: 34 + 12 + ROWS * LINE_HEIGHT + 14,
      svgAt: (index) =>
        ansiFrameToSvg(frames[index], {
          cols: COLS,
          rows: ROWS,
          fontSize: FONT_SIZE,
          charWidth: CHAR_WIDTH,
          lineHeight: LINE_HEIGHT,
          title: "squadcode",
        }),
    });

    mkdirSync(dirname(outputPath), { recursive: true });
    const filter = [
      `fps=${FPS}`,
      "split[base][palette]",
      "[palette]palettegen=max_colors=128:stats_mode=diff[p]",
      "[base][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    ].join(",");
    const result = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        String(FPS),
        "-i",
        resolve(frameDir, "frame-%04d.png"),
        "-filter_complex",
        filter,
        "-loop",
        "0",
        outputPath,
      ],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`ffmpeg exited with status ${result.status}`);
    }
    process.stdout.write(`Rendered ${frames.length} frames to ${outputPath}\n`);
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

await render();
