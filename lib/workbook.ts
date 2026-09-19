import type {
  NativeWorkbook,
  NativeSheet,
  RangeInfo,
  SheetInfo,
  DefinedName,
  VbaProject,
} from '../native/binding.cjs';
import { SpreadsheetError, integer } from './errors.js';
import { collectionBatchSize, normalizeSheetOptions } from './options.js';
import { nativeOperation } from './native.js';
import type { NativeCancellation } from '../native/binding.cjs';
import type {
  WorkbookHandle,
  SheetResult,
  RowBatch,
  SheetReadOptions,
  Row,
  VbaOptions,
} from './types.js';

function metadata(info: RangeInfo, sheet: Readonly<SheetInfo>): Omit<SheetResult, 'rows'> {
  return {
    ...sheet,
    origin: info.row == null || info.column == null ? null : { row: info.row, column: info.column },
    rowCount: info.rowCount,
    columnCount: info.columnCount,
    ...(info.mergedCells == null ? {} : { mergedCells: info.mergedCells }),
  };
}

export class OpenWorkbook implements WorkbookHandle {
  readonly format: string;
  readonly sheets: readonly Readonly<SheetInfo>[];
  readonly definedNames: readonly Readonly<DefinedName>[];

  #closed = false;
  #closing: Promise<void> | undefined;
  #busy = false;
  #pending: Promise<unknown> | undefined;

  constructor(
    private readonly native: NativeWorkbook,
    private readonly maxCells: number,
    private readonly cleanup?: () => Promise<void>,
  ) {
    const info = native.info;
    this.format = info.format;
    this.sheets = Object.freeze(info.sheets.map((sheet) => Object.freeze(sheet)));
    this.definedNames = Object.freeze(info.definedNames.map((name) => Object.freeze(name)));
  }

  get closed(): boolean {
    return this.#closed;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SpreadsheetError('ERR_CLOSED', 'Workbook is closed');
    }
  }

  async *readBatches(
    selector: string | number = 0,
    options: SheetReadOptions = {},
  ): AsyncGenerator<RowBatch> {
    this.#assertOpen();
    const { signal, batchSize, maxCells, content, includeMergedCells } = normalizeSheetOptions(
      options,
      this.maxCells,
      256,
    );
    signal?.throwIfAborted();
    if (this.#busy) {
      throw new SpreadsheetError('ERR_BUSY', 'Finish or return the active sheet iterator first');
    }
    const sheet =
      typeof selector === 'string'
        ? this.sheets.find((entry) => entry.name === selector)
        : this.sheets[integer(selector, 'sheet index', 0)];
    if (!sheet) {
      throw new SpreadsheetError('ERR_SHEET', 'Unknown sheet');
    }

    this.#busy = true;
    let native: NativeSheet | undefined;
    const limit = maxCells === Infinity ? undefined : maxCells;

    try {
      native = await this.#run(
        (cancellation) =>
          this.native.loadSheet(
            sheet.index,
            limit,
            content === 'formulas',
            includeMergedCells,
            cancellation,
          ),
        signal,
      );
      this.#assertOpen();
      signal?.throwIfAborted();
      const info = native.info;
      const common = metadata(info, sheet);
      const count = Math.max(
        1,
        Math.min(batchSize, Math.floor(16_384 / Math.max(1, info.columnCount))),
      );
      if (info.rowCount === 0) {
        yield { ...common, offset: 0, rows: [] };
      }
      for (let offset = 0; offset < info.rowCount; offset += count) {
        this.#assertOpen();
        signal?.throwIfAborted();
        const current = native;
        const batch = await this.#run(
          (cancellation) => current.batch(offset, count, cancellation),
          signal,
        );
        this.#assertOpen();
        signal?.throwIfAborted();
        yield { ...common, offset, rows: batch.rows };
      }
    } finally {
      try {
        if (native) {
          const current = native;
          await nativeOperation(() => current.close());
        }
      } finally {
        this.#busy = false;
      }
    }
  }

  async readSheet(
    selector: string | number = 0,
    options: SheetReadOptions = {},
  ): Promise<SheetResult> {
    const rows: Row[] = [];
    let result: SheetResult | undefined;
    const reading = normalizeSheetOptions(options, this.maxCells, collectionBatchSize);
    for await (const batch of this.readBatches(selector, reading)) {
      result ??= {
        name: batch.name,
        index: batch.index,
        kind: batch.kind,
        visibility: batch.visibility,
        origin: batch.origin,
        rowCount: batch.rowCount,
        columnCount: batch.columnCount,
        ...(batch.mergedCells === undefined ? {} : { mergedCells: batch.mergedCells }),
        rows,
      };
      for (const row of batch.rows) {
        rows.push(row);
      }
    }
    if (!result) {
      throw new SpreadsheetError('ERR_STATE', 'Sheet reader produced no result');
    }
    return result;
  }

  async readVbaProject(options: VbaOptions = {}): Promise<VbaProject | null> {
    const { signal } = options;
    this.#assertOpen();
    signal?.throwIfAborted();
    if (this.#busy) {
      throw new SpreadsheetError('ERR_BUSY', 'Finish the active workbook operation first');
    }

    const maxBytes = integer(options.maxBytes ?? 16 * 1024 * 1024, 'maxBytes');
    this.#busy = true;
    try {
      const project = await this.#run(
        (cancellation) => this.native.vbaProject(maxBytes, cancellation),
        signal,
      );
      this.#assertOpen();
      signal?.throwIfAborted();
      return project ?? null;
    } finally {
      this.#busy = false;
    }
  }

  async #run<T>(
    operation: (cancellation: NativeCancellation | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const pending = nativeOperation(operation, signal);
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      this.#pending = undefined;
    }
  }

  close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }
    this.#closed = true;
    this.#closing = this.#dispose();
    return this.#closing;
  }

  async #dispose(): Promise<void> {
    try {
      // An in-flight operation may still create a range. The native workbook
      // owns that range and releases it along with the workbook on its worker.
      await this.#pending?.catch(() => undefined);
      await nativeOperation(() => this.native.close());
    } finally {
      await this.cleanup?.();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
