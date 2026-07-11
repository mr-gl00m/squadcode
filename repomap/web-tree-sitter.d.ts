// web-tree-sitter@0.25 ships type declarations but doesn't expose them via
// the package.json "exports" field, so TS NodeNext resolution can't find
// them. Mirror the narrow subset we use. Refresh if the package surface
// changes when bumping versions.
//
// Locked at 0.25 because 0.26 drops compatibility with the WASM ABI shipped
// by tree-sitter-wasms (see scripts/refresh-repomap-wasm.mjs).

declare module "web-tree-sitter" {
  export interface Point {
    row: number;
    column: number;
  }

  export interface SyntaxNode {
    text: string;
    type: string;
    startPosition: Point;
    endPosition: Point;
    childCount: number;
    isMissing: boolean;
    hasError: boolean;
    child(index: number): SyntaxNode | null;
  }

  export interface Tree {
    rootNode: SyntaxNode;
    delete(): void;
  }

  export interface QueryCapture {
    name: string;
    node: SyntaxNode;
  }

  export interface QueryMatch {
    pattern: number;
    captures: QueryCapture[];
  }

  export class Parser {
    static init(): Promise<void>;
    constructor();
    delete(): void;
    parse(input: string): Tree | null;
    setLanguage(language: Language): void;
  }

  export class Language {
    static load(input: string | Uint8Array): Promise<Language>;
    readonly name?: string;
  }

  export class Query {
    constructor(language: Language, source: string);
    matches(node: SyntaxNode): QueryMatch[];
    delete(): void;
  }
}
