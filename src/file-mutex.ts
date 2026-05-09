const locks = new Map<string, Promise<unknown>>();

export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(path) ?? Promise.resolve();
  const current = prev.then(fn);
  const sentinel = current.catch(() => undefined);
  locks.set(path, sentinel);
  try {
    return await current;
  } finally {
    if (locks.get(path) === sentinel) {
      locks.delete(path);
    }
  }
}
