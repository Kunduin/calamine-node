# calamine-node

Asynchronous spreadsheet reading for Node.js and Bun, powered by
[Calamine](https://github.com/tafia/calamine) and [napi-rs](https://napi.rs).

Read local files, buffers, Node streams, Web streams, or asynchronous byte
iterables. Parsing runs on native workers. Receive a complete worksheet or pull
rows in batches. Ordinary calls return complete JavaScript data and clean up
automatically; workbook handles are available for advanced use.

**Status:** initial development release; not yet published to npm. Linux x64 GNU
has been tested locally on Node 22 and Bun 1.4. The CI configuration targets
additional platforms, whose compatibility must be verified before publication.

## Capabilities

| Capability                         | Behavior                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| XLSX, XLS, XLSM                    | Read cells, sheet metadata, cached values and formula text                    |
| XLSB, ODS                          | Experimental, explicit opt-in; see [compatibility](docs/compatibility.md)     |
| Local paths and file URLs          | Native file reading; no JavaScript read of the entire file                    |
| Buffer and Uint8Array              | Snapshot the specified byte view at invocation                                |
| Node/Web streams and AsyncIterable | Backpressured download to a private temporary file                            |
| Batch output                       | Pull-based async iteration; at most one decoded sheet per active operation    |
| Defined names                      | Name and formula strings, as reported by Calamine                             |
| VBA                                | Extract module source and reference metadata on request; never execute macros |
| Dates and cell errors              | Preserve explicit tagged values instead of guessing JS Date timezones         |
| Cancellation                       | AbortSignal for admission, download and result delivery                       |
| Disposal                           | Idempotent close and Symbol.asyncDispose                                      |

This is a reader. It does not write spreadsheets, recalculate formulas, render
styles, expose images/merged-cell geometry/tables, or provide a browser/WASM build.
It does not yet expose every format-specific Calamine API.

## Build and run locally

Install a current stable Rust toolchain, Node >=22.13, pnpm 12.4.2 and Bun for the
compatibility tests. The project uses stable TypeScript **7.0.2**, not native-preview.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm pack:check
```

The official napi-rs CLI builds the addon and generates its loader and declarations.
Consumers of a future release with a matching prebuilt binary will not need Rust.
See [development and packaging](docs/development.md) for platform and release details.

## Read complete JavaScript data

A **workbook** is an Excel file. A **sheet** is one tab inside that workbook.
Use `read` for complete data, selecting one, several, or all worksheets:

```ts
import { read } from 'calamine-node';

const workbook = await read('/data/report.xlsx');
console.log(workbook.format, workbook.definedNames);
for (const sheet of workbook.sheets) {
  console.log(sheet.name, sheet.origin, sheet.rows);
}

const selected = await read('/data/report.xlsx', { sheets: 'Sales' });
console.log(selected.sheets[0]?.rows);

await read('/data/report.xlsx', { sheets: 0 }); // First sheet, using its zero-based index.
await read('/data/report.xlsx', { sheets: ['Sales', 'Forecast'] });
```

`read` always returns a workbook result containing a `sheets` array, even when only
one sheet is selected. It returns ordinary JavaScript objects and arrays, without
native handles or a `close()` obligation. Resources are closed before the Promise
resolves or rejects.
It accepts a local path, file URL, `Uint8Array`/`Buffer`, Node/Web byte stream, or
asynchronous byte iterable. Strings are file paths; remote downloads are supplied
by the caller as bytes or a stream.

The result has this shape. The advanced workbook handle's `readSheet` method returns
one sheet object with the same fields as an entry in this `sheets` array:

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

`JSON.stringify(result)` produces JSON text; `read` itself returns JS data.
`rows` is a matrix of cells. The reader does not assume that the first row contains
unique column names or silently convert rows into records keyed by headers.

Omitting `sheets` reads all **worksheets** in workbook order; chart/VBA sheet types
are skipped. A string selects one exact name, a number selects one zero-based index,
and an array selects several sheets. Strings such as `"all"` and `"*"` are literal
names, not special selectors. Results follow the requested order, with duplicate
names/indices resolved to one result. Each sheet's `index` remains its original
workbook index. Unknown names or indices reject the read. `sheets: []` returns an
empty `sheets` array and workbook metadata, optionally including VBA.

```ts
const workbook = await read(input, {
  sheets: ['Sales', 'Forecast'], // Omit for all worksheets.
  content: 'values', // Or 'formulas'; formulas are never evaluated.
  maxCells: 2_000_000, // Aggregate budget across selected sheet rectangles.
  maxInputBytes: 64 * 1024 * 1024,
  includeVba: false,
  maxVbaBytes: 16 * 1024 * 1024,
  signal: controller.signal,
});
```

`maxCells` counts cells including empty holes across all selected sheets. When one
sheet is selected, the same budget applies to that sheet. Zero accepts empty
ranges only. Limits are checked before JS materialization but after Calamine's
native range allocation. `includeVba: true` adds `vbaProject` to the result, containing
the extracted project or `null` if absent; otherwise the property is omitted.

Complete reads automatically size internal conversion batches by sheet width, up
to 16,384 cells and 512 rows per batch (a single wider row can exceed the cell
target). An optional `batchSize` overrides the row ceiling while keeping the cell
cap. Most callers should leave it unset. This reduces native calls for narrow sheets
without delivering an entire huge object graph in one JS-thread callback. The final
result still occupies memory proportional to all returned cells; large JSON
serialization is a separate, synchronous JS operation.

Use `createReader(configuration).read(...)` to share custom concurrency limits,
a temporary directory, or experimental format opt-ins.
Per-call input and cell limits override that reader's defaults.

## Keep a workbook open for inspection or repeated reads

```ts
import { openFile } from 'calamine-node';

const workbook = await openFile('/data/report.xlsx');
try {
  console.log(workbook.format, workbook.sheets, workbook.definedNames);
  console.log((await workbook.readSheet('Sheet1')).rows);
} finally {
  await workbook.close();
}
```

A handle's `sheets` contains metadata entries in workbook order. Sheet kinds are
`worksheet`, `dialog`, `macro`, `chart`, or `vba`; visibility is `visible`, `hidden`,
or `very-hidden`. Some non-worksheet types cannot be read as cell ranges. Metadata
is frozen. Defined names contain `{ name, formula }`, without evaluating formulas.

Calamine uses known filename extensions for local files and attempts readers when
the extension is unknown. A misleading known extension can fail: supply a Buffer
for content-based detection in that case. Treat an opened file as immutable until
closed; input limits inspect its size at open time.

Where explicit resource management syntax is supported (including the project's
TypeScript build), `await using workbook = await openFile(path)` closes automatically.
A discarded Promise or garbage collection is not a substitute for `close()` on a
handle. Prefer `read` when you do not need to manage a handle.

## Buffers and input streams

```ts
import { readFile } from 'node:fs/promises';
import { openBuffer, openStream } from 'calamine-node';

const workbook = await openBuffer(await readFile('/data/report.xls'));
try {
  console.log((await workbook.readSheet()).rows);
} finally {
  await workbook.close();
}

const response = await fetch('https://example.org/report.xlsx');
if (!response.ok || !response.body) throw new Error('Download failed');
const downloaded = await openStream(response.body);
try {
  console.log((await downloaded.readSheet()).rows);
} finally {
  await downloaded.close();
}
```

`openStream` accepts `AsyncIterable<Uint8Array>` (including Node `Readable`) and Web
`ReadableStream<Uint8Array>`. Buffer chunks are accepted; strings are rejected. Each
chunk is written before pulling the next one. Empty chunks are allowed. Sources are
consumed once and are asked to cancel/return on failure or abort.

**Input streaming is not incremental Excel decoding.** Calamine needs seekable input.
The entire download finishes before the workbook opens. A directory created with
`mkdtemp` contains a file opened exclusively with mode `0600` (subject to platform
permission semantics). Close removes it; failures and cancellation also clean it up.
An uncooperative custom iterator can ignore cancellation; the library still releases
its own file and observes late Promise rejections.

Cloud SDKs stay outside this package. For Aliyun OSS, pass the readable returned by
your SDK's `getStream` operation to `openStream`. Authentication, retries and network
timeouts remain the caller's responsibility. The same API works for S3, HTTP and
other byte sources, without vendor-specific dependencies.

## Batches and all worksheets

```ts
import { openFile } from 'calamine-node';

const workbook = await openFile('/data/report.xlsx');
try {
  for (const sheet of workbook.sheets) {
    if (sheet.kind !== 'worksheet') continue;
    for await (const batch of workbook.readBatches(sheet.index, { batchSize: 256 })) {
      const absoluteFirstRow = (batch.origin?.row ?? 0) + batch.offset;
      console.log(sheet.name, absoluteFirstRow, batch.rows);
    }
  }
} finally {
  await workbook.close();
}
```

Each batch contains:

- `name`, `index`, `kind`, `visibility`: sheet metadata, directly on the result.
- `origin`: zero-based `{ row, column }` for the used rectangle, or `null` if empty.
- `rowCount`, `columnCount`: dimensions of the complete used rectangle.
- `offset`: first row's zero-based offset relative to the rectangle's origin.
- `rows`: only this batch's rows, padded with `null` inside that rectangle.

An empty sheet yields one empty batch with zero dimensions. Leading unused rows
and columns are represented by `origin`; they are not materialized as extra rows.
`workbook.readSheet` collects batches and returns the same metadata and all rows, without
`offset`. It therefore retains the full JavaScript result.

Batching limits JS value construction and honors consumer backpressure. It does
**not** make native worksheet memory constant: Calamine constructs a worksheet range
first. XLS/ODS can load all sheets while opening; XLSX/XLSB support lazy sheet loading.
Explicit `readBatches` iteration defaults to 256 rows, additionally reduced to roughly
16,384 cells. Complete reads use the automatic batching described above.
An exceptionally wide single row can exceed that target; strings are not byte-limited.
Breaking a `for await` loop closes the decoded sheet. When manually advancing an
iterator, call its `return()` or close the workbook if you stop early.

One workbook allows one active read operation/iterator; another gets `ERR_BUSY`.
Use separate workbooks for concurrent reads. Closing a workbook invalidates its
iterators and waits for native cleanup, even when an operation is in flight.

## Cell values, dates and formulas

Cells are `string | number | boolean | null | SpecialValue`. Empty strings stay empty
strings; empty cells become `null`. Numeric floats keep JavaScript's IEEE-754 limits.

| SpecialValue.kind | value                              | Additional information                                              |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `datetime`        | Excel serial number                | `calendar`: `[year, month, day, hour, minute, second, millisecond]` |
| `duration`        | Excel serial number in days        | No timezone conversion                                              |
| `datetime-iso`    | ISO date/time string               | Preserved from Calamine                                             |
| `duration-iso`    | ISO duration string                | Preserved from Calamine                                             |
| `error`           | Excel error string, e.g. `#DIV/0!` | A cell value, not an operation failure                              |
| `integer`         | Decimal string                     | Integers reported by Calamine outside JS's exact integer range      |

Calendar components respect the workbook's 1900/1904 date system, including Excel's
fictitious 1900-02-29. There is no implicit UTC/local timezone or display formatting.
Calamine's format recognition decides whether a numeric cell is a date; see known
XLS style limitations in the compatibility notes.

```ts
const values = await workbook.readSheet('Sheet1');
const formulas = await workbook.readSheet('Sheet1', { content: 'formulas' });
```

Default values include the formula results cached in the file. Missing or stale
cached results are not recalculated. Formula mode returns formula strings and
`null` holes. Its used range and origin can differ from the value range; align by
absolute coordinates. Formula syntax is preserved, including ODS-specific notation.

## VBA

```ts
const project = await workbook.readVbaProject({ maxBytes: 16 * 1024 * 1024 });
if (project) {
  for (const module of project.modules) console.log(module.name, module.source);
  for (const reference of project.references) console.log(reference.name, reference.path);
}
```

Returns `null` when no project exists. Modules contain decoded source. References
contain `name`, `description`, and `path`. Paths describe the authoring machine;
we neither access them nor label them broken based on the server's filesystem.
The source size limit is checked after Calamine extracts it, before returning to JS.

## Concurrency, limits and cancellation

```ts
import { createReader } from 'calamine-node';

const reader = createReader({
  concurrency: 2,
  maxQueued: 8,
  maxInputBytes: 64 * 1024 * 1024,
  maxCells: 2_000_000,
  // tempDirectory: '/data/tmp',
  // experimentalFormats: ['xlsb', 'ods'],
});
const controller = new AbortController();
const workbook = await reader.openFile('/data/report.xlsx', { signal: controller.signal });
try {
  await workbook.readSheet(0, { signal: controller.signal, maxCells: 100_000 });
} finally {
  await workbook.close();
}
```

The example lists defaults. Top-level complete-read and open functions share one
default reader; factories create independent queues. Reuse readers so their
concurrency limit has meaning.
`maxQueued: 0` allows no waiting public operations; overflow rejects with
`ERR_QUEUE_FULL`. Cleanup remains admissible so saturation cannot prevent disposal.
Downloads occupy admission slots as well. Limits apply per reader, not process-wide.

`maxCells` counts the whole dense used rectangle, including empty holes, and can be
overridden for a read. Complete workbook reads share this budget across selected
sheets. It limits returned results **after native allocation**, not ZIP expansion
or peak RSS. `maxInputBytes` limits input bytes before decompression; queued Buffer
calls retain snapshots and memory usage scales with queue size. Calamine's allocations,
shared strings, returned values and multiple open workbooks are additional memory.
For hostile documents or hard memory/time budgets, use an isolated process with OS
limits; this API is not a decompression sandbox.

Queued cancellation prevents admission. Download cancellation stops library I/O and
requests producer cancellation. Once Calamine computation starts, it cannot be
interrupted mid-call; rejection waits for it to finish and resources to be cleaned
up. The active permit is retained until the task completes. Cancellation between
batches prevents further delivery. Abort reasons are preserved.

`AsyncTask` uses the runtime's shared native worker pool. The default of two limits
competition with filesystem/DNS/crypto work; it does not reserve threads. JS input
snapshots and result conversion still consume JS-thread time. See the
[napi-rs concurrency guide](https://napi.rs/docs/more/async-concurrency).

## Errors

Native/library failures use `SpreadsheetError` with a stable `code`. Invalid arguments
raise `TypeError`; upstream input-stream errors and AbortSignal reasons pass through.

| Code                                                 | Meaning                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `ERR_IO`, `ERR_INPUT`                                | Unreadable path or unsupported filesystem input                  |
| `ERR_WORKBOOK`                                       | Unsupported, corrupt, encrypted or otherwise unreadable workbook |
| `ERR_SHEET`                                          | Unknown sheet or failure to read its range/formulas              |
| `ERR_INPUT_LIMIT`, `ERR_CELL_LIMIT`, `ERR_VBA_LIMIT` | Configured limit exceeded                                        |
| `ERR_EXPERIMENTAL_FORMAT`                            | XLSB/ODS requires explicit experimental opt-in                   |
| `ERR_QUEUE_FULL`, `ERR_BUSY`                         | Admission or workbook concurrency boundary                       |
| `ERR_CLOSED`                                         | Workbook or iterator has been closed                             |
| `ERR_VBA`, `ERR_STATE`                               | VBA extraction failure or invalid native state                   |

Await native calls and close handles before a Worker exits. Abrupt termination during
native work is not a supported cancellation mechanism, particularly on Bun.

## Development

See [AGENT.md](AGENT.md) for code-quality conventions and
[docs/development.md](docs/development.md) for tests, architecture and packaging.
All fixtures are synthetic or attributed upstream samples. Benchmarks run locally.

MIT licensed; see [LICENSE](LICENSE). Third-party dependency license texts are
included in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).
