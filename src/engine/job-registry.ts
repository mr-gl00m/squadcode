// Per-session registry of long-running jobs: backgrounded shell commands and
// (Phase 13 integration) subagent runs, which share this record shape — a
// subagent record IS a job record. Survives across turns within a session,
// cleared on session end. API shaped after OpenCode's background/job.ts:
// create/get/list/wait/cancel, with a Deferred behind wait() for a blocking
// result and a scope-bound cancel handle for interrupt.
//
// The registry stores records and resolves a Deferred on settle; it does not
// own the work. Callers drive lifecycle: the shell tool spawns a child, pipes
// output into the handle, and settles on close; spawn registers a subagent job
// and settles when the run returns. cancel() invokes the caller's onCancel
// (killTree for a shell, abort for a subagent) and settles cancelled.
export type JobStatus = "running" | "completed" | "error" | "cancelled";
export type JobType = "shell" | "subagent";

export interface JobInfo {
  id: string;
  type: JobType;
  title?: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  pid?: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// Mirror of the shell tool's output cap so a runaway background job can't grow
// the buffer without bound.
const MAX_JOB_OUTPUT_BYTES = 200_000;

export interface SettlePatch {
  exitCode?: number;
  error?: string;
}

export interface JobHandle {
  readonly id: string;
  info(): JobInfo;
  setPid(pid: number): void;
  appendStdout(chunk: string): void;
  appendStderr(chunk: string): void;
  settle(
    status: "completed" | "error" | "cancelled",
    patch?: SettlePatch,
  ): void;
  wait(): Promise<JobInfo>;
  cancel(): void;
}

export interface CreateJobSpec {
  type: JobType;
  title?: string;
  // Explicit id (subagent jobs reuse the agent designation); auto-assigned for
  // shell jobs.
  id?: string;
  metadata?: Record<string, unknown>;
  onCancel?: () => void;
}

export interface JobRegistry {
  create(spec: CreateJobSpec): JobHandle;
  get(id: string): JobInfo | undefined;
  list(): JobInfo[];
  wait(id: string): Promise<JobInfo> | undefined;
  cancel(id: string): boolean;
  // Settled jobs not yet reported to the model, for the loop's pre-turn
  // injection of "job finished". Marks them reported so each surfaces once.
  drainSettled(): JobInfo[];
  clear(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function createJobRegistry(): JobRegistry {
  const records = new Map<string, JobInfo>();
  const deferreds = new Map<string, Deferred<JobInfo>>();
  const cancels = new Map<string, (() => void) | undefined>();
  const reported = new Set<string>();
  let seq = 0;

  function appendCapped(
    info: JobInfo,
    key: "stdout" | "stderr",
    chunk: string,
  ): void {
    const current = info[key] ?? "";
    if (current.length >= MAX_JOB_OUTPUT_BYTES) return;
    const room = MAX_JOB_OUTPUT_BYTES - current.length;
    info[key] = current + (chunk.length > room ? chunk.slice(0, room) : chunk);
  }

  return {
    create(spec: CreateJobSpec): JobHandle {
      seq += 1;
      const id = spec.id ?? `job_${seq}`;
      const info: JobInfo = {
        id,
        type: spec.type,
        status: "running",
        startedAt: new Date().toISOString(),
        ...(spec.title !== undefined && { title: spec.title }),
        ...(spec.metadata !== undefined && { metadata: spec.metadata }),
      };
      records.set(id, info);
      deferreds.set(id, deferred<JobInfo>());
      cancels.set(id, spec.onCancel);

      const handle: JobHandle = {
        id,
        info: () => records.get(id) ?? info,
        setPid: (pid) => {
          info.pid = pid;
        },
        appendStdout: (chunk) => appendCapped(info, "stdout", chunk),
        appendStderr: (chunk) => appendCapped(info, "stderr", chunk),
        settle: (status, patch) => {
          if (info.status !== "running") return;
          info.status = status;
          info.completedAt = new Date().toISOString();
          if (patch?.exitCode !== undefined) info.exitCode = patch.exitCode;
          if (patch?.error !== undefined) info.error = patch.error;
          deferreds.get(id)?.resolve(info);
        },
        wait: () => deferreds.get(id)?.promise ?? Promise.resolve(info),
        cancel: () => {
          const onCancel = cancels.get(id);
          if (onCancel) {
            try {
              onCancel();
            } catch {
              /* a cancel callback must not throw out of the registry */
            }
          }
          if (info.status === "running") {
            info.status = "cancelled";
            info.completedAt = new Date().toISOString();
            deferreds.get(id)?.resolve(info);
          }
        },
      };
      return handle;
    },
    get: (id) => records.get(id),
    list: () => [...records.values()],
    wait: (id) => deferreds.get(id)?.promise,
    cancel(id: string): boolean {
      const info = records.get(id);
      if (!info) return false;
      const onCancel = cancels.get(id);
      if (onCancel) {
        try {
          onCancel();
        } catch {
          /* swallow */
        }
      }
      if (info.status === "running") {
        info.status = "cancelled";
        info.completedAt = new Date().toISOString();
        deferreds.get(id)?.resolve(info);
      }
      return true;
    },
    drainSettled(): JobInfo[] {
      const out: JobInfo[] = [];
      for (const info of records.values()) {
        if (info.status !== "running" && !reported.has(info.id)) {
          reported.add(info.id);
          out.push(info);
        }
      }
      return out;
    },
    clear: () => {
      records.clear();
      deferreds.clear();
      cancels.clear();
      reported.clear();
    },
  };
}
