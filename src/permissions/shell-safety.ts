import { existsSync, realpathSync } from "node:fs";
import { delimiter, posix, resolve, win32 } from "node:path";
import type { SyntaxNode } from "web-tree-sitter";
import { createParser } from "../repomap/parser.js";

export interface ShellSafetyOptions {
  cwd?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface ParsedShellToken {
  value: string;
}

export interface ParsedShellCommand {
  executable: ParsedShellToken;
  args: ParsedShellToken[];
}

export interface ParsedShellProgram {
  commands: ParsedShellCommand[];
}

const bashParser = await createParser("bash");

const ALLOWED_BASH_NODES = new Set([
  "program",
  "list",
  "pipeline",
  "command",
  "command_name",
  "word",
  "number",
  "string",
  "string_content",
  "raw_string",
  '"',
  "&&",
  "||",
  ";",
  "|",
]);

const ALLOWED_OPERATORS = new Set(["&&", "||", ";", "|"]);

function literalNodeValue(node: SyntaxNode): string | null {
  if (node.type === "word" || node.type === "number") {
    return node.text.replace(/\\(.)/gs, "$1");
  }
  if (node.type === "raw_string") {
    return node.text.length >= 2 ? node.text.slice(1, -1) : null;
  }
  if (node.type !== "string") return null;
  let out = "";
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child || child.type === '"') continue;
    if (child.type !== "string_content") return null;
    out += child.text;
  }
  return out;
}

function bashTreeIsLiteral(node: SyntaxNode): boolean {
  if (node.type === "ERROR" || node.isMissing || node.hasError) return false;
  if (!ALLOWED_BASH_NODES.has(node.type)) return false;
  if (
    (node.type === "&&" ||
      node.type === "||" ||
      node.type === ";" ||
      node.type === "|") &&
    !ALLOWED_OPERATORS.has(node.type)
  ) {
    return false;
  }
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (!child || !bashTreeIsLiteral(child)) return false;
  }
  return true;
}

function directChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

function parseBashLiteral(command: string): ParsedShellProgram | null {
  if (!bashParser || /[\r\n]/.test(command)) return null;
  const tree = bashParser.parse(command);
  if (!tree) return null;
  try {
    const root = tree.rootNode;
    if (
      root.type !== "program" ||
      root.text.trim().length === 0 ||
      !bashTreeIsLiteral(root)
    ) {
      return null;
    }
    const commandNodes: SyntaxNode[] = [];
    const visit = (node: SyntaxNode): void => {
      if (node.type === "command") {
        commandNodes.push(node);
        return;
      }
      for (let i = 0; i < node.childCount; i += 1) {
        const child = node.child(i);
        if (child) visit(child);
      }
    };
    visit(root);
    const commands: ParsedShellCommand[] = [];
    for (const commandNode of commandNodes) {
      const nameNode = directChild(commandNode, "command_name");
      const nameLiteral = nameNode?.child(0);
      if (!nameLiteral) return null;
      const executable = literalNodeValue(nameLiteral);
      if (!executable) return null;
      const args: ParsedShellToken[] = [];
      for (let i = 0; i < commandNode.childCount; i += 1) {
        const child = commandNode.child(i);
        if (!child || child.type === "command_name") continue;
        const value = literalNodeValue(child);
        if (value === null) return null;
        args.push({ value });
      }
      commands.push({ executable: { value: executable }, args });
    }
    return commands.length > 0 ? { commands } : null;
  } finally {
    tree.delete();
  }
}

function parsePowerShellLiteral(command: string): ParsedShellProgram | null {
  if (command.trim().length === 0 || /[\r\n\0]/.test(command)) return null;
  const commands: ParsedShellCommand[] = [];
  let current: string[] = [];
  let token = "";
  let quote: "single" | "double" | null = null;

  const pushToken = (): void => {
    if (token.length > 0) current.push(token);
    token = "";
  };
  const pushCommand = (): boolean => {
    pushToken();
    const [executable, ...args] = current;
    current = [];
    if (!executable || /^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) {
      return false;
    }
    commands.push({
      executable: { value: executable },
      args: args.map((value) => ({ value })),
    });
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";
    if (quote === "single") {
      if (ch === "'") quote = null;
      else token += ch;
      continue;
    }
    if (quote === "double") {
      if (ch === '"') quote = null;
      else {
        if (ch === "$" || ch === "`") return null;
        token += ch;
      }
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    if (ch === "&" || ch === "|") {
      const pair = command.slice(i, i + 2);
      if (pair === "&&" || pair === "||") i += 1;
      else if (ch === "&") return null;
      if (!pushCommand()) return null;
      continue;
    }
    if (ch === ";") {
      if (!pushCommand()) return null;
      continue;
    }
    // shortcut: PowerShell parsing is a conservative literal-word ceiling.
    // Replace this lexer with an in-process PowerShell AST when Node exposes
    // one without spawning the very shell this boundary is deciding on.
    if (
      ch === "$" ||
      ch === "`" ||
      ch === ">" ||
      ch === "<" ||
      ch === "(" ||
      ch === ")" ||
      ch === "{" ||
      ch === "}" ||
      ch === "[" ||
      ch === "]" ||
      ch === "#" ||
      ch === "%" ||
      ch === "@"
    ) {
      return null;
    }
    token += ch;
  }
  if (quote !== null || !pushCommand()) return null;
  return commands.length > 0 ? { commands } : null;
}

export function parseLiteralShellCommand(
  command: string,
  opts: ShellSafetyOptions = {},
): ParsedShellProgram | null {
  return (opts.platform ?? process.platform) === "win32"
    ? parsePowerShellLiteral(command)
    : parseBashLiteral(command);
}

const READ_ONLY_COMMANDS = new Set([
  "git",
  "ls",
  "dir",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "echo",
  "printf",
  "whoami",
  "hostname",
  "date",
  "uname",
  "which",
  "type",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "printenv",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "id",
  "groups",
  "uptime",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "sed",
  "base64",
  "sort",
  "uniq",
  "cut",
  "nl",
  "tac",
  "comm",
  "cmp",
  "diff",
  "column",
  "fold",
  "rev",
  "tr",
  "expand",
  "sha256sum",
  "sha1sum",
  "md5sum",
  "cksum",
  "jq",
  "yq",
  "cd",
  "chdir",
  "true",
  "false",
  "get-childitem",
  "gci",
  "get-content",
  "gc",
  "get-location",
  "gl",
  "get-item",
  "get-itemproperty",
  "get-command",
  "gcm",
  "get-help",
  "get-process",
  "get-date",
  "get-host",
  "get-member",
  "gm",
  "get-alias",
  "get-history",
  "get-module",
  "get-variable",
  "select-object",
  "select",
  "where-object",
  "where",
  "measure-object",
  "measure",
  "sort-object",
  "group-object",
  "format-table",
  "ft",
  "format-list",
  "fl",
  "format-wide",
  "write-output",
  "write-host",
  "select-string",
  "sls",
  "test-path",
  "resolve-path",
  "split-path",
  "join-path",
  "out-string",
  "out-host",
  "compare-object",
  "convertto-json",
  "convertfrom-json",
  "set-location",
  "sl",
  "push-location",
  "pop-location",
]);

const SHELL_BUILTINS = new Set([
  "cd",
  "chdir",
  "echo",
  "printf",
  "pwd",
  "true",
  "false",
  "type",
]);

const POWERSHELL_BUILTINS = new Set([
  "ls",
  "dir",
  "pwd",
  "cat",
  "get-childitem",
  "gci",
  "get-content",
  "gc",
  "get-location",
  "gl",
  "get-item",
  "get-itemproperty",
  "get-command",
  "gcm",
  "get-help",
  "get-process",
  "get-date",
  "get-host",
  "get-member",
  "gm",
  "get-alias",
  "get-history",
  "get-module",
  "get-variable",
  "select-object",
  "select",
  "where-object",
  "where",
  "measure-object",
  "measure",
  "sort-object",
  "group-object",
  "format-table",
  "ft",
  "format-list",
  "fl",
  "format-wide",
  "write-output",
  "write-host",
  "select-string",
  "sls",
  "test-path",
  "resolve-path",
  "split-path",
  "join-path",
  "out-string",
  "out-host",
  "compare-object",
  "convertto-json",
  "convertfrom-json",
  "set-location",
  "sl",
  "push-location",
  "pop-location",
]);

const DANGEROUS_EXECUTABLES = new Set([
  "rm",
  "sudo",
  "doas",
  "sh",
  "bash",
  "zsh",
  "cmd",
  "powershell",
  "pwsh",
  "python",
  "node",
  "perl",
  "ruby",
]);

const GIT_READ_ONLY = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "blame",
  "shortlog",
  "describe",
  "cat-file",
  "name-rev",
  "merge-base",
  "reflog",
  "whatchanged",
  "count-objects",
  "grep",
  "version",
  "show-ref",
  "for-each-ref",
  "symbolic-ref",
  "check-ignore",
  "check-attr",
  "var",
]);

interface ExecutableIdentity {
  name: string;
  safeListEligible: boolean;
}

function normalizedName(value: string): string {
  const leaf = value.split(/[\\/]/).pop() ?? value;
  return leaf.replace(/\.(exe|cmd|bat|com)$/i, "").toLowerCase();
}

function pathIsWithin(
  root: string,
  target: string,
  pathApi: typeof posix | typeof win32,
): boolean {
  const rel = pathApi.relative(root, target);
  return (
    rel === "" ||
    (!pathApi.isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${pathApi.sep}`))
  );
}

function resolveFromPath(
  value: string,
  opts: ShellSafetyOptions,
): string | null {
  const env = opts.env ?? process.env;
  const isWindowsHost = process.platform === "win32";
  const extensions = isWindowsHost
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter((extension) => /^\.(com|exe|bat|cmd)$/i.test(extension))
    : [""];
  const candidates: string[] = [];
  const bases = [
    ...(opts.cwd ? [opts.cwd] : []),
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter((part) => part.length > 0)
      .map((part) => resolve(opts.cwd ?? process.cwd(), part)),
  ];
  for (const part of bases) {
    candidates.push(resolve(part, value));
    for (const extension of extensions) {
      candidates.push(resolve(part, `${value}${extension.toLowerCase()}`));
      if (isWindowsHost)
        candidates.push(resolve(part, `${value}${extension.toUpperCase()}`));
    }
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) return null;
  try {
    return realpathSync.native(found);
  } catch {
    return null;
  }
}

// One normalization path feeds both the danger list and the safe list. A
// relative executable path is never eligible, and an absolute/bare executable
// that resolves inside the workspace is treated as project code, not as a
// trusted system command.
function normalizeExecutable(
  value: string,
  opts: ShellSafetyOptions,
): ExecutableIdentity {
  const name = normalizedName(value);
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === "win32";
  const pathApi = isWindows ? win32 : posix;
  const hasPath = /[\\/]/.test(value) || pathApi.isAbsolute(value);
  const cwd = opts.cwd ? pathApi.resolve(opts.cwd) : undefined;

  if (hasPath) {
    if (!pathApi.isAbsolute(value)) return { name, safeListEligible: false };
    let canonical: string;
    try {
      canonical = realpathSync.native(value);
    } catch {
      return { name, safeListEligible: false };
    }
    if (
      cwd &&
      pathIsWithin(pathApi.resolve(cwd), pathApi.resolve(canonical), pathApi)
    ) {
      return { name, safeListEligible: false };
    }
    const trusted = resolveFromPath(name, opts);
    if (!trusted || realpathSync.native(trusted) !== canonical) {
      return { name, safeListEligible: false };
    }
    return { name, safeListEligible: true };
  }

  const builtIn = isWindows
    ? POWERSHELL_BUILTINS.has(name)
    : SHELL_BUILTINS.has(name);
  const resolved = resolveFromPath(value, opts);
  if (!resolved) return { name, safeListEligible: builtIn };
  const hostPathApi = process.platform === "win32" ? win32 : posix;
  if (
    opts.cwd &&
    hostPathApi.isAbsolute(opts.cwd) &&
    pathIsWithin(
      hostPathApi.resolve(opts.cwd),
      hostPathApi.resolve(resolved),
      hostPathApi,
    )
  ) {
    return { name, safeListEligible: false };
  }
  return { name, safeListEligible: true };
}

const PATH_CHANGING = new Set([
  "cd",
  "chdir",
  "set-location",
  "sl",
  "push-location",
  "pop-location",
]);

function outsideProjectPath(value: string, opts: ShellSafetyOptions): boolean {
  const platform = opts.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  const absolute = pathApi.isAbsolute(value);
  const climbs =
    value === ".." ||
    value.startsWith("../") ||
    value.startsWith("..\\") ||
    value.includes("/../") ||
    value.includes("\\..\\");
  if (!absolute && !climbs) return false;
  if (!opts.cwd) return true;
  const root = pathApi.resolve(opts.cwd);
  const target = absolute
    ? pathApi.resolve(value)
    : pathApi.resolve(root, value);
  const rel = pathApi.relative(root, target);
  return (
    pathApi.isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${pathApi.sep}`)
  );
}

function hasUnsafePathOperand(
  name: string,
  args: readonly ParsedShellToken[],
  opts: ShellSafetyOptions,
): boolean {
  if (PATH_CHANGING.has(name) && args.length > 0) return true;
  return args.some(
    ({ value }) =>
      value.length > 0 &&
      !value.startsWith("-") &&
      outsideProjectPath(value, opts),
  );
}

function gitIsReadOnly(args: readonly ParsedShellToken[]): boolean {
  const values = args.map(({ value }) => value.toLowerCase());
  if (
    values.some((value) => value === "--textconv" || value === "--ext-diff")
  ) {
    return false;
  }
  if (values[0] === "--version") return values.length === 1;
  let index = 0;
  while (values[index]?.startsWith("-")) {
    const option = values[index];
    if (option !== "--no-pager") return false;
    index += 1;
  }
  const subcommand = values[index];
  return subcommand !== undefined && GIT_READ_ONLY.has(subcommand);
}

function commandFlagsAreReadOnly(
  name: string,
  args: readonly ParsedShellToken[],
): boolean {
  const values = args.map(({ value }) => value.toLowerCase());
  if (name === "git") return gitIsReadOnly(args);
  if (name === "find") {
    return !values.some((value) =>
      [
        "-exec",
        "-execdir",
        "-ok",
        "-okdir",
        "-delete",
        "-fprint",
        "-fls",
      ].includes(value),
    );
  }
  if (name === "sed") {
    return (
      values.some(
        (value) => value === "-n" || /^-[a-z]*n[a-z]*$/i.test(value),
      ) && !values.some((value) => /^-i/i.test(value) || value === "--in-place")
    );
  }
  if (name === "rg") {
    return !values.some(
      (value) => value === "--pre" || value.startsWith("--pre="),
    );
  }
  if (name === "base64") {
    return !values.some(
      (value) =>
        value === "-o" ||
        value.startsWith("-o") ||
        value === "--output" ||
        value.startsWith("--output="),
    );
  }
  if (name === "sort") {
    return !values.some(
      (value) =>
        value.startsWith("-o") ||
        value === "--output" ||
        value.startsWith("--output="),
    );
  }
  if (name === "yq") {
    return !values.some(
      (value) =>
        value === "-i" || value === "--inplace" || value === "--in-place",
    );
  }
  return true;
}

export function classifyShellCommand(
  command: string,
  opts: ShellSafetyOptions = {},
): "allow" | "ask" {
  const parsed = parseLiteralShellCommand(command, opts);
  if (!parsed) return "ask";
  for (const parsedCommand of parsed.commands) {
    const executable = normalizeExecutable(
      parsedCommand.executable.value,
      opts,
    );
    if (DANGEROUS_EXECUTABLES.has(executable.name)) return "ask";
    if (
      !executable.safeListEligible ||
      !READ_ONLY_COMMANDS.has(executable.name)
    ) {
      return "ask";
    }
    if (hasUnsafePathOperand(executable.name, parsedCommand.args, opts)) {
      return "ask";
    }
    if (!commandFlagsAreReadOnly(executable.name, parsedCommand.args)) {
      return "ask";
    }
  }
  return "allow";
}
