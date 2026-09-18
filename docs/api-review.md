# API and performance review — 2026-09-18

## Judgment

The current implementation has a useful asynchronous foundation and measurable
speedups, but its public API and memory model are not a finished design for all
server-side spreadsheet workloads. Preserve the bounded AsyncTask execution and
small JS batches. Simplify ownership for ordinary callers, then use more of
Calamine's existing cell-reader capabilities for large-data paths.

This review describes proposed changes separately from the current public API.
No proposed API names below are exported yet.

## Scenarios

| Scenario                               | Current state                                                        | Recommended direction                                                               |
| -------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Read one small/medium sheet            | Open, read, close; correct but verbose                               | One-shot helper that owns cleanup, while retaining batched conversion internally    |
| Read selected/all sheets               | Caller loops and manages disposal                                    | One-shot workbook result with explicit selection and an aggregate result budget     |
| Inspect names/visibility/defined names | Supported metadata                                                   | Keep lightweight and preserve format-specific eager-opening costs                   |
| Read values and formulas               | Two reads, potentially two decompressions                            | Reuse XLSX next_cell_with_formula in a combined path when both are requested        |
| VBA/metadata extraction                | Optional method, separate from data reads                            | Keep demand-driven; avoid macro parsing on normal reads                             |
| Large row ingestion                    | Pull batches; native full Range allocation remains                   | Reuse upstream cell readers with bounded buffering and an explicit ownership design |
| Huge sparse sheets                     | Dense bounding rectangle can amplify memory; limit is late           | Cell-oriented traversal or sparse output before dense materialization               |
| JSON for storage/HTTP                  | Caller creates JS objects, then JSON.stringify                       | Native serialization to UTF-8 buffers/chunks; avoid an unnecessary JS object graph  |
| JSON for JS computation                | Returning native JSON still needs JSON.parse                         | Prefer typed rows/batches; benchmark before adding a string round trip              |
| Aliyun OSS/S3/HTTP streams             | Generic spool-to-file input with backpressure                        | Keep generic input; upstream needs seekable data, not a cloud SDK                   |
| Bursts/many open workbooks             | Task queue bounded; resident inputs and handles not globally bounded | Account for admitted bytes, open handles, and aggregate results                     |
| Cancellation/Worker shutdown           | Cooperative boundaries and explicit close                            | Keep graceful shutdown; document cancellation latency of running Calamine calls     |
| Node/Bun and multiple platforms        | Linux Node/Bun tests pass                                            | Validate platform artifacts and packed installs; no inferred cross-platform claims  |
| Workbook-specific features             | Some APIs omitted                                                    | Map proven upstream features separately; do not design another spreadsheet engine   |

## What Calamine already provides

Checked the supplied checkout (commit `0af05f4`) and the installed Calamine 0.36.1
crate source. The registry source, not the checkout alone, is the dependency contract.

- `auto.rs`: `open_workbook_auto` and `open_workbook_auto_from_rs`. Current bindings
  now reuse these. Arc-backed byte cursors prevent repeated whole-input clones
  during format attempts.
- `Reader`: sheet metadata, names, defined names, cached values, formula ranges and
  VBA projects. No independent workbook interpretation is needed.
- `Range`: `rows`, `cells`, `used_cells`, coordinates, headers and subranges. A subrange
  of an already loaded Range is not an input-level memory or decompression limit.
- `Xlsx::worksheet_cells_reader` and `Xlsb::worksheet_cells_reader`: read used cells
  incrementally, after opening a seekable workbook. This is the right foundation
  for large-sheet ingestion; it does not imply parsing a non-seekable ZIP download.
- `XlsxCellReader::next_cell_with_formula` and `next_cell_with_formula_metadata`:
  get values and formulas together, including shared-formula metadata.
- `ReaderRef`/`DataRef`: borrow shared strings where possible. These are format-specific;
  the generic auto-reader implementation uses `unimplemented!` for XLS/ODS, so never
  call it indiscriminately on an unknown format.
- `RangeDeserializerBuilder`: header selection and Serde deserialization into Rust
  types. It is not a generic lossless JSON writer: `deserialize_any` turns dates
  into serial numbers and treats Excel errors as deserialization failures.
- `ExcelDateTime`: epoch-aware calendar conversion, already used by the binding.
- Format-specific APIs: tables, merged cells, hyperlinks, pictures and pivot tables.
  Reuse those if exposed later; their availability differs by format.

Calamine does not supply a Node/Bun API, JavaScript-thread scheduling, JS object
conversion, a server queue, cloud downloads or a complete JSON/NDJSON output contract.
Those are legitimate responsibilities of a small binding/adaptation layer.

## Why the current batch implementation needs another step

The current route is `worksheet_range -> Range<Data> -> Rust batch -> JS arrays`.
It avoids sending all cells to JS in one turn, but the full Range has already been
allocated. Shared-string materialization can also introduce copies. Native and JS
representations coexist while a complete JS result is collected.

A cell reader borrows the workbook. Simply placing that borrowed reader next to its
owner in an exported class creates a self-referential lifetime problem. Do not solve
that by extending lifetimes with unsafe code. Evaluate safe ownership patterns with
bounded buffers; preserve incremental progress without occupying every shared libuv
worker while waiting for consumers. Dedicated producer threads, Tokio channels and
thread pools all have costs and need measurements before adoption.

Also preserve the output contract: a dense batch requires stable origin/width, while
the true used rectangle may not be known until traversal ends. File dimension hints
are not always trustworthy. A sparse cell stream or an explicit scan/metadata policy
is preferable to claiming that dense row streaming is a free wrapper around next_cell.

## API direction

Keep input, lifetime and output choices independent, without multiplying option
combinations into an opaque universal function:

1. A convenience layer for single-call sheet/workbook reads that always owns cleanup.
2. A workbook handle for repeated reads and inspection, with a small set of methods.
3. A large-data output path distinguishing JS rows from serialized UTF-8 bytes.

Factories are for applications that need admission limits; ordinary callers should
not have to construct a scheduler. Keep cell semantics identical across all layers.
Avoid automatic header-to-object conversion without a policy for duplicate/empty
headers, unstable schemas, error cells and names such as `__proto__`.

Public types also deserve refinement: format/kind strings are broad, and SpecialValue
is not yet a discriminated union correlating its kind with its value type. Improve
those before freezing the first public API. Keep native generated types internal
where they would otherwise dictate an awkward JavaScript contract.

## Measurements

Synthetic, local-only workloads; Intel Core i5-12400, Linux x64 GNU. One warmup,
five measured runs, warm filesystem cache, separate process per mode. Values below
are medians. The complete data and caveats are in [the JSON report](benchmarks/2026-09-18.json).

| Node 22.23.2 operation                  | 1,000,000 numeric cells | 100,000 long-string cells |
| --------------------------------------- | ----------------------: | ------------------------: |
| Native open/parse/close, no JS rows     |                  229 ms |                     41 ms |
| Current full readSheet                  |                  324 ms |                     73 ms |
| Consume batches without retaining rows  |                  316 ms |                     70 ms |
| One native batch with all rows          |                  343 ms |                     79 ms |
| SheetJS dense parse + row extraction    |                1,445 ms |                    488 ms |
| Serialize JS rows and count UTF-8 bytes |       18.8 ms / 6.99 MB |        22.4 ms / 26.01 MB |

Current full reads were about 4.5x and 6.6x faster than the compared SheetJS route on
these two samples. This is not a general speed guarantee or a production throughput
estimate. Concurrency, real styles/shared strings, XML shape and memory pressure can
change the result.

The maximum observed 1 ms heartbeat gap across five Node samples was about 2.9 ms
for current full reads. A single giant native result produced gaps up to 98 ms for
numeric cells and 26 ms for strings. Therefore, simplifying the _public call_ should
not discard internal batching. Whole-result conversion is not automatically faster.

JSON serialization reintroduced roughly 19–28 ms heartbeat gaps. The current package
does not solve this stage. Native JSON output may help consumers that store/send bytes;
consumers that need JS objects still pay for parsing or object construction.

Bun 1.4.1 full reads measured 272 ms and 78 ms respectively; the equivalent SheetJS
route measured 1,430 ms and 265 ms. Bun also shows synchronous JSON serialization
costs. Node and Bun memory metrics are not directly comparable.

Heap delta is not peak memory. Per-process peak RSS includes setup, loaded modules,
allocator retention and preceding warmups; the report must not be read as proving
constant-memory batching. In particular, batching does not consistently reduce the
measured process high-water RSS with the current Range-based implementation.

## Priorities before API stabilization

1. Preserve verified semantics, lifecycle behavior and upstream compatibility notes.
2. Add a convenience layer and improve public types without duplicating the parser.
3. Prototype native UTF-8 output and upstream cell-reader ingestion independently;
   compare throughput, first-batch latency, JS gaps and peak memory.
4. Introduce byte-aware admission/output budgets where measured demand justifies them.
5. Expand optional workbook features through existing Calamine APIs with fixtures.

A larger feature list is not, by itself, a better binding. The target is a small,
coherent API with explicit resource costs and a reliable path for each major workload.
