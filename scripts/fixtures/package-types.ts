import { Readable } from 'node:stream';
import {
  createReader,
  openFile,
  read,
  type Cell,
  type Reader,
  type ReadInput,
  type ReadOptions,
  type ReadResult,
  type RowBatch,
  type SheetReadOptions,
  type SheetResult,
  type WorkbookHandle,
} from 'calamine-node';

const input: ReadInput = Buffer.alloc(0);
const options: ReadOptions = {
  sheets: ['Sales', 0],
  content: 'formulas',
  maxCells: 100,
  maxInputBytes: 1_000_000,
  includeVba: true,
  signal: new AbortController().signal,
};
const result: ReadResult = await read(input, options);
const selected: ReadResult = await read(new URL('file:///example.xlsx'), { sheets: 'Sales' });
const reader: Reader = createReader();
await reader.read(Readable.from([Buffer.alloc(0)]));
await reader.read(new ReadableStream<Uint8Array>());

const workbook: WorkbookHandle = await openFile('example.xlsx');
const sheetOptions: SheetReadOptions = { maxCells: 100 };
const sheet: SheetResult = await workbook.readSheet(0, sheetOptions);
const rows: Cell[][] = sheet.rows;
const batches: AsyncGenerator<RowBatch> = workbook.readBatches('Sales');

// @ts-expect-error Complete data does not expose resource-management methods.
void result.close;
// @ts-expect-error A handle exposes sheet metadata until a read is requested.
void workbook.sheets[0]?.rows;

console.log(result, selected, rows, batches);
await workbook.close();
