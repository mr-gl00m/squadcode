import type { PermissionRule } from "./policy.js";

export const SENSITIVE_DEFAULTS: Record<string, PermissionRule[]> = {
  Read: [
    // Auto-allow reading the harness's own session sidecars. When the engine
    // offloads a large tool output to ~/.squad/sessions/<id>/artifacts/, the
    // model needs to Read that file back without a permission prompt.
    { pattern: "**/.squad/sessions/**", action: "allow" },
    { pattern: "**/.env", action: "ask" },
    { pattern: "**/.env.*", action: "ask" },
    { pattern: "**/.env.example", action: "allow" },
    { pattern: "**/.env.sample", action: "allow" },
    { pattern: "**/id_rsa", action: "deny" },
    { pattern: "**/id_ed25519", action: "deny" },
    { pattern: "**/id_ecdsa", action: "deny" },
    { pattern: "**/.ssh/**", action: "deny" },
    { pattern: "**/.aws/credentials", action: "deny" },
    { pattern: "**/.aws/config", action: "ask" },
    { pattern: "**/.gcp/credentials.json", action: "deny" },
    { pattern: "**/.netrc", action: "deny" },
    { pattern: "**/.npmrc", action: "ask" },
    { pattern: "**/.pgpass", action: "deny" },
  ],
  Edit: [
    { pattern: "**/.env", action: "ask" },
    { pattern: "**/.env.*", action: "ask" },
    { pattern: "**/.env.example", action: "allow" },
    { pattern: "**/id_rsa", action: "deny" },
    { pattern: "**/id_ed25519", action: "deny" },
    { pattern: "**/.ssh/**", action: "deny" },
    { pattern: "**/.aws/credentials", action: "deny" },
    { pattern: "**/.gcp/credentials.json", action: "deny" },
    { pattern: "**/.netrc", action: "deny" },
  ],
  Write: [
    { pattern: "**/.env", action: "ask" },
    { pattern: "**/.env.*", action: "ask" },
    { pattern: "**/id_rsa", action: "deny" },
    { pattern: "**/.ssh/**", action: "deny" },
    { pattern: "**/.aws/credentials", action: "deny" },
    { pattern: "**/.netrc", action: "deny" },
  ],
};
