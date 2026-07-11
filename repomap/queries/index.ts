import type { Language } from "../types.js";
import { GO_QUERY } from "./go.js";
import { JAVASCRIPT_QUERY } from "./javascript.js";
import { PYTHON_QUERY } from "./python.js";
import { RUST_QUERY } from "./rust.js";
import { TSX_QUERY, TYPESCRIPT_QUERY } from "./typescript.js";

export function queryForLanguage(lang: Language): string {
  switch (lang) {
    case "typescript":
      return TYPESCRIPT_QUERY;
    case "tsx":
      return TSX_QUERY;
    case "javascript":
      return JAVASCRIPT_QUERY;
    case "python":
      return PYTHON_QUERY;
    case "rust":
      return RUST_QUERY;
    case "go":
      return GO_QUERY;
  }
}
