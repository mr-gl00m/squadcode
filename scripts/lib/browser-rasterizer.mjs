import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  for (const command of ["google-chrome", "chromium", "chromium-browser"]) {
    const result = spawnSync(command, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return command;
  }
  throw new Error(
    "Chrome or Edge is required. Set CHROME_PATH to the browser executable.",
  );
}

async function readDevToolsPort(profileDir) {
  const portFile = resolve(profileDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      if (port) return port;
    }
    await delay(25);
  }
  throw new Error("Browser did not open its DevTools port.");
}

async function openPageSocket(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolveOpen, rejectOpen) => {
          socket.addEventListener("open", resolveOpen, { once: true });
          socket.addEventListener("error", rejectOpen, { once: true });
        });
        return socket;
      }
    } catch {
      await delay(25);
    }
  }
  throw new Error("Browser DevTools page target was unavailable.");
}

function createCdpClient(socket) {
  let nextId = 1;
  const pending = new Map();
  const eventWaiters = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    const waiters = eventWaiters.get(message.method);
    if (!waiters || waiters.length === 0) return;
    eventWaiters.delete(message.method);
    for (const resolveEvent of waiters) resolveEvent(message.params);
  });
  return {
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveMessage, rejectMessage) => {
        pending.set(id, { resolve: resolveMessage, reject: rejectMessage });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    waitFor(method) {
      return new Promise((resolveEvent) => {
        const waiters = eventWaiters.get(method) ?? [];
        waiters.push(resolveEvent);
        eventWaiters.set(method, waiters);
      });
    },
  };
}

export async function rasterizeSvgFrames({
  outputDir,
  frameCount,
  width,
  height,
  svgAt,
}) {
  const profileDir = resolve(outputDir, "browser-profile");
  mkdirSync(profileDir);
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  try {
    const port = await readDevToolsPort(profileDir);
    const socket = await openPageSocket(port);
    const cdp = createCdpClient(socket);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (let index = 0; index < frameCount; index += 1) {
      const url = `data:image/svg+xml;base64,${Buffer.from(svgAt(index)).toString("base64")}`;
      const loaded = cdp.waitFor("Page.loadEventFired");
      await cdp.send("Page.navigate", { url });
      await loaded;
      const screenshot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      const frameName = `frame-${String(index).padStart(4, "0")}.png`;
      writeFileSync(
        resolve(outputDir, frameName),
        Buffer.from(screenshot.data, "base64"),
      );
    }
    socket.close();
  } finally {
    browser.kill();
  }
}
