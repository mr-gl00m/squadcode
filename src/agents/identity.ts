import { AgentError, type AgentId } from "./types.js";

// Two-letter + digit designations ("KT-4"). Clean-room rebuild — the *idea* of
// a short call-sign is borrowed from FETCH §10, but none of its code is.
//
// I and O are dropped from the letter set and 0 from the digits so a
// designation is never misread on a busy panel (KT-4 vs KI-0). That still
// leaves 24 * 24 * 9 = 5184 distinct call-signs, against a 4-slot ceiling —
// collisions are a non-event, but allocate() retries on one anyway and then
// falls back to a deterministic scan so it can never hand out a live id.
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "123456789";

export interface IdentityPool {
  allocate(): AgentId;
  release(id: AgentId): void;
  living(): AgentId[];
}

export function createIdentityPool(
  rng: () => number = Math.random,
): IdentityPool {
  const live = new Set<AgentId>();

  function candidate(): AgentId {
    const a = LETTERS[Math.floor(rng() * LETTERS.length)] ?? "A";
    const b = LETTERS[Math.floor(rng() * LETTERS.length)] ?? "A";
    const d = DIGITS[Math.floor(rng() * DIGITS.length)] ?? "1";
    return `${a}${b}-${d}`;
  }

  return {
    allocate(): AgentId {
      for (let i = 0; i < 64; i += 1) {
        const id = candidate();
        if (!live.has(id)) {
          live.add(id);
          return id;
        }
      }
      // Random space somehow exhausted under contention — scan deterministically
      // so we still never collide rather than spin forever.
      for (const a of LETTERS) {
        for (const b of LETTERS) {
          for (const d of DIGITS) {
            const id = `${a}${b}-${d}`;
            if (!live.has(id)) {
              live.add(id);
              return id;
            }
          }
        }
      }
      throw new AgentError(
        "AGENT_IDENTITY_EXHAUSTED",
        "no free agent designation remains",
      );
    },
    release(id: AgentId): void {
      live.delete(id);
    },
    living(): AgentId[] {
      return [...live];
    },
  };
}
