import { promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isProtectedPath } from "./protected.js";

class PathValidationError extends Error {
  override readonly name = "PathValidationError";
}

export interface ValidatePathOptions {
  root: string;
  mustExist?: boolean;
  access?: "read" | "write";
  allowProjectMetadataWrite?: boolean;
  // Additional directories outside `root` whose subtrees are also allowed.
  // Used by Read to permit paths under `~/.squad/sessions/<id>/artifacts/`
  // even though the artifact dir lives outside cwd.
  extraAllowedRoots?: string[];
}

function isUnderRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`)) return false;
  return true;
}

async function resolveExtraRoots(
  paths: string[] | undefined,
): Promise<string[]> {
  if (!paths || paths.length === 0) return [];
  const out: string[] = [];
  for (const p of paths) {
    try {
      out.push(await fs.realpath(resolve(p)));
    } catch {
      // Extra root that doesn't exist on disk is harmless — just skip it.
    }
  }
  return out;
}

function isUnderAnyRoot(roots: string[], candidate: string): boolean {
  for (const r of roots) if (isUnderRoot(r, candidate)) return true;
  return false;
}

export async function resolveAndValidate(
  inputPath: string,
  opts: ValidatePathOptions,
): Promise<string> {
  const rootReal = await fs.realpath(resolve(opts.root));
  const extraRoots = await resolveExtraRoots(opts.extraAllowedRoots);
  const absolute = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(opts.root, inputPath);

  if (opts.mustExist) {
    const real = await fs.realpath(absolute);
    const insideExtra = isUnderAnyRoot(extraRoots, real);
    if (!isUnderRoot(rootReal, real) && !insideExtra) {
      throw new PathValidationError(
        `path "${inputPath}" resolves outside allowed root "${rootReal}"`,
      );
    }
    if (
      !insideExtra &&
      isProtectedPath(real, {
        cwd: rootReal,
        access: opts.access ?? "read",
        allowProjectMetadataWrite: opts.allowProjectMetadataWrite ?? false,
      })
    ) {
      throw new PathValidationError(
        `path "${inputPath}" resolves to a protected directory (${real}); refusing to scan OS-sensitive paths`,
      );
    }
    return real;
  }

  const suffixParts: string[] = [];
  let prefix = absolute;
  while (true) {
    let realPrefix: string;
    try {
      realPrefix = await fs.realpath(prefix);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      const parent = dirname(prefix);
      if (parent === prefix) {
        throw new PathValidationError(
          `path "${inputPath}" cannot be resolved against any existing parent directory`,
        );
      }
      suffixParts.push(basename(prefix));
      prefix = parent;
      continue;
    }
    const insideExtra = isUnderAnyRoot(extraRoots, realPrefix);
    if (!isUnderRoot(rootReal, realPrefix) && !insideExtra) {
      throw new PathValidationError(
        `path "${inputPath}" resolves outside allowed root "${rootReal}" (parent "${realPrefix}")`,
      );
    }
    const finalPath =
      suffixParts.length === 0
        ? realPrefix
        : join(realPrefix, ...suffixParts.reverse());
    if (
      !insideExtra &&
      isProtectedPath(finalPath, {
        cwd: rootReal,
        access: opts.access ?? "read",
        allowProjectMetadataWrite: opts.allowProjectMetadataWrite ?? false,
      })
    ) {
      throw new PathValidationError(
        `path "${inputPath}" resolves to a protected directory (${finalPath}); refusing to write to OS-sensitive paths`,
      );
    }
    return finalPath;
  }
}
