export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class CancelledError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError();
}

export async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal, label = "operation"): Promise<T> {
  throwIfAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });
  const cancellation = new Promise<never>((_, reject) => {
    if (!signal) return;
    abort = () => reject(new CancelledError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort && signal) signal.removeEventListener("abort", abort);
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return withDeadline(new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  }), ms + 1_000, signal, "wait");
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next, () => next);
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

export class KeyedMutex {
  private readonly mutexes = new Map<string, AsyncMutex>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(key);
    if (!mutex) { mutex = new AsyncMutex(); this.mutexes.set(key, mutex); }
    return mutex.run(fn);
  }
}
