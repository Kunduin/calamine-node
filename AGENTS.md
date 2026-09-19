# Development conventions

## Purpose and scope

Build a small, reliable, read-only Calamine package for Node.js and Bun. Keep the
public TypeScript API focused on workbook capabilities. Ordinary callers use
`read(input, options)` to get complete JS data with automatic resource cleanup.
Its `sheets` option accepts names, zero-based indices, or lists; omitting it reads
all worksheets. Always return a workbook result with a `sheets` array, including for
a single selection. Strings are literal sheet names; avoid wildcard sentinels.
Keep one complete-read entry point instead of aliases with overlapping semantics.
Advanced callers use handles or batch iteration. All paths share the same flat sheet
result shape and cell semantics. Preserve readable metadata and matrix rows; optimize
per-cell costs before shortening field names. A workbook-wide cell budget is
aggregate, not per sheet. Keep cloud SDKs, HTTP clients, Aliyun OSS credentials,
business ingestion logic, and database writes outside the package. The application
can use its storage SDK to supply a Buffer, download directly to a local file, or
supply a byte stream to the reader.

Keep the scope focused on local paths, owned byte input, and the generic stream
adapter. Preserve invocation-time snapshots of mutable inputs. Do not add native
HTTP/S3/OSS clients or an async runtime solely to relocate SDK downloads.

Public complete-read types are `ReadInput`, `ReadOptions`, and `ReadResult`.
Opening a resource returns `WorkbookHandle`; sheet data uses `SheetResult`, and
incremental output uses `RowBatch`. Keep one canonical name per concept.

## Toolchain

- Use the official napi-rs CLI and generated bindings. Use pnpm for package management.
- Use stable `typescript` 7; do not substitute `@typescript/native-preview`.
- Use `oxfmt` and `oxlint` for JavaScript/TypeScript. Use `cargo fmt` and Clippy for Rust.
- Pin direct JavaScript development dependencies. Commit pnpm and Cargo lockfiles.
- Verify current versions against their official registries before upgrading.
- Use `node:test` and `node:assert/strict`; run the same compiled tests with Node and Bun.
- Never execute performance tests against production servers or production databases.

## Readability and module boundaries

- Prefer ordinary, idiomatic code over clever abstractions or densely packed statements.
- Separate responsibilities into cohesive files; keep entry points short.
- Use blank lines between declarations, methods, and distinct logical steps.
- Rust attributes directly precede their declaration: no blank line after `#[napi]`
  or `#[derive(...)]`. JSDoc directly precedes the declaration it documents.
- Run formatters, then review readability manually. Formatters do not decide good
  module boundaries or always remove misplaced blank lines.
- Keep implementation fields private. Construct cross-module tasks through `new`.
- `use` imports names; visibility is a separate Rust constraint. Keep the smallest
  useful visibility. Use `pub(crate)` only for actual crate-internal collaboration.
  At the crate root `pub(super)` has the same effective scope, so changing the spelling
  alone does not improve encapsulation.
- Avoid broad lint suppressions, `any`, unchecked casts, `unwrap`, `expect`, and unsafe Rust.

## Native and asynchronous design

- Rust owns concurrency, automatic waiting, and cancellation through the napi-rs-managed
  Tokio runtime. Calamine parsing and large explicit cleanup run in `spawn_blocking`
  after acquiring a reader permit; never run blocking parsing on async scheduler threads.
- Extra requests wait automatically and do not fail because the reader is busy.
  Do not add a public maxQueued option or queue-full rejection. Bound executing work,
  allow queued cancellation, and keep the ordinary read API easy to use.
- Use napi-rs `AsyncBlockBuilder` where the native entry point must snapshot borrowed
  bytes synchronously before returning a Promise. Async Rust
  functions implement waiting and execution without repetitive per-operation task structs.
  Do not create a custom runtime per reader or a duplicate JavaScript task queue.
- Omitted reader concurrency follows the actual napi-rs Tokio runtime's async worker
  count, normally available logical CPUs. Honor TOKIO_WORKER_THREADS through Tokio
  itself, and preserve an explicit per-reader override. Do not confuse async workers
  with the separate blocking pool's 512-thread default ceiling.
- Never retain borrowed JS data, an Env, or JS handles across threads. Snapshot
  mutable input at API invocation, before queuing it.
- Use upstream Calamine automatic detection, metadata, formulas, and VBA parsing.
  Avoid implementing Excel format detection or parsing independently.
- For automatic detection from memory, clone an immutable Arc-backed cursor;
  do not clone the entire workbook for every attempted format.
- Buffer/Uint8Array input makes one immutable Rust-owned snapshot at invocation,
  after cancellation and byte-limit checks. Do not add an intermediate JS Buffer copy,
  retain mutable JS storage for background work, or claim zero-copy parsing.
  Reject SharedArrayBuffer-backed views at the public boundary.
- Streams stay a backpressured JS adapter. Acquire a native execution permit before pulling
  input and transfer the same permit to parsing, without reacquiring a queue slot.
- Generate native bindings with the official napi-rs CLI; do not hand-edit them.
- Keep the project license in `LICENSE` (MIT); avoid a duplicate `NOTICE` entry point.
  Preserve bundled third-party license texts separately.
- Parsing and large explicit cleanup run in native workers. JS value construction
  still runs on the JS thread: bound each output batch and measure conversion costs.
- Input streaming means backpressured spooling to a seekable temporary file.
  Output batching does not make Calamine's worksheet allocation streaming.
- Cancellation must retain an active permit until native work actually finishes.
  Do not use Promise.race to pretend a native computation has stopped.
- Close handles explicitly, release iterators in finally, and await native work
  before graceful Worker shutdown. Never advertise abrupt Worker termination as safe.

## Data correctness and release quality

- Preserve coordinates, empty cells versus empty strings, error values, cached
  formula results, calendar components, and large integer precision.
- Use Calamine's merged-cell APIs for absolute, inclusive ranges. Preserve anchor
  values and ordinary blanks; never infer merges from empty cells or fill covered
  cells implicitly. Test offsets, empty merges and ranges crossing output batches.
- Do not invent timezones or evaluate formulas or VBA.
- A result cell limit is not a hard bound on decompression or native allocations.
- Cell counts are unlimited by default. `maxCells: Infinity` disables an inherited
  limit; finite budgets remain aggregate across selected sheets, and zero permits
  empty ranges only. Represent an absent native limit explicitly, without a numeric sentinel.
- Keep synthetic fixtures and explicitly licensed upstream fixtures. Never commit
  customer files, production workbooks, credentials, or private paths into examples.
- Document verified capabilities, known upstream gaps, and unverified platforms.
  Gate experimentally supported formats explicitly when correctness gaps are known.
- Test malformed inputs, limits, ownership, cancellation, early iterator return,
  cleanup, concurrency, native Workers, and the packed npm artifact.
- Run `pnpm build`, `pnpm check`, and `pnpm pack:check` before a release.
- Publishing requires complete platform artifacts and verified runtime tests;
  the local Linux build does not establish compatibility on other platforms.
- Keep the CI build matrix aligned with `napi.targets`. Test the resulting artifacts
  on matching architectures and C runtimes; cross-compilation alone is not runtime validation.
- Reuse build artifacts across Node versions, cache Rust compilation, bound job
  timeouts, and keep short artifact retention. Separate measured timings from cost estimates.
- Keep documentation focused on current behavior. Remove superseded design reviews,
  experiment patches, and machine-specific build logs; Git retains their history.
  Keep one reproducible performance report supporting README comparisons.
- Order the README as usage, performance, then development. Performance comparisons
  include elapsed time, main-thread CPU, and concurrent batches in readable tables.
  State the execution model and distinguish direct SheetJS calls from a Worker pool;
  do not present accumulated CPU time as one continuous event-loop stall.
- Keep all public API documentation in the README, including examples, options,
  return values, ownership, limits, and errors; do not create a separate API document.
  Remove repetition and omit provider-specific integration recipes.
  Label comparisons as Speedup, calculated as SheetJS elapsed time divided
  by calamine-node elapsed time; do not mix that with internal concurrency scaling.
- Write in a conventional library-author style: direct examples and clear contracts.
  Keep result shape, supported inputs, common options, batching, concurrency, and
  the public API overview in the README; do not shorten it by hiding essential usage
  behind reference links. Remove repetition and implementation digressions instead.
  Explain performance mechanisms briefly (Rust parsing, Tokio workers, batched JS
  conversion); keep detailed scheduling discussion in the development guide.
- npm artifacts contain runtime files, declarations, source-map sources, licenses,
  and the small public documentation set. Exclude agent instructions, tests, scripts,
  raw benchmark results, and development-only files from the package allowlist.
- Maintenance scripts use ESM, validate their arguments, and avoid embedding large
  test programs as strings. Keep optional benchmark tools outside package dependencies.
- Release Please maintains version PRs against `main`; do not maintain a separate
  long-lived release branch. Keep npm, Cargo, and Cargo.lock versions aligned.
- Release from a matching version tag. Run the full platform CI before packaging;
  publish platform tarballs before the root package. Keep GitHub releases as drafts
  until npm publication succeeds. Retry with the original tarballs and verify integrity.
- Use npm Trusted Publishing from `publish.yml` and the `npm` GitHub environment.
  Do not store an npm token in CI. New package names require a one-time authenticated
  bootstrap before trusted publishing can be configured.

## Commits

Use Conventional Commits with a type matching the change: `feat`, `fix`, `docs`,
`refactor`, `test`, `ci`, or `chore`. Release commits use `chore: release vX.Y.Z`;
do not label every change as `feat`.
Do not add Co-authored-by trailers. Do not publish npm packages or push to a remote
unless the user has requested it.
