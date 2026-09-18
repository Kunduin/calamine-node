import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SpreadsheetError } from './errors.js';

const noop = (): void => {};

export type ByteStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

function getIterator(source: ByteStream): AsyncIterator<Uint8Array> {
  if (!('getReader' in source)) return source[Symbol.asyncIterator]();
  const reader = source.getReader();
  return {
    next: async () => {
      const result = await reader.read();
      if (result.done) {
        reader.releaseLock();
        return { done: true, value: undefined };
      }
      return { done: false, value: result.value };
    },
    return: async () => {
      try {
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }
      return { done: true, value: undefined };
    },
  };
}

async function next(
  iterator: AsyncIterator<Uint8Array>,
  signal?: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  signal?.throwIfAborted();
  if (!signal) return iterator.next();
  let abort: () => void = noop;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Complete seekable input is required by Calamine. Each write applies backpressure. */
export async function spool(
  source: ByteStream,
  directory: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ path: string; cleanup(): Promise<void> }> {
  signal?.throwIfAborted();
  const temporary = await mkdtemp(join(directory, 'calamine-node-'));
  const cleanup = (): Promise<void> => rm(temporary, { recursive: true, force: true });
  let complete = false;
  let iterator: AsyncIterator<Uint8Array> | undefined;

  try {
    iterator = getIterator(source);
    const path = join(temporary, 'workbook');
    const file = await open(path, 'wx', 0o600);
    try {
      let size = 0;
      while (true) {
        const result = await next(iterator, signal);
        if (result.done) {
          complete = true;
          break;
        }
        if (!(result.value instanceof Uint8Array))
          throw new TypeError('Stream chunks must be Uint8Array or Buffer');
        size += result.value.byteLength;
        if (size > maxBytes)
          throw new SpreadsheetError('ERR_INPUT_LIMIT', 'Stream exceeds maxInputBytes');
        // Own the chunk while asynchronous filesystem writes are in flight.
        await file.writeFile(Buffer.from(result.value));
      }
      signal?.throwIfAborted();
    } finally {
      await file.close();
    }
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    // A producer can ignore cancellation or keep next() pending indefinitely. Do not wait
    // for its return() before releasing our own file. Its rejection is observed.
    if (!complete && iterator) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        /* Producer cleanup cannot mask the original error. */
      }
    }
  }
}
