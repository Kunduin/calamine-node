import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import binding from '../native/binding.cjs';
import type { NativeWorkbook } from '../native/binding.cjs';
import { SpreadsheetError, integer } from './errors.js';
import { Gate } from './gate.js';
import { spool } from './stream.js';
import { WorkbookHandle } from './workbook.js';
import { collectWorkbook, type WorkbookOpener } from './read.js';
import type { Reader, ReaderOptions, Workbook } from './types.js';

/** Create an independent admission queue. Keep one reader per application workload. */
export function createReader(options: ReaderOptions = {}): Reader {
  const gate = new Gate(
    integer(options.concurrency ?? 2, 'concurrency', 1, 128),
    integer(options.maxQueued ?? 8, 'maxQueued', 0, 65_536),
  );
  const maxInputBytes = integer(options.maxInputBytes ?? 64 * 1024 * 1024, 'maxInputBytes');
  const maxCells = integer(options.maxCells ?? 2_000_000, 'maxCells', 0);
  const experimentalFormats = new Set(options.experimentalFormats ?? []);
  for (const format of experimentalFormats) {
    if (format !== 'xlsb' && format !== 'ods') {
      throw new TypeError('experimentalFormats may contain only xlsb and ods');
    }
  }

  const directory = options.tempDirectory ?? tmpdir();
  if (typeof directory !== 'string' || directory.length === 0)
    throw new TypeError('tempDirectory must be a non-empty path');
  const finish = async (
    native: NativeWorkbook,
    signal: AbortSignal | undefined,
    cleanup?: () => Promise<void>,
  ): Promise<Workbook> => {
    if (signal?.aborted) {
      try {
        await native.close();
      } finally {
        await cleanup?.();
      }
      signal.throwIfAborted();
    }
    const format = native.info.format;
    if ((format === 'xlsb' || format === 'ods') && !experimentalFormats.has(format)) {
      try {
        await native.close();
      } finally {
        await cleanup?.();
      }
      throw new SpreadsheetError(
        'ERR_EXPERIMENTAL_FORMAT',
        `${format} requires an explicit experimentalFormats opt-in; see the compatibility notes`,
      );
    }

    return new WorkbookHandle(native, gate, maxCells, cleanup);
  };
  const opener: WorkbookOpener = {
    async openFile(path, { signal, maxInputBytes: inputLimit = maxInputBytes } = {}) {
      signal?.throwIfAborted();
      const limit = integer(inputLimit, 'maxInputBytes');
      const filename = path instanceof URL ? fileURLToPath(path) : path;
      if (typeof filename !== 'string' || filename.length === 0)
        throw new TypeError('path must be a non-empty file path or file URL');
      const absolute = resolve(filename);
      return gate.run(async () => finish(await binding.openPath(absolute, limit), signal), signal);
    },
    async openBuffer(bytes, { signal, maxInputBytes: inputLimit = maxInputBytes } = {}) {
      signal?.throwIfAborted();
      const limit = integer(inputLimit, 'maxInputBytes');
      if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be Uint8Array or Buffer');
      if (bytes.byteLength > limit)
        throw new SpreadsheetError('ERR_INPUT_LIMIT', 'Buffer exceeds maxInputBytes');
      const snapshot = Buffer.from(bytes);
      return gate.run(async () => finish(await binding.openBytes(snapshot, limit), signal), signal);
    },
    async openStream(source, { signal, maxInputBytes: inputLimit = maxInputBytes } = {}) {
      signal?.throwIfAborted();
      const limit = integer(inputLimit, 'maxInputBytes');
      return gate.run(async () => {
        const input = await spool(source, directory, limit, signal);
        try {
          return await finish(await binding.openPath(input.path, limit), signal, input.cleanup);
        } catch (error) {
          await input.cleanup();
          throw error;
        }
      }, signal);
    },
  };

  return {
    ...opener,
    read: (input, readOptions = {}) => collectWorkbook(opener, input, readOptions, maxCells),
  };
}
