import type {
  NativeWorkbook,
  NativeSheet,
  RangeInfo,
  SheetInfo,
  DefinedName,
  VbaProject,
} from '../native/binding.cjs';
import { SpreadsheetError, integer } from './errors.js';
import { collectionBatchSize, readOptions } from './options.js';
import type { Gate } from './gate.js';
import type { Workbook, SheetResult, RowBatch, ReadOptions, Row, VbaOptions } from './types.js';

function metadata(info: RangeInfo, sheet: Readonly<SheetInfo>): Omit<SheetResult, 'rows'> {
  return {
    ...sheet,
    origin: info.row == null || info.column == null ? null : { row: info.row, column: info.column },
    rowCount: info.rowCount,
    columnCount: info.columnCount,
  };
}

export class WorkbookHandle implements Workbook {
  readonly format: string;
  readonly sheets: readonly Readonly<SheetInfo>[];
  readonly definedNames: readonly Readonly<DefinedName>[];

  #closed = false;
  #closing: Promise<void> | undefined;
  #busy = false;
  #loading: Promise<NativeSheet> | undefined;
  #readingVba: Promise<VbaProject | null> | undefined;

  constructor(
    private readonly native: NativeWorkbook,
    private readonly gate: Gate,
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
    if (this.#closed) throw new SpreadsheetError('ERR_CLOSED', 'Workbook is closed');
  }

  async *readBatches(
    selector: string | number = 0,
    options: ReadOptions = {},
  ): AsyncGenerator<RowBatch> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    if (this.#busy)
      throw new SpreadsheetError('ERR_BUSY', 'Finish or return the active sheet iterator first');
    const sheet =
      typeof selector === 'string'
        ? this.sheets.find((entry) => entry.name === selector)
        : this.sheets[integer(selector, 'sheet index', 0)];
    if (!sheet) throw new SpreadsheetError('ERR_SHEET', 'Unknown sheet');
    const batchSize = integer(options.batchSize ?? 256, 'batchSize', 1, 10_000);
    const maxCells = integer(options.maxCells ?? this.maxCells, 'maxCells', 0);
    const content = options.content ?? 'values';
    if (content !== 'values' && content !== 'formulas')
      throw new TypeError('content must be values or formulas');

    this.#busy = true;
    let native: NativeSheet | undefined;

    try {
      this.#loading = this.gate.run(
        () => this.native.loadSheet(sheet.index, maxCells, content === 'formulas'),
        options.signal,
      );
      native = await this.#loading;
      this.#assertOpen();
      options.signal?.throwIfAborted();
      const info = native.info;
      const common = metadata(info, sheet);
      const count = Math.max(
        1,
        Math.min(batchSize, Math.floor(16_384 / Math.max(1, info.columnCount))),
      );
      if (info.rowCount === 0) yield { ...common, offset: 0, rows: [] };
      for (let offset = 0; offset < info.rowCount; offset += count) {
        this.#assertOpen();
        options.signal?.throwIfAborted();
        const current = native;
        const batch = await this.gate.run(() => current.batch(offset, count), options.signal);
        this.#assertOpen();
        options.signal?.throwIfAborted();
        yield { ...common, offset, rows: batch.rows };
      }
    } finally {
      try {
        if (native) {
          const current = native;
          await this.gate.run(() => current.close(), undefined, true);
        }
      } finally {
        this.#loading = undefined;
        this.#busy = false;
      }
    }
  }

  async readSheet(selector: string | number = 0, options: ReadOptions = {}): Promise<SheetResult> {
    const rows: Row[] = [];
    let result: SheetResult | undefined;
    const reading = readOptions(options, this.maxCells, collectionBatchSize);
    for await (const batch of this.readBatches(selector, reading)) {
      result ??= {
        name: batch.name,
        index: batch.index,
        kind: batch.kind,
        visibility: batch.visibility,
        origin: batch.origin,
        rowCount: batch.rowCount,
        columnCount: batch.columnCount,
        rows,
      };
      for (const row of batch.rows) rows.push(row);
    }
    if (!result) throw new SpreadsheetError('ERR_STATE', 'Sheet reader produced no result');
    return result;
  }

  async readVbaProject(options: VbaOptions = {}): Promise<VbaProject | null> {
    this.#assertOpen();
    options.signal?.throwIfAborted();
    if (this.#busy) {
      throw new SpreadsheetError('ERR_BUSY', 'Finish the active workbook operation first');
    }

    const maxBytes = integer(options.maxBytes ?? 16 * 1024 * 1024, 'maxBytes');
    this.#busy = true;
    try {
      this.#readingVba = this.gate.run(
        async () => (await this.native.vbaProject(maxBytes)) ?? null,
        options.signal,
      );
      const project = await this.#readingVba;
      this.#assertOpen();
      options.signal?.throwIfAborted();
      return project;
    } finally {
      this.#readingVba = undefined;
      this.#busy = false;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      try {
        await this.#readingVba?.catch(() => undefined);
        const sheet = await this.#loading?.catch(() => undefined);
        if (sheet) await this.gate.run(() => sheet.close(), undefined, true);
      } finally {
        try {
          await this.gate.run(() => this.native.close(), undefined, true);
        } finally {
          await this.cleanup?.();
        }
      }
    })();
    return this.#closing;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
