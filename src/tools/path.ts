import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class PathValidationError extends Error {
  override readonly name = "PathValidationError";
}

export interface ValidatePathOptions {
  root: string;
  mustExist?: boolean;
}

function isUnderRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (isAbsolute(rel)) return false;
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`)) return false;
  return true;
}

export async function resolveAndValidate(
  inputPath: string,
  opts: ValidatePathOptions,
): Promise<string> {
  const rootReal = await fs.realpath(resolve(opts.root));
  const absolute = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(opts.root, inputPath);

  if (opts.mustExist) {
    const real = await fs.realpath(absolute);
    if (!isUnderRoot(rootReal, real)) {
      throw new PathValidationError(
        `path "${inputPath}" resolves outside allowed root "${rootReal}"`,
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
    if (!isUnderRoot(rootReal, realPrefix)) {
      throw new PathValidationError(
        `path "${inputPath}" resolves outside allowed root "${rootReal}" (parent "${realPrefix}")`,
      );
    }
    if (suffixParts.length === 0) return realPrefix;
    return join(realPrefix, ...suffixParts.reverse());
  }
}
