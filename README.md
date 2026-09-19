# calamine-node

Asynchronous, read-only spreadsheet parsing for Node.js and Bun, powered by
[Calamine](https://github.com/tafia/calamine) and [napi-rs](https://napi.rs).
Read XLSX, XLS, and XLSM from files, buffers, or byte streams into JavaScript rows.

**Status:** in development, not yet published to npm. Verified locally on Linux
x64 GNU with Node 22 and Bun 1.4; see [platforms](docs/platforms.md).

[Usage](#usage) · [Performance](#performance) · [Development](#development)

## Usage

Use `read` for complete data with automatic cleanup. Use `openFile`, `openBuffer`,
or `openStream` to keep a workbook open for inspection or repeated reads.
A workbook is a spreadsheet file; a sheet is one tab inside it.

### Read a workbook

```ts
import { read } from 'calamine-node';

const result = await read('/data/report.xlsx');
console.log(result.sheets[0]?.rows);

const sales = await read('/data/report.xlsx', { sheets: 'Sales' });
const first = await read('/data/report.xlsx', { sheets: 0 });
const selected = await read('/data/report.xlsx', { sheets: ['Sales', 'Forecast'] });
```

Omit `sheets` for all worksheets, or select by name or zero-based index. Every call
returns a `ReadResult` with `format`, `sheets`, and `definedNames`; each sheet contains
metadata and a `rows` matrix. Resources are closed automatically before completion.

For a sheet named `Sales`, the result looks like this:

```json
{
  "format": "xlsx",
  "sheets": [
    {
      "name": "Sales",
      "index": 0,
      "kind": "worksheet",
      "visibility": "visible",
      "origin": { "row": 0, "column": 0 },
      "rowCount": 2,
      "columnCount": 2,
      "rows": [
        ["item", "amount"],
        ["apples", 42]
      ]
    }
  ],
  "definedNames": []
}
```

`rows` contains raw cell values. Empty cells are `null`; empty strings stay `""`.
Dates, errors, and large integers use tagged values to preserve their meaning.
Selecting one sheet still returns a workbook result with a `sheets` array.
The first row is not treated as a header or converted into object keys.

### Files, buffers, and streams

Input can be a local path, file URL, `Buffer`/`Uint8Array`, Node/Web byte stream, or
async byte iterable:

```ts
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { read } from 'calamine-node';

const fromFile = await read('/data/report.xlsx');
const fromBuffer = await read(await readFile('/data/report.xlsx'));
const fromStream = await read(createReadStream('/data/report.xlsx'));
```

Buffers are copied once at invocation, so later mutations do not affect parsing.
Streams are consumed with backpressure and spooled to a temporary file before
parsing; the temporary file is removed automatically. For files already on disk,
pass the path directly.

### Read options

```ts
import { read } from 'calamine-node';

const controller = new AbortController();
const result = await read('/data/report.xlsx', {
  sheets: ['Sales', 'Forecast'],
  content: 'values', // Use 'formulas' to read formula text.
  includeVba: true,
  maxCells: 2_000_000,
  maxInputBytes: 64 * 1024 * 1024,
  maxVbaBytes: 16 * 1024 * 1024,
  signal: controller.signal,
});
```

`sheets` accepts names, zero-based indices, or lists; `[]` reads metadata only.
`content: 'values'` returns stored values, including cached formula results.
Formulas are not recalculated. `includeVba` adds the extracted project or `null`
when none exists; macros are never executed.

`maxCells` covers all selected sheet rectangles, including empty cells.
Limits and cancellation apply at read boundaries; they do not interrupt an active
Calamine call or impose a hard bound on native allocations.

### Keep a workbook open

An open handle exposes metadata without returning all rows. Use `readSheet` for
one complete sheet, or `readBatches` to consume its rows incrementally:

```ts
import { openFile } from 'calamine-node';

const workbook = await openFile('/data/report.xlsx');
try {
  console.log(workbook.sheets); // Sheet metadata: names, indices, kinds, visibility.
  console.log(workbook.definedNames);

  const sales = await workbook.readSheet('Sales');
  console.log(sales.rows);

  for await (const batch of workbook.readBatches('Forecast', { batchSize: 256 })) {
    console.log(batch.offset, batch.rows);
  }
} finally {
  await workbook.close();
}
```

`openFile`, `openBuffer`, and `openStream` return a `WorkbookHandle` for repeated
reads, metadata inspection, and batch iteration. Close it after use. Each batch
includes sheet metadata, the used range's origin and dimensions, and a row offset
relative to that origin. Batching limits JS result delivery; Calamine still
allocates a worksheet range in native memory.

XLSB and ODS require experimental opt-in. See the [API reference](docs/api.md) for
all options, cell types, and errors, and [format compatibility](docs/compatibility.md)
for known parser limitations.

### Read multiple files

```ts
import { read } from 'calamine-node';

const paths = ['/data/january.xlsx', '/data/february.xlsx'];
const results = await Promise.all(paths.map((path) => read(path)));
```

Parsing runs on native workers; extra requests wait automatically. Default
concurrency follows the runtime worker count, normally available logical CPUs.
Reuse a reader to share custom limits:

```ts
import { createReader } from 'calamine-node';

const reader = createReader({ concurrency: 4, maxCells: 1_000_000 });
const results = await Promise.all(paths.map((path) => reader.read(path)));
```

Queued buffers and retained results still consume memory. Each open workbook
allows one active sheet read or iterator; use separate workbooks for concurrent reads.

### API overview

| API                                      | Returns                       | Purpose                                      |
| ---------------------------------------- | ----------------------------- | -------------------------------------------- |
| `read(input, options?)`                  | `Promise<ReadResult>`         | Complete data with automatic cleanup         |
| `createReader(options?)`                 | `Reader`                      | Shared configuration and concurrency limits  |
| `openFile(path, options?)`               | `Promise<WorkbookHandle>`     | Open a local file or file URL                |
| `openBuffer(bytes, options?)`            | `Promise<WorkbookHandle>`     | Open a Buffer or Uint8Array snapshot         |
| `openStream(source, options?)`           | `Promise<WorkbookHandle>`     | Open a byte stream                           |
| `workbook.readSheet(sheet?, options?)`   | `Promise<SheetResult>`        | Read one sheet into rows                     |
| `workbook.readBatches(sheet?, options?)` | `AsyncGenerator<RowBatch>`    | Iterate through rows in batches              |
| `workbook.readVbaProject(options?)`      | `Promise<VbaProject \| null>` | Extract VBA source and references            |
| `workbook.close()`                       | `Promise<void>`               | Release native resources and temporary input |

`ReadResult` is plain data. A `WorkbookHandle` exposes sheet metadata and defined
names, and must be closed after use. `close()` is idempotent; `Symbol.asyncDispose`
is also supported. Read failures reject the returned Promise. Library failures use
`SpreadsheetError` with a stable `code`; invalid arguments raise `TypeError`.

## Performance

Calamine parses in Rust on Tokio's blocking thread pool, allowing independent
reads to run in parallel. Results are converted into JS values in batches to limit
the work done in each main-thread callback.

**Up to 6.5× faster single reads than SheetJS in these XLSX tests.** Speedup is
SheetJS elapsed time divided by calamine-node elapsed time.

Linux x64, i5-12400, Node 22.23.2 / Bun 1.4.1; medians of five runs after warmup.
Both readers return matching row data from preloaded Buffers. SheetJS CE 0.20.3
uses dense mode plus row conversion on the calling JS thread, without a Worker pool.

### Single reads

| Runtime | Cells per read | calamine-node |  SheetJS | Speedup |
| ------- | -------------- | ------------: | -------: | ------: |
| Node    | 1M numbers     |        327 ms | 1,454 ms |    4.4× |
| Node    | 100K strings   |         74 ms |   485 ms |    6.5× |
| Bun     | 1M numbers     |        275 ms | 1,259 ms |    4.6× |
| Bun     | 100K strings   |         75 ms |   241 ms |    3.2× |

Main-thread CPU and timer gaps, in milliseconds:

| Runtime | Cells per read | calamine CPU | SheetJS CPU | calamine timer gap | SheetJS timer gap |
| ------- | -------------- | -----------: | ----------: | -----------------: | ----------------: |
| Node    | 1M numbers     |         80.6 |      1415.3 |                2.3 |            1453.7 |
| Node    | 100K strings   |         22.8 |       481.2 |                2.7 |             485.9 |
| Bun     | 1M numbers     |         28.7 |      1252.4 |                1.8 |            1269.2 |
| Bun     | 100K strings   |         21.1 |       240.0 |                2.1 |             241.3 |

CPU is accumulated main-thread work; timer gap is the median of each run's largest
observed callback interval. These are measurements, not latency guarantees.

### Ten concurrent read requests

Total time for a `Promise.all` batch of ten reads of the same input. calamine-node
uses its default of twelve execution slots on this host; direct SheetJS calls run
sequentially on the JS thread.

| Runtime | Cells per read | calamine-node |  SheetJS | Speedup |
| ------- | -------------- | ------------: | -------: | ------: |
| Node    | 1M numbers     |       1.091 s | 14.488 s |   13.3× |
| Node    | 100K strings   |       0.341 s |  4.918 s |   14.4× |
| Bun     | 1M numbers     |       0.645 s | 14.899 s |   23.1× |
| Bun     | 100K strings   |       0.274 s |  2.532 s |    9.2× |

Main-thread measurements for the same batches, in milliseconds:

| Runtime | Cells per read | calamine CPU | SheetJS CPU | calamine timer gap | SheetJS timer gap |
| ------- | -------------- | -----------: | ----------: | -----------------: | ----------------: |
| Node    | 1M numbers     |        815.2 |     14275.0 |               11.2 |           14489.1 |
| Node    | 100K strings   |        250.3 |      4876.4 |               15.5 |            4918.8 |
| Bun     | 1M numbers     |        257.0 |     14853.5 |               14.2 |           14909.5 |
| Bun     | 100K strings   |        217.9 |      2523.2 |               74.6 |            2543.5 |

Input snapshots and JS result construction still use the main thread. Complete
results remain in memory until the batch finishes. Results depend on the workload;
see [methodology, raw-data details, and reproduction](docs/performance.md).

## Development

Requires stable Rust, Node >=22.13, pnpm, and Bun for compatibility tests.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm pack:check
```

See the [development guide](docs/development.md) for architecture, scripts, and releases.

[MIT License](LICENSE) · [Third-party licenses](THIRD_PARTY_LICENSES.txt)
