import type { PromptOutcome, PromptRequest } from "../permissions/prompt.js";
import type { AgentId } from "./types.js";

// A thin pub/sub layer over the permission path. Its one job is scope-lock by
// construction: a subagent never calls the permission responder directly — it
// calls a bus that has its identity baked in via derive(), so every
// confirmation request it raises is stamped with that agent's id and type and
// it cannot forge another agent's. The main loop uses the un-derived bus, whose
// requests carry no sourceAgentId (that absence IS the "main loop" signal).
//
// The correlationId on each envelope is the request<TReq,TRes> pattern's hook:
// a synchronous responder (the readline prompt) just awaits, but an async one
// (the Phase 14 TUI overlay, which resolves when the user picks an option) uses
// the correlationId to match a deferred answer back to its request.
export interface PermissionEnvelope {
  correlationId: string;
  sourceAgentId?: AgentId;
  sourceAgentType?: string;
  request: PromptRequest;
}

export type PermissionResponder = (
  env: PermissionEnvelope,
) => Promise<PromptOutcome>;

export interface MessageBus {
  requestPermission(req: PromptRequest): Promise<PromptOutcome>;
  derive(agentId: AgentId, agentType: string): MessageBus;
}

export function createMessageBus(responder: PermissionResponder): MessageBus {
  // Shared across every derived bus so correlation ids are unique session-wide.
  const counter = { n: 0 };

  function make(agentId?: AgentId, agentType?: string): MessageBus {
    return {
      requestPermission(req: PromptRequest): Promise<PromptOutcome> {
        counter.n += 1;
        const env: PermissionEnvelope = {
          correlationId: `perm_${counter.n}`,
          request: req,
          ...(agentId !== undefined && { sourceAgentId: agentId }),
          ...(agentType !== undefined && { sourceAgentType: agentType }),
        };
        return responder(env);
      },
      derive(id: AgentId, type: string): MessageBus {
        return make(id, type);
      },
    };
  }

  return make();
}
