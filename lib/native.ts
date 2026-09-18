import binding from '../native/binding.cjs';
import type { NativeCancellation } from '../native/binding.cjs';
import { nativeError } from './errors.js';

/** Invoke synchronously so native admission and byte snapshots precede any await. */
export async function nativeOperation<T>(
  operation: (cancellation: NativeCancellation | undefined) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const cancellation = signal ? new binding.NativeCancellation() : undefined;
  const cancel = (): void => cancellation?.cancel();
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    // Callers check cancellation after taking ownership of returned handles, so
    // they can close a resource produced by work that was already running.
    return await operation(cancellation);
  } catch (error) {
    signal?.throwIfAborted();
    throw nativeError(error);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
