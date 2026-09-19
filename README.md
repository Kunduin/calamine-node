# calamine-node

Asynchronous, read-only spreadsheet parsing for Node.js and Bun, powered by
[Calamine](https://github.com/tafia/calamine) and [napi-rs](https://napi.rs).
Read XLSX, XLS, and XLSM from files, buffers, or byte streams into JavaScript rows.

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

Every call returns a `ReadResult` with `format`, `sheets`, and `definedNames`;
each sheet contains metadata and a `rows` matrix. Resources are closed before
the Promise resolves or rejects.

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
      "mergedCells": [],
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
Dates, errors, and large integers use [tagged values](#cell-values-dates-and-formulas).
Selecting one sheet still returns a workbook result with a `sheets` array.
The first row is not treated as a header or converted into object keys.
`read` returns JS data; `JSON.stringify(result)` serializes it synchronously.

Omit `sheets` to read all worksheets in workbook order, skipping chart/VBA sheet
types. Select by exact name, zero-based index, or a list of either. Selected sheets
follow the requested order, with duplicates removed; `index` remains the original
workbook index. Unknown names or indices reject the read. Strings such as `"all"`
and `"*"` are literal names. Use `sheets: []` for workbook metadata without rows.

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

Strings are local paths. For files already on disk, pass the path directly.
Calamine uses known filename extensions and attempts readers when the extension
is unknown. A misleading known extension can fail; supply bytes for content-based
detection. Keep an opened file unchanged until it is closed. File size is checked
at open time.

Buffers and Uint8Arrays are copied once into immutable Rust-owned storage at
invocation, respecting the view's offset and length. Later mutations do not affect
parsing, including while queued. There is no intermediate JS Buffer copy;
SharedArrayBuffer-backed views are rejected.

Streams accept `Uint8Array` or Buffer chunks, including empty chunks; strings are
rejected. Each chunk is written before pulling the next, providing backpressure.
Calamine requires seekable input, so the entire stream is spooled before parsing.
The temporary file is created exclusively with mode `0600` in a private directory,
subject to platform permission semantics, and removed on close, failure, or abort.
Sources are consumed once and asked to cancel/return on failure or abort; a custom
iterator may ignore that request, but library-owned files are still cleaned up.

### Read options

```ts
import { read } from 'calamine-node';

const controller = new AbortController();
const result = await read('/data/report.xlsx', {
  sheets: ['Sales', 'Forecast'],
  content: 'values', // Use 'formulas' to read formula text.
  includeVba: true,
  includeMergedCells: true, // Default for XLS/XLSX; false skips merge metadata.
  maxCells: 2_000_000, // Optional cap; unlimited by default.
  maxInputBytes: 64 * 1024 * 1024,
  maxVbaBytes: 16 * 1024 * 1024,
  signal: controller.signal,
});
```

`content: 'values'` returns stored values, including cached formula results.
Formulas are not recalculated. `includeVba: true` adds `vbaProject`, containing the
extracted project or `null` when none exists; otherwise the property is omitted.
`maxVbaBytes` defaults to 16 MiB. Macros are never executed.

Per-call input and cell limits override the reader's defaults. `batchSize` optionally
controls conversion batches; most complete reads should leave it unset. See
[batching](#batches), [cell values](#cell-values-dates-and-formulas), and
[limits and cancellation](#concurrency-limits-and-cancellation) below.

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
reads, metadata inspection, and batch iteration. `readSheet` returns one
`SheetResult`, with the same fields as an entry in `ReadResult.sheets`.
Both sheet methods default to index `0` when the selector is omitted.

The handle exposes `format`, `sheets`, `definedNames`, and `closed`. Metadata is
frozen and follows workbook order. Sheet kinds are `worksheet`, `dialog`, `macro`,
`chart`, or `vba`; visibility is `visible`, `hidden`, or `very-hidden`. Some sheet
kinds cannot be read as cell ranges. Defined names contain `{ name, formula }`.

Close handles after use. `close()` is idempotent, invalidates active iterators, and
waits for native cleanup, including in-flight work. `Symbol.asyncDispose` is also
supported: use `await using workbook = await openFile(path)` where explicit resource
management syntax is available. Discarding a Promise or relying on garbage collection
does not replace closing a handle.

### Batches

`readBatches` yields `RowBatch` objects:

| Field                                 | Meaning                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `name`, `index`, `kind`, `visibility` | Sheet metadata                                                         |
| `origin`                              | Zero-based `{ row, column }` of the used rectangle, or `null` if empty |
| `rowCount`, `columnCount`             | Dimensions of the complete used rectangle                              |
| `offset`                              | First row's zero-based offset relative to `origin`                     |
| `rows`                                | This batch's rows, padded with `null` inside the rectangle             |
| `mergedCells`                         | Absolute merged-cell ranges; included by default for XLS/XLSX          |

Leading unused rows and columns are represented by `origin`, without allocating
extra rows. An empty sheet yields one empty batch with zero dimensions. `readSheet`
collects all batches and returns the same metadata and rows without `offset`.

`readBatches` defaults to 256 rows per batch; complete reads use 512. Both reduce
the batch size for wide sheets to target at most 16,384 cells. `batchSize` accepts
1–10,000 rows and overrides the row ceiling. A single wider row can exceed the cell
target, and strings are not byte-limited.

Batch iteration honors consumer backpressure and limits JS value construction.
Calamine still allocates a complete worksheet range in native memory. XLS/ODS can
load all sheets while opening; XLSX/XLSB support lazy sheet loading. Complete reads
retain all returned cells in JS memory.

Breaking a `for await` loop closes the decoded sheet. If you advance an iterator
manually and stop early, call its `return()` or close the workbook. One workbook
allows one active read operation or iterator; another receives `ERR_BUSY`.
Use separate workbooks for concurrent reads.

### Merged cells

For XLS/XLSX, `read`, `readSheet`, and `readBatches` include merged-cell ranges by default.
Each sheet includes `mergedCells`, an array of inclusive, zero-based worksheet
ranges such as `{ start: { row: 0, column: 0 }, end: { row: 2, column: 0 } }`.
An empty array means no merges. Set `includeMergedCells: false` to skip extraction
and omit the field.

The top-left cell is the anchor. Raw rows remain unchanged: covered cells are not
filled with the anchor value, and ordinary empty cells remain distinguishable from
merged cells. Subtract `origin` from an absolute coordinate to index `rows`.
Merge ranges may extend beyond the value rectangle, including on an empty sheet.
Every batch carries the same absolute ranges, even when a merge crosses batches.

Calamine reads the ranges directly. XLSX requires an additional worksheet XML scan;
XLS retains them during opening. XLSB/ODS omit merge metadata by default; explicitly
setting `includeMergedCells: true` rejects with `ERR_UNSUPPORTED` for these formats.
`maxCells` bounds the value rectangle, not the total area covered by merge ranges.

### Cell values, dates and formulas

`Cell` is `string | number | boolean | null | SpecialValue`. Numeric floats keep
JavaScript's IEEE-754 limits. Special values use `{ kind, value }`, with an additional
`calendar` field for numeric datetimes:

| SpecialValue.kind | value                              | Additional information                                              |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `datetime`        | Excel serial number                | `calendar`: `[year, month, day, hour, minute, second, millisecond]` |
| `duration`        | Excel serial number in days        | No timezone conversion                                              |
| `datetime-iso`    | ISO date/time string               | Preserved from Calamine                                             |
| `duration-iso`    | ISO duration string                | Preserved from Calamine                                             |
| `error`           | Excel error string, e.g. `#DIV/0!` | A cell value, not an operation failure                              |
| `integer`         | Decimal string                     | Integers reported by Calamine outside JS's exact integer range      |

Calendar components respect the workbook's 1900/1904 date system, including Excel's
fictitious 1900-02-29. No timezone or display formatting is inferred. Calamine decides
whether a numeric cell is a date; see [format compatibility](docs/compatibility.md)
for known XLS style limitations and other parser gaps.

```ts
const values = await workbook.readSheet('Sheet1');
const formulas = await workbook.readSheet('Sheet1', { content: 'formulas' });
```

Value mode reads cached formula results, which may be missing or stale. Formula
mode returns formula strings and `null` holes, preserving format-specific syntax.
Its used range can differ from the value range; align cells by absolute coordinates.

### VBA

Use `includeVba: true` with `read`, or extract a project from an open handle:

```ts
const project = await workbook.readVbaProject({ maxBytes: 16 * 1024 * 1024 });
if (project) {
  for (const module of project.modules) console.log(module.name, module.source);
  for (const reference of project.references) console.log(reference.name, reference.path);
}
```

Returns `null` when no project exists. Modules contain decoded source; references
contain `name`, `description`, and `path`. Reference paths describe the authoring
machine and are not accessed. `maxBytes` defaults to 16 MiB and is checked after
extraction, before returning source to JS. The method also accepts `signal`.

### Read multiple files

```ts
import { read } from 'calamine-node';

const paths = ['/data/january.xlsx', '/data/february.xlsx'];
const results = await Promise.all(paths.map((path) => read(path)));
```

Parsing runs on native workers; extra requests wait automatically. Reuse a reader
to share custom limits:

```ts
import { createReader } from 'calamine-node';

const reader = createReader({ concurrency: 4, maxCells: 1_000_000 });
const results = await Promise.all(paths.map((path) => reader.read(path)));
```

### Concurrency, limits and cancellation

`createReader` accepts these options:

| Reader option         | Default                | Meaning                                               |
| --------------------- | ---------------------- | ----------------------------------------------------- |
| `concurrency`         | Runtime worker count   | Normally available logical CPUs; explicit range 1–128 |
| `maxInputBytes`       | 64 MiB                 | Input byte limit before decompression                 |
| `maxCells`            | `Infinity`             | Optional returned rectangle cell budget               |
| `tempDirectory`       | OS temporary directory | Parent directory for streamed input                   |
| `experimentalFormats` | `[]`                   | Opt in to XLSB and/or ODS, e.g. `['xlsb', 'ods']`     |

Default concurrency follows napi-rs's Tokio async worker count, including
`TOKIO_WORKER_THREADS` when set before loading the addon. It limits executing
operations, independently of Tokio's blocking pool ceiling. An explicit limit
changes the reader's concurrency without resizing the shared runtime.

Top-level functions share a default reader; `createReader` instances have independent
queues. Extra requests wait without occupying a worker or blocking the JS event loop.
There is no queue-full rejection. Concurrency does not limit idle handles or total
resident memory: queued Buffer snapshots, partially collected workbooks, and retained
results all consume memory. Reuse readers and pace submissions for large workloads.

Streams hold a slot while spooling, without occupying a native thread, and transfer
it to parsing. Queued streams are not pulled by the library; an already-started
producer may buffer independently. Local files open only after a slot is available.

There is no cell-count limit by default. Set `maxCells` to a nonnegative integer
(up to 4,294,967,295) to cap the dense used rectangle, including empty holes, or
`Infinity` to disable an inherited limit. The budget applies across all selected
sheets in a complete read; zero accepts empty ranges only. Finite limits are checked
after Calamine allocates the range, before JS conversion. Complete reads retain all
returned rows in JS memory; use batches when you can process rows incrementally.
`maxInputBytes` limits
compressed input, not ZIP expansion or peak memory. Use an isolated process with OS
limits when hard memory or time bounds are required.

`signal` cancels queued work before execution and releases queued input. During
streaming, it stops library I/O and requests producer cancellation. An active
Calamine call cannot be interrupted: rejection waits for it to finish and for
cleanup, retaining its execution slot until then. Cancellation between batches stops
further delivery. Abort reasons are preserved.

### API overview

| API                                      | Input / options                       | Returns                       |
| ---------------------------------------- | ------------------------------------- | ----------------------------- |
| `read(input, options?)`                  | `ReadInput`, `ReadOptions`            | `Promise<ReadResult>`         |
| `createReader(options?)`                 | `ReaderOptions`                       | `Reader`                      |
| `openFile(path, options?)`               | Local path or file URL, `OpenOptions` | `Promise<WorkbookHandle>`     |
| `openBuffer(bytes, options?)`            | Buffer or Uint8Array, `OpenOptions`   | `Promise<WorkbookHandle>`     |
| `openStream(source, options?)`           | `ByteStream`, `OpenOptions`           | `Promise<WorkbookHandle>`     |
| `workbook.readSheet(sheet?, options?)`   | `SheetSelector`, `SheetReadOptions`   | `Promise<SheetResult>`        |
| `workbook.readBatches(sheet?, options?)` | `SheetSelector`, `SheetReadOptions`   | `AsyncGenerator<RowBatch>`    |
| `workbook.readVbaProject(options?)`      | `VbaOptions`                          | `Promise<VbaProject \| null>` |
| `workbook.close()`                       | —                                     | `Promise<void>`               |

A `Reader` exposes the same `read`, `openFile`, `openBuffer`, and `openStream`
methods as the top-level exports. `OpenOptions` contains `maxInputBytes` and
`signal`; `SheetReadOptions` contains `content`, `includeMergedCells`, `maxCells`,
`batchSize`, and `signal`. `SheetSelector` is a name or zero-based index. `ByteStream` is an
`AsyncIterable<Uint8Array>` (including Node `Readable`) or Web
`ReadableStream<Uint8Array>`.

### Errors

Read failures reject the returned Promise; batch iteration rejects on advancement.
Native/library failures use `SpreadsheetError` with a stable `code`. Invalid
arguments raise `TypeError`; input-stream errors and AbortSignal reasons pass through.

| Code                                                 | Meaning                                                           |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `ERR_IO`, `ERR_INPUT`                                | Unreadable path or unsupported filesystem input                   |
| `ERR_WORKBOOK`                                       | Unsupported, corrupt, encrypted, or otherwise unreadable workbook |
| `ERR_SHEET`                                          | Unknown sheet or failure to read its range/formulas               |
| `ERR_INPUT_LIMIT`, `ERR_CELL_LIMIT`, `ERR_VBA_LIMIT` | Configured limit exceeded                                         |
| `ERR_EXPERIMENTAL_FORMAT`                            | XLSB/ODS requires explicit experimental opt-in                    |
| `ERR_UNSUPPORTED`                                    | Requested metadata is unavailable for the workbook format         |
| `ERR_BUSY`                                           | Another read operation is active on the same workbook handle      |
| `ERR_CLOSED`                                         | Workbook or iterator has been closed                              |
| `ERR_VBA`, `ERR_STATE`                               | VBA extraction failure or invalid native state                    |

Await native calls and close handles before a Worker exits. Abrupt termination
during native work is not a supported cancellation mechanism, particularly on Bun.

## Performance

Calamine parses in Rust on Tokio's blocking thread pool, allowing independent
reads to run in parallel. Results are converted into JS values in batches to limit
the work done in each main-thread callback.

**Up to 5.3× faster single reads than SheetJS in these XLSX tests.** Speedup is
SheetJS elapsed time divided by calamine-node elapsed time.

Linux x64, i5-12400, Node 22.23.2 / Bun 1.4.1; medians of five runs after warmup.
Both readers return matching row data from preloaded Buffers. Merge extraction is
enabled by default and included in these timings. SheetJS CE 0.20.3 uses dense mode
plus row conversion on the calling JS thread, without a Worker pool.

### Single reads

| Runtime | Cells per read | calamine-node |  SheetJS | Speedup |
| ------- | -------------- | ------------: | -------: | ------: |
| Node    | 1M numbers     |        453 ms | 1,488 ms |    3.3× |
| Node    | 100K strings   |         94 ms |   504 ms |    5.3× |
| Bun     | 1M numbers     |        397 ms | 1,337 ms |    3.4× |
| Bun     | 100K strings   |         89 ms |   243 ms |    2.7× |

Main-thread CPU and timer gaps, in milliseconds:

| Runtime | Cells per read | calamine CPU | SheetJS CPU | calamine timer gap | SheetJS timer gap |
| ------- | -------------- | -----------: | ----------: | -----------------: | ----------------: |
| Node    | 1M numbers     |         81.2 |      1472.4 |                2.4 |            1490.4 |
| Node    | 100K strings   |         22.7 |       496.0 |                2.8 |             504.4 |
| Bun     | 1M numbers     |         27.2 |      1332.0 |                2.2 |            1348.4 |
| Bun     | 100K strings   |         18.4 |       240.9 |                1.9 |             242.8 |

CPU is accumulated main-thread work; timer gap is the median of each run's largest
observed callback interval. These are measurements, not latency guarantees.

### Ten concurrent read requests

Total time for a `Promise.all` batch of ten reads of the same input. calamine-node
uses its default of twelve execution slots on this host; direct SheetJS calls run
sequentially on the JS thread.

| Runtime | Cells per read | calamine-node |  SheetJS | Speedup |
| ------- | -------------- | ------------: | -------: | ------: |
| Node    | 1M numbers     |       1.271 s | 14.558 s |   11.4× |
| Node    | 100K strings   |       0.356 s |  4.920 s |   13.8× |
| Bun     | 1M numbers     |       0.830 s | 14.641 s |   17.6× |
| Bun     | 100K strings   |       0.281 s |  2.818 s |   10.0× |

Main-thread measurements for the same batches, in milliseconds:

| Runtime | Cells per read | calamine CPU | SheetJS CPU | calamine timer gap | SheetJS timer gap |
| ------- | -------------- | -----------: | ----------: | -----------------: | ----------------: |
| Node    | 1M numbers     |        817.6 |     14429.3 |               10.7 |           14559.0 |
| Node    | 100K strings   |        257.6 |      4873.1 |               16.9 |            4920.8 |
| Bun     | 1M numbers     |        255.2 |     14593.3 |               17.0 |           14652.4 |
| Bun     | 100K strings   |        216.2 |      2809.5 |               69.3 |            2822.1 |

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
