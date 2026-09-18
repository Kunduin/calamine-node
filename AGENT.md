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

After the native dependency size comparison, keep the initial scope focused on
local paths, owned byte input, and the existing generic stream adapter. Local file
reading is explicitly supported. Defer native HTTP/S3/OSS clients and moving stream
I/O into Rust; the experiment is not a shipping implementation. Prioritize redundant
input-copy reduction and parsing/output costs while preserving invocation-time
snapshots of mutable inputs. Do not add a new async runtime solely to relocate SDK
downloads. See `docs/benchmarks/native-size-2026-09-19.md` for measured tradeoffs.

## Toolchain

- Start from the official latest napi-rs pnpm scaffold. Use pnpm for package management.
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

- Rust owns admission, concurrency, and cancellation through the napi-rs-managed
  Tokio runtime. Calamine parsing and large explicit cleanup run in `spawn_blocking`
  after acquiring a reader permit; never run blocking parsing on async scheduler threads.
- Use napi-rs `AsyncBlockBuilder` where the native entry point must reserve admission
  or snapshot borrowed bytes synchronously before returning a Promise. Async Rust
  functions implement waiting and execution without repetitive per-operation task structs.
  Do not create a custom runtime per reader or a duplicate JavaScript task queue.
- Never retain borrowed JS data, an Env, or JS handles across threads. Snapshot
  mutable input at API invocation, before queuing it.
- Use upstream Calamine automatic detection, metadata, formulas, and VBA parsing.
  Avoid implementing Excel format detection or parsing independently.
- For automatic detection from memory, clone an immutable Arc-backed cursor;
  do not clone the entire workbook for every attempted format.
- Buffer/Uint8Array input makes one immutable Rust-owned snapshot at invocation,
  after admission and byte-limit checks. Do not add an intermediate JS Buffer copy,
  retain mutable JS storage for background work, or claim zero-copy parsing.
  Reject SharedArrayBuffer-backed views at the public boundary.
- Streams stay a backpressured JS adapter. Reserve native admission before pulling
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
- Do not invent timezones or evaluate formulas or VBA.
- A result cell limit is not a hard bound on decompression or native allocations.
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

## Commits

Use Conventional Commit subjects such as `feat: add asynchronous workbook reading`.
Do not add Co-authored-by trailers. Do not publish npm packages or push to a remote
unless the user has requested it.
