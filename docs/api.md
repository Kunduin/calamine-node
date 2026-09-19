# API reference

See the [README](../README.md) for quick usage and performance comparisons.
This reference documents input ownership, return values, options, and resource lifetime.

## TypeScript API

Types follow the operation or data they describe:

| API                                    | Input/configuration                   | Return type                   |
| -------------------------------------- | ------------------------------------- | ----------------------------- |
| `read`                                 | `ReadInput`, `ReadOptions`            | `Promise<ReadResult>`         |
| `createReader`                         | `ReaderOptions`                       | `Reader`                      |
| `openFile`, `openBuffer`, `openStream` | Path, bytes, or stream; `OpenOptions` | `Promise<WorkbookHandle>`     |
| `workbook.readSheet`                   | `SheetSelector`, `SheetReadOptions`   | `Promise<SheetResult>`        |
| `workbook.readBatches`                 | `SheetSelector`, `SheetReadOptions`   | `AsyncGenerator<RowBatch>`    |
| `workbook.readVbaProject`              | `VbaOptions`                          | `Promise<VbaProject \| null>` |

`ReadResult` is ordinary data. `WorkbookHandle` owns native resources and must be
closed; its `sheets` contain metadata until you request rows. Selecting one sheet changes the contents of `ReadResult.sheets`, not the return type.

## Read complete JavaScript data

A **workbook** is an Excel file. A **sheet** is one tab inside that workbook.
Use `read(input, options)` for complete data from one, several, or all worksheets.

`read` always returns a `ReadResult` containing a `sheets` array, even when only
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
const result = await read(input, {
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

Buffer and Uint8Array input is copied **once into Rust-owned immutable storage**,
inside the native call and before it returns a Promise. The specified view's offset
and length are respected. You may modify or reuse the input after calling `read`
or `openBuffer`, including when parsing is queued. No intermediate JS Buffer is
created. This is not a zero-copy API: sharing mutable JS memory with a background
parser would make that guarantee unsafe. SharedArrayBuffer-backed views are rejected.
For large inputs already on disk, pass the local path so JS never loads the file.

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

## Batches and all worksheets

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

| Reader option         | Default                | Meaning                                               |
| --------------------- | ---------------------- | ----------------------------------------------------- |
| `concurrency`         | Runtime worker count   | Normally available logical CPUs; explicit range 1–128 |
| `maxInputBytes`       | 64 MiB                 | Input byte limit before decompression                 |
| `maxCells`            | 2,000,000              | Returned rectangle cell budget                        |
| `tempDirectory`       | OS temporary directory | Parent directory for streamed input                   |
| `experimentalFormats` | `[]`                   | Opt in to XLSB and/or ODS                             |

Use `createReader(options)` to share configuration. Per-call input and cell limits
override the reader defaults.

Omitted `concurrency` uses the actual worker count of napi-rs's Tokio runtime: normally the
number of available logical CPUs, with Tokio's `TOKIO_WORKER_THREADS` override
honored when set before loading the addon. An explicit `concurrency` (1–128)
overrides the reader's limit without resizing that shared runtime.

This is a bound on CPU-heavy blocking operations. It follows Tokio's async worker
count, not the separate `spawn_blocking` pool's default ceiling of 512 threads.
See [Tokio's runtime configuration](https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html#method.worker_threads).
Top-level complete-read and open functions share one default reader; factories
create independent queues. Reuse readers so their concurrency limit has meaning.
Additional requests **wait automatically** until an execution slot becomes free.
There is no queue-length option or queue-full error. Waiting does not occupy a
worker or block the JS event loop, and an AbortSignal can cancel a waiting request.

Streams hold a slot while being spooled, without occupying a native thread, and
transfer it to parsing when the download finishes. Queued streams are not pulled
by the library. An already-started SDK download may have its own buffering policy.
Local files are opened only after a slot becomes available. Buffer snapshots are
taken at invocation and stay resident while queued, so total queued bytes still
matter when submitting many in-memory files. Completed JS results also remain in
memory for as long as the caller retains them. Concurrency applies per reader,
not process-wide, and does not limit idle open handles or the total number of
partially collected workbooks. Automatic waiting handles a burst; it does not
bound memory if submissions continually outpace completion.

`maxCells` counts the whole dense used rectangle, including empty holes, and can be
overridden for a read. Complete workbook reads share this budget across selected
sheets. It limits returned results **after native allocation**, not ZIP expansion
or peak RSS. `maxInputBytes` limits input bytes before decompression; queued Buffer
calls retain snapshots and memory usage scales with queue size. Calamine's allocations,
shared strings, returned values and multiple open workbooks are additional memory.
For hostile documents or hard memory/time budgets, use an isolated process with OS
limits; this API is not a decompression sandbox.

Queued cancellation prevents execution and releases the queued input. Download cancellation stops library I/O and
requests producer cancellation. Once Calamine computation starts, it cannot be
interrupted mid-call; rejection waits for it to finish and resources to be cleaned
up. The active permit is retained until the task completes. Cancellation between
batches prevents further delivery. Abort reasons are preserved.

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
| `ERR_BUSY`                                           | Another read operation is active on the same workbook handle     |
| `ERR_CLOSED`                                         | Workbook or iterator has been closed                             |
| `ERR_VBA`, `ERR_STATE`                               | VBA extraction failure or invalid native state                   |

Await native calls and close handles before a Worker exits. Abrupt termination during
native work is not a supported cancellation mechanism, particularly on Bun.
