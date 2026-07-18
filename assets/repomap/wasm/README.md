# Vendored tree-sitter WASM grammars

These are precompiled tree-sitter language parsers, loaded at runtime by
`src/repomap/parser.ts` via `web-tree-sitter`. They are committed to the
repo so downstream installs don't depend on `tree-sitter-wasms` (which is
~52MB unpacked).

To refresh:

```
node scripts/refresh-repomap-wasm.mjs
```

That script does a `npm install --no-save tree-sitter-wasms`, copies the
five WASMs we care about into this directory, and leaves `package.json`
untouched.

Supported languages: TypeScript, TSX, JavaScript, Python, Rust, Go, and Bash.
The Bash grammar is shared by the parsed permission and YOLO path guards.
