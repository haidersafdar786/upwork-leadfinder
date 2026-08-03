import { AsyncLocalStorage } from "node:async_hooks";

const cancellation = new AsyncLocalStorage<AbortSignal>();

export function withCancellation<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return cancellation.run(signal, work);
}

export function currentCancellationSignal(): AbortSignal | undefined {
  return cancellation.getStore();
}

export function cancellationReason(signal: AbortSignal, fallback?: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (fallback instanceof Error) return fallback;
  return new Error("Run cancelled");
}

export function checkpoint(signal = currentCancellationSignal()): void {
  if (signal?.aborted) throw cancellationReason(signal);
}

export function rethrowCancellation(error: unknown, signal = currentCancellationSignal()): void {
  if (signal?.aborted) throw cancellationReason(signal, error);
}
