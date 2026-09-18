import { SpreadsheetError, nativeError } from './errors.js';

interface Waiter {
  enter(): void;
}

/** A permit belongs to the underlying task, even after its caller requests cancellation. */
export class Gate {
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(
    readonly concurrency: number,
    readonly maxQueued: number,
  ) {}

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal, cleanup = false): Promise<T> {
    await this.#acquire(signal, cleanup);
    try {
      signal?.throwIfAborted();
      return await operation();
    } catch (error) {
      throw nativeError(error);
    } finally {
      this.#active--;
      this.#queue.shift()?.enter();
    }
  }

  #acquire(signal: AbortSignal | undefined, cleanup: boolean): Promise<void> {
    signal?.throwIfAborted();
    if (this.#active < this.concurrency) {
      this.#active++;
      return Promise.resolve();
    }
    if (!cleanup && this.#queue.length >= this.maxQueued) {
      return Promise.reject(new SpreadsheetError('ERR_QUEUE_FULL', 'Reader queue is full'));
    }
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) this.#queue.splice(index, 1);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        enter: () => {
          signal?.removeEventListener('abort', cancel);
          this.#active++;
          resolve();
        },
      };
      this.#queue.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
}
