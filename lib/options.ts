import { integer } from './errors.js';
import type { SheetReadOptions, SheetSelector } from './types.js';

// Keep conversion callbacks short even for long strings, while reducing native
// calls for complete reads. OpenWorkbook also caps each batch by cell count.
export const collectionBatchSize = 512;

export function cellLimit(value: number): number {
  return value === Infinity ? value : integer(value, 'maxCells', 0);
}

export function normalizeSheetOptions(
  options: SheetReadOptions,
  defaultMaxCells: number,
  defaultBatchSize: number,
): Required<Omit<SheetReadOptions, 'signal'>> & Pick<SheetReadOptions, 'signal'> {
  const content = options.content ?? 'values';
  if (content !== 'values' && content !== 'formulas') {
    throw new TypeError('content must be values or formulas');
  }

  return {
    content,
    batchSize: integer(options.batchSize ?? defaultBatchSize, 'batchSize', 1, 10_000),
    maxCells: cellLimit(options.maxCells ?? defaultMaxCells),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

export function sheetSelector(selector: SheetSelector): SheetSelector {
  return typeof selector === 'string' ? selector : integer(selector, 'sheet index', 0);
}
