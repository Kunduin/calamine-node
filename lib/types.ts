import type { SheetInfo, SpecialValue, DefinedName, VbaProject } from '../native/binding.cjs';
import type { ByteStream } from './stream.js';

export type { SheetInfo, SpecialValue, DefinedName, VbaProject } from '../native/binding.cjs';
export type { ByteStream } from './stream.js';

/** Numeric dates retain Excel serials and calendar components; no timezone is invented. */
export type Cell = string | number | boolean | null | SpecialValue;
export type Row = Cell[];

export interface Origin {
  readonly row: number;
  readonly column: number;
}

export interface SheetResult {
  readonly sheet: Readonly<SheetInfo>;
  readonly origin: Origin | null;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: Row[];
}

export interface RowBatch extends SheetResult {
  /** Zero-based offset relative to origin; rowCount describes the complete used range. */
  readonly offset: number;
}

export interface OpenOptions {
  readonly signal?: AbortSignal;
}

export interface ReadOptions extends OpenOptions {
  /** Number of rows per batch, additionally capped at approximately 16,384 cells. */
  readonly batchSize?: number;
  /** Read cached values (default) or formula text. Formulas are never evaluated. */
  readonly content?: 'values' | 'formulas';
  readonly maxCells?: number;
}

export interface ReaderOptions {
  readonly concurrency?: number;
  readonly maxQueued?: number;
  readonly maxInputBytes?: number;
  readonly maxCells?: number;
  readonly tempDirectory?: string;
  /** Opt in to formats with known upstream interoperability gaps. */
  readonly experimentalFormats?: readonly ('xlsb' | 'ods')[];
}

export interface VbaOptions extends OpenOptions {
  readonly maxBytes?: number;
}

export interface Workbook extends AsyncDisposable {
  readonly format: string;
  readonly sheets: readonly Readonly<SheetInfo>[];
  readonly definedNames: readonly Readonly<DefinedName>[];
  readonly closed: boolean;
  readSheet(sheet?: string | number, options?: ReadOptions): Promise<SheetResult>;
  readBatches(sheet?: string | number, options?: ReadOptions): AsyncGenerator<RowBatch>;
  readVbaProject(options?: VbaOptions): Promise<VbaProject | null>;

  /** Idempotent; waits for native cleanup and removes any spooled input. */
  close(): Promise<void>;
}

export interface Reader {
  openFile(path: string | URL, options?: OpenOptions): Promise<Workbook>;
  openBuffer(bytes: Uint8Array, options?: OpenOptions): Promise<Workbook>;
  openStream(source: ByteStream, options?: OpenOptions): Promise<Workbook>;
}
