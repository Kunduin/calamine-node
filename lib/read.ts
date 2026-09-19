import { SpreadsheetError, integer } from './errors.js';
import { collectionBatchSize, normalizeSheetOptions, sheetSelector } from './options.js';
import type {
  OpenOptions,
  Reader,
  ReadOptions,
  SheetResult,
  SheetSelector,
  WorkbookHandle,
  ReadInput,
  ReadResult,
} from './types.js';

type WorkbookOpener = Pick<Reader, 'openFile' | 'openBuffer' | 'openStream'>;

function openInput(
  reader: WorkbookOpener,
  input: ReadInput,
  options: OpenOptions,
): Promise<WorkbookHandle> {
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

function snapshotSelectors(selectors: ReadOptions['sheets']): readonly SheetSelector[] | undefined {
  if (selectors === undefined) {
    return undefined;
  }
  if (typeof selectors === 'string' || typeof selectors === 'number') {
    return [sheetSelector(selectors)];
  }
  if (Array.isArray(selectors)) {
    return Array.from(selectors, sheetSelector);
  }

  throw new TypeError('sheets must be a name, zero-based index, or an array of these');
}

function selectedIndices(
  workbook: WorkbookHandle,
  selectors: readonly SheetSelector[] | undefined,
): number[] {
  if (selectors === undefined) {
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
export async function collectWorkbook(
  reader: WorkbookOpener,
  input: ReadInput,
  options: ReadOptions,
  defaultMaxCells: number,
): Promise<ReadResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const selectors = snapshotSelectors(options.sheets);
  const reading = normalizeSheetOptions(options, defaultMaxCells, collectionBatchSize);
  const maxCells = integer(options.maxCells ?? defaultMaxCells, 'maxCells', 0);
  const includeVba = options.includeVba ?? false;
  if (typeof includeVba !== 'boolean') {
    throw new TypeError('includeVba must be a boolean');
  }
  const maxVbaBytes = integer(options.maxVbaBytes ?? 16 * 1024 * 1024, 'maxVbaBytes');
  const workbook = await openInput(reader, input, options);
  let result: ReadResult;

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
