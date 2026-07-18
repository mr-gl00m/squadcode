// Renders a captured ANSI terminal frame to an SVG image: parse SGR codes
// into styled runs, lay the runs on a monospace grid, and wrap the grid in a
// minimal terminal window. textLength pins every run to the grid so box
// borders stay aligned even where a glyph falls back to another font.

const TERM_BG = "#0c0c0c";
const TERM_FG = "#cccccc";
const PAGE_BG = "#171b21";
const BAR_BG = "#1b1f26";
const BORDER = "#30363d";

// Campbell palette, the Windows Terminal default.
const NAMED = {
  30: "#0c0c0c",
  31: "#c50f1f",
  32: "#13a10e",
  33: "#c19c00",
  34: "#0037da",
  35: "#881798",
  36: "#3a96dd",
  37: "#cccccc",
  90: "#767676",
  91: "#e74856",
  92: "#16c60c",
  93: "#f9f1a5",
  94: "#3b78ff",
  95: "#b4009e",
  96: "#61d6d6",
  97: "#f2f2f2",
};

const FONT =
  "'Cascadia Mono', 'Cascadia Code', Consolas, 'DejaVu Sans Mono', monospace";

function hex(r, g, b) {
  const part = (v) =>
    Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function color256(n) {
  if (n < 16) {
    const base = [
      30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97,
    ];
    return NAMED[base[n]] ?? TERM_FG;
  }
  if (n < 232) {
    const idx = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return hex(
      steps[Math.floor(idx / 36) % 6],
      steps[Math.floor(idx / 6) % 6],
      steps[idx % 6],
    );
  }
  const gray = 8 + (n - 232) * 10;
  return hex(gray, gray, gray);
}

function freshStyle() {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    inverse: false,
  };
}

function applySgr(style, params) {
  const codes = params.length === 0 ? [0] : params;
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) Object.assign(style, freshStyle());
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 7) style.inverse = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 27) style.inverse = false;
    else if (code === 39) style.fg = null;
    else if (code === 49) style.bg = null;
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      style.fg = NAMED[code];
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      style.bg = NAMED[code - 10];
    } else if (code === 38 || code === 48) {
      const target = code === 38 ? "fg" : "bg";
      if (codes[i + 1] === 2) {
        style[target] = hex(
          codes[i + 2] ?? 0,
          codes[i + 3] ?? 0,
          codes[i + 4] ?? 0,
        );
        i += 4;
      } else if (codes[i + 1] === 5) {
        style[target] = color256(codes[i + 2] ?? 0);
        i += 2;
      }
    }
  }
}

// Parse the whole frame into per-line runs. SGR state carries across
// newlines, so lines dropped later by the viewport still advance the state.
export function parseAnsiFrame(frame) {
  const style = freshStyle();
  const lines = [];
  let runs = [];
  let col = 0;
  let text = "";
  let runStyle = { ...style };

  const flushRun = () => {
    if (text.length > 0) {
      runs.push({ col: col - [...text].length, text, style: runStyle });
      text = "";
    }
  };
  const flushLine = () => {
    flushRun();
    lines.push(runs);
    runs = [];
    col = 0;
    runStyle = { ...style };
  };

  const pattern = /\x1b\[([0-9;]*)m|\n/g;
  let cursor = 0;
  for (
    let match = pattern.exec(frame);
    match !== null;
    match = pattern.exec(frame)
  ) {
    const chunk = frame.slice(cursor, match.index);
    for (const ch of chunk) {
      text += ch;
      col += 1;
    }
    cursor = pattern.lastIndex;
    if (match[0] === "\n") {
      flushLine();
    } else {
      flushRun();
      applySgr(
        style,
        match[1]
          .split(";")
          .filter((p) => p !== "")
          .map(Number),
      );
      runStyle = { ...style };
    }
  }
  for (const ch of frame.slice(cursor)) {
    text += ch;
    col += 1;
  }
  flushLine();
  return lines;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Block elements draw as rects spanning the full cell: font glyphs leave
// antialiasing seams between adjacent blocks and stop short of the line
// height, which reads as banding across the banner and anguish meters.
const BLOCKS = {
  "█": { top: 0, height: 1, opacity: 1 },
  "▀": { top: 0, height: 0.5, opacity: 1 },
  "▄": { top: 0.5, height: 0.5, opacity: 1 },
  "░": { top: 0, height: 1, opacity: 0.28 },
  "▒": { top: 0, height: 1, opacity: 0.5 },
  "▓": { top: 0, height: 1, opacity: 0.72 },
};

export function ansiFrameToSvg(frame, opts) {
  const { cols, rows, fontSize, charWidth, lineHeight, title } = opts;
  const padX = 22;
  const padTop = 12;
  const padBottom = 14;
  const barHeight = 34;
  const width = cols * charWidth + padX * 2;
  const height = barHeight + padTop + rows * lineHeight + padBottom;

  const parsed = parseAnsiFrame(frame);
  // Terminal viewport: overflow scrolls the top of the buffer out of view.
  const visible =
    parsed.length > rows ? parsed.slice(parsed.length - rows) : parsed;

  const rects = [];
  const texts = [];
  for (let row = 0; row < visible.length; row += 1) {
    const y = barHeight + padTop + row * lineHeight;
    const baseline = y + Math.round(lineHeight * 0.78);
    for (const run of visible[row]) {
      const runChars = [...run.text];
      const x = padX + run.col * charWidth;
      const runWidth = runChars.length * charWidth;
      const s = run.style;
      let fg = s.fg ?? TERM_FG;
      let bg = s.bg;
      if (s.inverse) {
        bg = s.fg ?? TERM_FG;
        fg = s.bg ?? TERM_BG;
      }
      if (bg !== null && bg !== undefined) {
        rects.push(
          `<rect x="${x}" y="${y}" width="${runWidth}" height="${lineHeight}" fill="${bg}"/>`,
        );
      }
      if (run.text.trim().length === 0) continue;
      const dimFactor = s.dim ? 0.55 : 1;
      // Split the run into block segments (drawn as rects) and text
      // segments. Contiguous same-shape blocks merge into one rect so no
      // seams appear inside a bar.
      let segStart = 0;
      while (segStart < runChars.length) {
        const block = BLOCKS[runChars[segStart]];
        let segEnd = segStart + 1;
        if (block) {
          while (
            segEnd < runChars.length &&
            BLOCKS[runChars[segEnd]] === block
          ) {
            segEnd += 1;
          }
          const opacity = block.opacity * dimFactor;
          rects.push(
            `<rect x="${x + segStart * charWidth}" y="${y + block.top * lineHeight}" width="${(segEnd - segStart) * charWidth}" height="${block.height * lineHeight}" fill="${fg}"${opacity < 1 ? ` opacity="${opacity}"` : ""}/>`,
          );
        } else {
          while (
            segEnd < runChars.length &&
            BLOCKS[runChars[segEnd]] === undefined
          ) {
            segEnd += 1;
          }
          const segText = runChars.slice(segStart, segEnd).join("");
          if (segText.trim().length > 0) {
            const attrs = [
              `x="${x + segStart * charWidth}"`,
              `y="${baseline}"`,
              `fill="${fg}"`,
              `textLength="${(segEnd - segStart) * charWidth}"`,
              `lengthAdjust="spacingAndGlyphs"`,
              `xml:space="preserve"`,
            ];
            if (s.bold) attrs.push('font-weight="700"');
            if (s.italic) attrs.push('font-style="italic"');
            if (s.dim) attrs.push('opacity="0.55"');
            texts.push(`<text ${attrs.join(" ")}>${escapeXml(segText)}</text>`);
          }
        }
        segStart = segEnd;
      }
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${PAGE_BG}"/>`,
    `<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="10" fill="${TERM_BG}" stroke="${BORDER}"/>`,
    `<path d="M11 1 H${width - 11} A10 10 0 0 1 ${width - 1} 11 V${barHeight} H1 V11 A10 10 0 0 1 11 1 Z" fill="${BAR_BG}"/>`,
    `<line x1="1" y1="${barHeight}" x2="${width - 1}" y2="${barHeight}" stroke="${BORDER}"/>`,
    `<circle cx="24" cy="${barHeight / 2}" r="5.5" fill="#f7768e"/>`,
    `<circle cx="44" cy="${barHeight / 2}" r="5.5" fill="#e0af68"/>`,
    `<circle cx="64" cy="${barHeight / 2}" r="5.5" fill="#9ece6a"/>`,
    `<text x="${width / 2}" y="${barHeight / 2 + 4}" fill="#7d8590" font-size="12" text-anchor="middle" font-family="${FONT}">${escapeXml(title)}</text>`,
    `<g font-family="${FONT}" font-size="${fontSize}">`,
    ...rects,
    ...texts,
    "</g>",
    "</svg>",
  ].join("");
}
