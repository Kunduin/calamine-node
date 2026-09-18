import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isSharedArrayBuffer } from 'node:util/types';
import binding from '../native/binding.cjs';
import type { NativeWorkbook } from '../native/binding.cjs';
import { SpreadsheetError, integer } from './errors.js';
import { nativeOperation } from './native.js';
import { spool } from './stream.js';
import { WorkbookHandle } from './workbook.js';
import { collectWorkbook } from './read.js';
import type {
  ByteStream,
  OpenOptions,
  Reader,
  ReaderOptions,
  ReadOptions,
  Workbook,
  WorkbookInput,
  WorkbookResult,
} from './types.js';

/** Create an independent admission queue. Keep one reader per application workload. */
export function createReader(options: ReaderOptions = {}): Reader {
  const reader = new WorkbookReader(options);
  return {
    read: reader.read.bind(reader),
    openFile: reader.openFile.bind(reader),
    openBuffer: reader.openBuffer.bind(reader),
    openStream: reader.openStream.bind(reader),
  };
}

class WorkbookReader implements Reader {
  readonly #native: binding.NativeReader;
  readonly #maxInputBytes: number;
  readonly #maxCells: number;
  readonly #experimentalFormats: ReadonlySet<string>;
  readonly #directory: string;

  constructor(options: ReaderOptions) {
    const concurrency = integer(options.concurrency ?? 2, 'concurrency', 1, 128);
    const maxQueued = integer(options.maxQueued ?? 8, 'maxQueued', 0, 65_536);
    this.#maxInputBytes = integer(options.maxInputBytes ?? 64 * 1024 * 1024, 'maxInputBytes');
    this.#maxCells = integer(options.maxCells ?? 2_000_000, 'maxCells', 0);
    this.#experimentalFormats = new Set(options.experimentalFormats ?? []);
    for (const format of this.#experimentalFormats) {
      if (format !== 'xlsb' && format !== 'ods') {
        throw new TypeError('experimentalFormats may contain only xlsb and ods');
      }
    }

    this.#directory = options.tempDirectory ?? tmpdir();
    if (typeof this.#directory !== 'string' || this.#directory.length === 0) {
      throw new TypeError('tempDirectory must be a non-empty path');
    }
    this.#native = new binding.NativeReader(concurrency, maxQueued);
  }

  read(input: WorkbookInput, options: ReadOptions = {}): Promise<WorkbookResult> {
    return collectWorkbook(this, input, options, this.#maxCells);
  }

  async openFile(path: string | URL, options: OpenOptions = {}): Promise<Workbook> {
    const { signal } = options;
    signal?.throwIfAborted();
    const limit = this.#inputLimit(options);
    const filename = path instanceof URL ? fileURLToPath(path) : path;
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('path must be a non-empty file path or file URL');
    }

    const absolute = resolve(filename);
    const native = await nativeOperation(
      (cancellation) => this.#native.openPath(absolute, limit, cancellation),
      signal,
    );
    return this.#finish(native, signal);
  }

  async openBuffer(bytes: Uint8Array, options: OpenOptions = {}): Promise<Workbook> {
    const { signal } = options;
    signal?.throwIfAborted();
    const limit = this.#inputLimit(options);
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('bytes must be Uint8Array or Buffer');
    }
    if (isSharedArrayBuffer(bytes.buffer)) {
      throw new TypeError('bytes must not use SharedArrayBuffer storage');
    }

    const native = await nativeOperation(
      (cancellation) => this.#native.openBytes(bytes, limit, cancellation),
      signal,
    );
    return this.#finish(native, signal);
  }

  async openStream(source: ByteStream, options: OpenOptions = {}): Promise<Workbook> {
    const { signal } = options;
    signal?.throwIfAborted();
    const limit = this.#inputLimit(options);
    const permit = await nativeOperation(
      (cancellation) => this.#native.reserveStream(cancellation),
      signal,
    );

    let input: Awaited<ReturnType<typeof spool>> | undefined;
    try {
      input = await spool(source, this.#directory, limit, signal);
      const path = input.path;
      const native = await nativeOperation(
        (cancellation) => permit.openPath(path, limit, cancellation),
        signal,
      );
      return await this.#finish(native, signal, input.cleanup);
    } catch (error) {
      await input?.cleanup();
      throw error;
    } finally {
      permit.release();
    }
  }

  #inputLimit(options: OpenOptions): number {
    return integer(options.maxInputBytes ?? this.#maxInputBytes, 'maxInputBytes');
  }

  async #finish(
    native: NativeWorkbook,
    signal: AbortSignal | undefined,
    cleanup?: () => Promise<void>,
  ): Promise<Workbook> {
    try {
      signal?.throwIfAborted();
      const format = native.info.format;
      if ((format === 'xlsb' || format === 'ods') && !this.#experimentalFormats.has(format)) {
        throw new SpreadsheetError(
          'ERR_EXPERIMENTAL_FORMAT',
          `${format} requires an explicit experimentalFormats opt-in; see the compatibility notes`,
        );
      }
      return new WorkbookHandle(native, this.#maxCells, cleanup);
    } catch (error) {
      await nativeOperation(() => native.close());
      throw error;
    }
  }
}
