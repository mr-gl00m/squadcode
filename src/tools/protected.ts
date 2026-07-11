import { homedir } from "node:os";
import { posix as pathPosix, win32 as pathWin32 } from "node:path";

const DARWIN_HOME_PROTECTED = [
  "Music",
  "Pictures",
  "Movies",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Cookies",
  "Library/Application Support/com.apple.TCC",
  "Library/Application Support/AddressBook",
];

const DARWIN_ROOT_PROTECTED = ["/.Spotlight-V100", "/.fseventsd", "/.Trashes"];

const WIN32_HOME_PROTECTED = ["AppData", "OneDrive"];

export interface IsProtectedOptions {
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
  access?: "read" | "write";
  allowProjectMetadataWrite?: boolean;
}

function isUnderDir(
  protectedDir: string,
  candidate: string,
  caseInsensitive: boolean,
  sep: string,
): boolean {
  const a = caseInsensitive ? protectedDir.toLowerCase() : protectedDir;
  const b = caseInsensitive ? candidate.toLowerCase() : candidate;
  if (a === b) return true;
  return b.startsWith(a + sep);
}

function findContainingProtectedDir(
  absolutePath: string,
  platform: NodeJS.Platform,
  home: string,
): string | null {
  if (platform === "darwin") {
    const sep = "/";
    for (const seg of DARWIN_HOME_PROTECTED) {
      const dir = pathPosix.join(home, seg);
      if (isUnderDir(dir, absolutePath, false, sep)) return dir;
    }
    for (const dir of DARWIN_ROOT_PROTECTED) {
      if (isUnderDir(dir, absolutePath, false, sep)) return dir;
    }
    return null;
  }
  if (platform === "win32") {
    const sep = "\\";
    for (const seg of WIN32_HOME_PROTECTED) {
      const dir = pathWin32.join(home, ...seg.split("/"));
      if (isUnderDir(dir, absolutePath, true, sep)) return dir;
    }
    return null;
  }
  return null;
}

export function isProtectedPath(
  absolutePath: string,
  opts: IsProtectedOptions = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  if (
    opts.access === "write" &&
    opts.cwd !== undefined &&
    opts.allowProjectMetadataWrite !== true
  ) {
    const pathApi = platform === "win32" ? pathWin32 : pathPosix;
    const caseInsensitive = platform === "win32";
    for (const name of [".git", ".squad"]) {
      const metadataDir = pathApi.join(opts.cwd, name);
      if (isUnderDir(metadataDir, absolutePath, caseInsensitive, pathApi.sep)) {
        return true;
      }
    }
  }
  const containing = findContainingProtectedDir(absolutePath, platform, home);
  if (containing === null) return false;
  if (opts.cwd !== undefined) {
    const cwdContaining = findContainingProtectedDir(opts.cwd, platform, home);
    if (cwdContaining === containing) return false;
  }
  return true;
}
