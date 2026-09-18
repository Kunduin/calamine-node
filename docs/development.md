# Development and packaging

## Layout

- `src/source.rs`: Calamine input types and delegation to upstream readers.
- `src/cell.rs`: explicit cell-value conversion, including dates/errors/large integers.
- `src/reader.rs`: native inputs and one-copy byte snapshots.
- `src/executor.rs`, `src/cancellation.rs`: bounded Tokio scheduling and owned cancellation state.
- `src/stream.rs`: a stream's native permit, transferred from JS spooling to parsing.
- `src/workbook.rs`, `src/sheet.rs`, `src/vba.rs`: owned resources and Calamine operations.
- `lib/reader.ts`: validated input entry points and concurrency configuration.
- `lib/read.ts`: sheet selection and complete workbook collection with automatic cleanup and aggregate limits.
- `lib/options.ts`: shared option validation and collection defaults.
- `lib/workbook.ts`: public lifetime and iteration behavior.
- `lib/native.ts`: AbortSignal/error adaptation at the native boundary.
- `lib/stream.ts`: backpressured temporary input spooling.
- `native/`: generated napi-rs loader/declarations and local compiled binaries.
- `test/`: portable node:test suites and attributed fixtures.

Read [the API review](api-review.md) before expanding the public surface. It separates
current implementation from proposed improvements and inventories existing Calamine
capabilities to avoid duplicating upstream functionality.

Remote downloads remain an application concern. Pass a storage SDK's Buffer to
`read`, download directly to a local file and pass its path, or use the existing
generic stream input. Local file reading remains a native capability. The
[native dependency size comparison](benchmarks/native-size-2026-09-19.md) informed
the decision to defer HTTP/S3/OSS clients; its isolated probes are not part of the
published API or the project's dependencies.

## Native ownership and scheduling

The exported `NativeReader` is internal to the facade. Byte views are borrowed only
for the calling JS thread's synchronous entry and copied directly into an `Arc<[u8]>`. Calamine's
automatic format attempts clone an Arc-backed cursor, not the full input. Paths
are opened on a blocking worker without a preliminary JS file read.

`AsyncBlockBuilder` connects a Rust future to a JS Promise while preserving that
synchronous entry phase. The future awaits a reader semaphore, then uses Tokio's
`spawn_blocking` for synchronous Calamine work. Parsing does not run on Tokio's
async scheduler threads or libuv's shared worker pool. The runtime belongs to
napi-rs; creating a reader adds one semaphore, not another runtime or thread pool.
When `concurrency` is omitted, the native constructor enters that runtime and reads
`Handle::current().metrics().num_workers()`. This reuses Tokio's actual CPU/environment
configuration without reimplementing it in JS or Rust. `TOKIO_WORKER_THREADS` is
therefore honored at runtime initialization. Explicit reader limits remain supported;
the blocking pool's separate maximum is not used as the parser's default concurrency.

A stream acquires the same concurrency permit before the facade pulls input. JS adapts Node/Web/iterable streams and awaits each temporary-file
write. Its permit moves into the native open operation without competing for a
second slot. Spooling therefore holds bounded capacity without blocking a native
thread. The native layer has no network client.

A small owned watch channel carries cancellation into Rust. The JS bridge removes
its AbortSignal listener when the native Promise settles and preserves the original
abort reason. Waiting tasks can exit promptly; a running Calamine call retains its
permits until it actually finishes. Returned handles are adopted and closed before
reporting cancellation, so an abort cannot strand a range allocated during parsing.
The native workbook also owns its active sheet range, allowing explicit close to
release a paused iterator. Explicit cleanup waits for an execution slot and cannot be cancelled.
Extra work queues automatically with no queue-length option or queue-full error.
The executor has one semaphore for running work; no second admission quota exists.
Queued Buffer snapshots still occupy memory, while queued paths do not open files
and queued streams are not pulled until they obtain a permit.

JS must still build JS values on its own thread. Rust prepares owned batch values;
napi-rs creates arrays and strings on delivery. Complete reads collect bounded
batches through the same path as handle iteration. No intermediate native JSON
serialization or JavaScript JSON parsing is added.

The [local scheduling comparison](benchmarks/native-scheduling-2026-09-19.md)
records complete-read timings, binary size, and validation of this implementation.
The [concurrency follow-up](benchmarks/concurrency-2026-09-19.md) separates main-thread
CPU from elapsed time and records the switch to a runtime-derived default limit.
The [Rayon experiment](benchmarks/rayon-2026-09-19.md) compares the CPU executor at
matched concurrency and records why Tokio remains the shipping implementation.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm pack:check
```

`check` runs oxfmt, cargo fmt, oxlint, Clippy with warnings denied, strict TypeScript
checks, Rust tests, and the same compiled integration tests under Node and Bun.
`pack:check` is currently a POSIX development/CI script. It packs the local binary,
installs the tarball offline into a temporary project, and verifies package imports
and native loading with both runtimes. Temporary files are removed in finally.

Use `pnpm format` before reviewing changes. Generated native loader and declaration
files are excluded from formatting/linting; regenerate them with `pnpm build:native`.
Both language sources are formatted; Rust attributes stay attached to declarations.

The package uses Node-API 8. Stable TypeScript 7 builds ESM JS and declarations;
CommonJS import behavior is not part of the initial public compatibility contract.
Rust's `dyn-symbols` feature allows pure Rust unit tests to link without a Node host;
the real Node-API boundary is validated by Node and Bun integration tests. Complete
reads and handle reads use the same sheet result shape: metadata is directly
available as `sheet.name`, `sheet.index`, `sheet.kind` and `sheet.visibility`.
`read(input, options)` always returns `WorkbookResult`; selecting one sheet changes
the contents of `result.sheets`, not the return type. `ReadOptions` configures complete
reads, while `SheetReadOptions` configures a handle's `readSheet` and `readBatches`.

## Platform builds

The napi-rs scaffold configuration lists:

- Linux x64/arm64, GNU and musl.
- macOS x64/arm64.
- Windows x64/arm64, MSVC.

The workflow builds and tests Node 22 on every target, using matching CPU architectures
and Alpine containers for musl. Bun tests cover Linux GNU x64 and ARM64; the quality
job checks packed installs. Node 24/26 tests reuse the build artifacts on Linux GNU
x64, macOS ARM64 and Windows x64 without recompiling. CI is configured but has not
been run remotely for this new repository. See [platform verification and costs](platforms.md)
for local results, tooling, runner choices and billing assumptions.

There is deliberately no automatic publish job. Building an artifact is not proof
that it works on its target host.

## Preparing a future release

1. Finalize the public API, package ownership/name, repository URL and supported target set.
2. Pass all checks, including current compatibility notes and representative producer workbooks.
3. Build and test every target being advertised, then collect all `.node` artifacts under `native/`.
4. Run the official CLI's `pnpm exec napi create-npm-dirs` to generate platform packages.
5. Use `pnpm artifacts` to copy collected artifacts into those platform packages.
6. Review `pnpm exec napi prepublish --dry-run` and the generated optional dependencies.
   The non-dry-run prepublish command can publish platform packages; it is a release
   action, not a normal build/check command.
7. Verify release tarballs and clean installs for every supported target before publishing
   platform packages and then the main package with provenance.

The local tarball bundles the current host's binary. It is a smoke-test artifact,
not a complete cross-platform release. No remote repository or npm package was
created by initialization.

## Reproduce performance measurements

Only use local synthetic or explicitly approved files. The helper accepts an
explicit SheetJS installation path as an optional comparison tool; SheetJS is not
an installed dependency of this package.

```sh
node scripts/generate-benchmarks.cjs /path/to/xlsx.js /tmp
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-workbook
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-buffer
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-sheet
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet-256
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet-512
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx parse-only
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx single-native-batch
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx batches
node --expose-gc scripts/benchmark.mjs /tmp/calamine-strings-100k.xlsx stringify
node --expose-gc scripts/benchmark.mjs /tmp/calamine-strings-100k.xlsx parse-json
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx sheetjs /path/to/xlsx.js
bun scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet
```

The `complete-sheet` mode calls `read(path, { sheets: 0 })`; `complete-workbook` calls
`read(path)`. Archived reports retain the API names used when measured.
`complete-buffer` preloads bytes once outside the timed operation, then measures
`read(buffer)`, including its synchronous input snapshot and automatic cleanup.

The helper measures one warmup and five runs. Do not run competing benchmarks in
parallel. Record hardware, runtimes, input shape, warm/cold state, first-result and
completion times, JS heartbeat gaps and memory methodology. Compare semantically
equivalent results, not just differently configured parsers.
