export type Language =
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "rust"
  | "go";

export interface SymbolDef {
  name: string;
  kind: string;
  line: number;
  endLine: number;
}

export interface SymbolRef {
  name: string;
  line: number;
}

export interface FileSymbols {
  path: string;
  lang: Language;
  mtimeMs: number;
  size: number;
  defs: SymbolDef[];
  refs: SymbolRef[];
}

export interface RepoMapOptions {
  cwd: string;
  tokenBudget: number;
  chatFiles?: string[];
  mentionedIdentifiers?: string[];
  refresh?: "auto" | "always" | "files" | "manual";
  cacheDir?: string;
  maxFileBytes?: number;
}

export interface RepoMapResult {
  text: string;
  fileMentions: string[];
  filesConsidered: number;
  filesIncluded: number;
  estimatedTokens: number;
}
