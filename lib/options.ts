import { integer } from './errors.js';
import type { ReadOptions, SheetSelector } from './types.js';

// Keep conversion callbacks short even for long strings, while reducing native
// calls for complete reads. WorkbookHandle also caps each batch by cell count.
export const collectionBatchSize = 512;

export function readOptions(
  options: ReadOptions,
  defaultMaxCells: number,
  defaultBatchSize: number,
): ReadOptions {
  const content = options.content ?? 'values';
  if (content !== 'values' && content !== 'formulas') {
    throw new TypeError('content must be values or formulas');
  }

  return {
    content,
    batchSize: integer(options.batchSize ?? defaultBatchSize, 'batchSize', 1, 10_000),
    maxCells: integer(options.maxCells ?? defaultMaxCells, 'maxCells', 0),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export function sheetSelector(selector: SheetSelector): SheetSelector {
  return typeof selector === 'string' ? selector : integer(selector, 'sheet index', 0);
}
