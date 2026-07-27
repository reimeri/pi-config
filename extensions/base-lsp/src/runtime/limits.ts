export interface Limits {
  requestTimeoutMs: number;
  initializeTimeoutMs: number;
  shutdownTimeoutMs: number;
  /** Quiet period between the repeated mutation requests used to confirm a stable server answer. */
  mutationSettleMs: number;
  idleClientMs: number;
  maxClients: number;
  maxOpenDocuments: number;
  maxDiscoveryEntries: number;
  maxFiles: number;
  maxDiagnostics: number;
  maxLocations: number;
  maxSymbols: number;
  maxEditsPerFile: number;
  maxTotalEdits: number;
  maxTransactionFiles: number;
  maxTransactionBytes: number;
  maxFileBytes: number;
  maxFrameHeaderBytes: number;
  maxFrameBodyBytes: number;
  maxBufferedFrames: number;
  maxStderrBytes: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  requestTimeoutMs: 20_000,
  initializeTimeoutMs: 30_000,
  shutdownTimeoutMs: 2_000,
  mutationSettleMs: 400,
  idleClientMs: 300_000,
  maxClients: 6,
  maxOpenDocuments: 100,
  maxDiscoveryEntries: 10_000,
  maxFiles: 100,
  maxDiagnostics: 300,
  maxLocations: 100,
  maxSymbols: 200,
  maxEditsPerFile: 50,
  maxTotalEdits: 500,
  maxTransactionFiles: 100,
  maxTransactionBytes: 10 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxFrameHeaderBytes: 16 * 1024,
  maxFrameBodyBytes: 8 * 1024 * 1024,
  maxBufferedFrames: 8,
  maxStderrBytes: 64 * 1024,
});

export const HARD_LIMITS: Readonly<Limits> = Object.freeze({
  requestTimeoutMs: 120_000,
  initializeTimeoutMs: 120_000,
  shutdownTimeoutMs: 10_000,
  mutationSettleMs: 10_000,
  idleClientMs: 3_600_000,
  maxClients: 32,
  maxOpenDocuments: 1_000,
  maxDiscoveryEntries: 100_000,
  maxFiles: 500,
  maxDiagnostics: 1_000,
  maxLocations: 500,
  maxSymbols: 1_000,
  maxEditsPerFile: 500,
  maxTotalEdits: 5_000,
  maxTransactionFiles: 500,
  maxTransactionBytes: 100 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxFrameHeaderBytes: 64 * 1024,
  maxFrameBodyBytes: 64 * 1024 * 1024,
  maxBufferedFrames: 32,
  maxStderrBytes: 1024 * 1024,
});

export function clampLimits(input: Partial<Limits> | undefined): Limits {
  const result = { ...DEFAULT_LIMITS };
  if (!input) return result;
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`limits.${key} must be a positive integer`);
    result[key] = Math.min(value, HARD_LIMITS[key]);
  }
  return result;
}
