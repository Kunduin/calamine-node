import { SpreadsheetError, integer } from './errors.js';
import { collectionBatchSize, readOptions, sheetSelector } from './options.js';
import type {
  OpenOptions,
  Reader,
  ReadSheetOptions,
  ReadWorkbookOptions,
  SheetResult,
  SheetSelector,
  Workbook,
  WorkbookInput,
  WorkbookResult,
} from './types.js';

export type WorkbookOpener = Pick<Reader, 'openFile' | 'openBuffer' | 'openStream'>;

function openInput(
  reader: WorkbookOpener,
  input: WorkbookInput,
  options: OpenOptions,
): Promise<Workbook> {
  if (typeof input === 'string' || input instanceof URL) {
    return reader.openFile(input, options);
  }
  if (input instanceof Uint8Array) {
    return reader.openBuffer(input, options);
  }
  if (!input || typeof input !== 'object') {
    throw new TypeError('input must be a file path, file URL, Uint8Array, or byte stream');
  }

  return reader.openStream(input, options);
}

function snapshotSelectors(
  selectors: ReadWorkbookOptions['sheets'],
): readonly SheetSelector[] | 'all' {
  if (selectors === undefined || selectors === 'all') {
    return 'all';
  }
  if (!Array.isArray(selectors)) {
    throw new TypeError('sheets must be all or an array of names and zero-based indices');
  }

  return selectors.map(sheetSelector);
}

function selectedIndices(
  workbook: Workbook,
  selectors: readonly SheetSelector[] | 'all',
): number[] {
  if (selectors === 'all') {
    return workbook.sheets
      .filter((sheet) => sheet.kind === 'worksheet')
      .map((sheet) => sheet.index);
  }

  const selected = new Set<number>();
  for (const selector of selectors) {
    const sheet =
      typeof selector === 'string'
        ? workbook.sheets.find((entry) => entry.name === selector)
        : workbook.sheets[selector];
    if (!sheet) {
      throw new SpreadsheetError('ERR_SHEET', `Unknown sheet: ${selector}`);
    }
    selected.add(sheet.index);
  }

  return [...selected];
}

/** Reuse the handle API so cell semantics, cancellation, and native parsing stay identical. */
export async function collectSheet(
  reader: WorkbookOpener,
  input: WorkbookInput,
  options: ReadSheetOptions,
  defaultMaxCells: number,
): Promise<SheetResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const selector = sheetSelector(options.sheet ?? 0);
  const reading = readOptions(options, defaultMaxCells, collectionBatchSize);
  const workbook = await openInput(reader, input, options);
  let result: SheetResult;

  try {
    result = await workbook.readSheet(selector, reading);
  } finally {
    await workbook.close();
  }

  signal?.throwIfAborted();
  return result;
}

export async function collectWorkbook(
  reader: WorkbookOpener,
  input: WorkbookInput,
  options: ReadWorkbookOptions,
  defaultMaxCells: number,
): Promise<WorkbookResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const selectors = snapshotSelectors(options.sheets);
  const reading = readOptions(options, defaultMaxCells, collectionBatchSize);
  const maxCells = integer(options.maxCells ?? defaultMaxCells, 'maxCells', 0);
  const includeVba = options.includeVba ?? false;
  if (typeof includeVba !== 'boolean') {
    throw new TypeError('includeVba must be a boolean');
  }
  const maxVbaBytes = integer(options.maxVbaBytes ?? 16 * 1024 * 1024, 'maxVbaBytes');
  const workbook = await openInput(reader, input, options);
  let result: WorkbookResult;

  try {
    // Resolve every selector before decoding the first sheet; repeated names/indices
    // refer to one result, preserving the caller's first-requested order.
    const indices = selectedIndices(workbook, selectors);
    const sheets: SheetResult[] = [];
    let remainingCells = maxCells;

    for (const index of indices) {
      const sheet = await workbook.readSheet(index, { ...reading, maxCells: remainingCells });
      remainingCells -= sheet.rowCount * sheet.columnCount;
      sheets.push(sheet);
    }

    result = { format: workbook.format, sheets, definedNames: workbook.definedNames };
    if (includeVba) {
      const vbaProject = await workbook.readVbaProject({
        maxBytes: maxVbaBytes,
        ...(signal === undefined ? {} : { signal }),
      });
      result = { ...result, vbaProject };
    }
  } finally {
    await workbook.close();
  }

  signal?.throwIfAborted();
  return result;
}
