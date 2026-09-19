import type {
  SheetInfo,
  SpecialValue,
  DefinedName,
  VbaProject,
  CellRange,
} from '../native/binding.cjs';
import type { ByteStream } from './stream.js';

export type {
  SheetInfo,
  SpecialValue,
  DefinedName,
  VbaProject,
  CellRange,
  CellPosition,
} from '../native/binding.cjs';
export type { ByteStream } from './stream.js';

/** Numeric dates retain Excel serials and calendar components; no timezone is invented. */
export type Cell = string | number | boolean | null | SpecialValue;
export type Row = Cell[];
export type SheetSelector = string | number;

/** A local path/file URL, an in-memory byte view, or a byte stream. */
export type ReadInput = string | URL | Uint8Array | ByteStream;

export interface Origin {
  readonly row: number;
  readonly column: number;
}

export interface SheetResult extends Readonly<SheetInfo> {
  readonly origin: Origin | null;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly rows: Row[];
  /** Absolute, zero-based, inclusive ranges. Included by default for XLS/XLSX. */
  readonly mergedCells?: readonly CellRange[];
}

export interface RowBatch extends SheetResult {
  /** Zero-based offset relative to origin; rowCount describes the complete used range. */
  readonly offset: number;
}

export interface OpenOptions {
  readonly signal?: AbortSignal;
  /** Overrides the reader's compressed input limit for this operation. */
  readonly maxInputBytes?: number;
}

export interface SheetReadOptions {
  readonly signal?: AbortSignal;
  /** Number of rows per batch, additionally capped at approximately 16,384 cells. */
  readonly batchSize?: number;
  /** Read cached values (default) or formula text. Formulas are never evaluated. */
  readonly content?: 'values' | 'formulas';
  /** Defaults to true for XLS/XLSX. Never fills covered cells; false omits merge metadata. */
  readonly includeMergedCells?: boolean;
  /** Cell budget including holes. Infinity disables the limit; zero accepts empty ranges only. */
  readonly maxCells?: number;
}

export interface ReadOptions extends SheetReadOptions, OpenOptions {
  /** Name, zero-based index, or a list. Omit for all worksheets; [] reads metadata only. */
  readonly sheets?: SheetSelector | readonly SheetSelector[];
  /** Cell budget across selected sheets, including holes. Infinity disables the limit. */
  readonly maxCells?: number;
  readonly includeVba?: boolean;
  /** Maximum decoded VBA source bytes, when includeVba is true. */
  readonly maxVbaBytes?: number;
}

/** Complete data returned by read(). All native resources have already been closed. */
export interface ReadResult {
  readonly format: string;
  readonly sheets: SheetResult[];
  readonly definedNames: readonly Readonly<DefinedName>[];
  /** Absent when not requested; null when requested but the workbook has no VBA. */
  readonly vbaProject?: VbaProject | null;
}

export interface ReaderOptions {
  /** Defaults to the napi-rs Tokio runtime's worker count (normally available logical CPUs). */
  readonly concurrency?: number;
  readonly maxInputBytes?: number;
  /** Cell budget, including holes. Defaults to Infinity (no limit). */
  readonly maxCells?: number;
  readonly tempDirectory?: string;
  /** Opt in to formats with known upstream interoperability gaps. */
  readonly experimentalFormats?: readonly ('xlsb' | 'ods')[];
}

export interface VbaOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

/** Returned by openFile/openBuffer/openStream. Sheet entries are metadata; close after use. */
export interface WorkbookHandle extends AsyncDisposable {
  readonly format: string;
  readonly sheets: readonly Readonly<SheetInfo>[];
  readonly definedNames: readonly Readonly<DefinedName>[];
  readonly closed: boolean;
  readSheet(sheet?: SheetSelector, options?: SheetReadOptions): Promise<SheetResult>;
  readBatches(sheet?: SheetSelector, options?: SheetReadOptions): AsyncGenerator<RowBatch>;
  readVbaProject(options?: VbaOptions): Promise<VbaProject | null>;

  /** Idempotent; waits for native cleanup and removes any spooled input. */
  close(): Promise<void>;
}

export interface Reader {
  /** Read selected worksheets into ordinary data and close all resources before settling. */
  read(input: ReadInput, options?: ReadOptions): Promise<ReadResult>;
  openFile(path: string | URL, options?: OpenOptions): Promise<WorkbookHandle>;
  openBuffer(bytes: Uint8Array, options?: OpenOptions): Promise<WorkbookHandle>;
  openStream(source: ByteStream, options?: OpenOptions): Promise<WorkbookHandle>;
}
