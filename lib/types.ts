import type { SheetInfo, SpecialValue, DefinedName, VbaProject } from '../native/binding.cjs';
import type { ByteStream } from './stream.js';

export type { SheetInfo, SpecialValue, DefinedName, VbaProject } from '../native/binding.cjs';
export type { ByteStream } from './stream.js';

/** Numeric dates retain Excel serials and calendar components; no timezone is invented. */
export type Cell = string | number | boolean | null | SpecialValue;
export type Row = Cell[];
export type SheetSelector = string | number;
export type WorkbookInput = string | URL | Uint8Array | ByteStream;

export interface Origin {
  readonly row: number;
  readonly column: number;
}

export interface SheetResult extends Readonly<SheetInfo> {
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
  /** Overrides the reader's compressed input limit for this operation. */
  readonly maxInputBytes?: number;
}

export interface SheetReadOptions {
  readonly signal?: AbortSignal;
  /** Number of rows per batch, additionally capped at approximately 16,384 cells. */
  readonly batchSize?: number;
  /** Read cached values (default) or formula text. Formulas are never evaluated. */
  readonly content?: 'values' | 'formulas';
  /** Maximum cells in the used rectangle, including holes. Zero accepts empty ranges only. */
  readonly maxCells?: number;
}

export interface ReadOptions extends SheetReadOptions, OpenOptions {
  /** Name, zero-based index, or a list. Omit for all worksheets; [] reads metadata only. */
  readonly sheets?: SheetSelector | readonly SheetSelector[];
  /** Maximum cells across all selected sheets, including holes. */
  readonly maxCells?: number;
  readonly includeVba?: boolean;
  /** Maximum decoded VBA source bytes, when includeVba is true. */
  readonly maxVbaBytes?: number;
}

/** Fully materialized data. No native handle or disposal obligation remains. */
export interface WorkbookResult {
  readonly format: string;
  readonly sheets: SheetResult[];
  readonly definedNames: readonly Readonly<DefinedName>[];
  /** Absent when not requested; null when requested but the workbook has no VBA. */
  readonly vbaProject?: VbaProject | null;
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

export interface VbaOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

/** An open workbook resource. Sheet entries are metadata; close after use. */
export interface Workbook extends AsyncDisposable {
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
  read(input: WorkbookInput, options?: ReadOptions): Promise<WorkbookResult>;
  openFile(path: string | URL, options?: OpenOptions): Promise<Workbook>;
  openBuffer(bytes: Uint8Array, options?: OpenOptions): Promise<Workbook>;
  openStream(source: ByteStream, options?: OpenOptions): Promise<Workbook>;
}
