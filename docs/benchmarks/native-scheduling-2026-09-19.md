# Native scheduling and input ownership — 2026-09-19

The implementation now reserves admission and schedules blocking work in Rust,
using the napi-rs-managed Tokio runtime. Mutable Buffer/Uint8Array input makes one
Rust-owned snapshot. Generic JS streams continue to spool to temporary files;
no network client was added.

These local measurements compare that implementation with commit `1f57e63` and
its archived baseline binary from the [dependency size experiment](native-size-2026-09-19.md).
The public `read` result, cell semantics, batching defaults, and Calamine version
are unchanged. Both facades were built with TypeScript 7.0.2 and use their own
matching native binary. The baseline's compiled library was reused, not rebuilt
with different compiler flags. The shared measurement helper adds `complete-buffer`
without changing either implementation's reading logic.

## Results

Median complete-read duration in milliseconds:

| Runtime   | Workbook          | Input      | Before |  After | Change |
| --------- | ----------------- | ---------- | -----: | -----: | -----: |
| v22.23.2  | 1M numeric cells  | Local file | 317.44 | 317.07 |  -0.1% |
| v22.23.2  | 1M numeric cells  | Buffer     | 322.14 | 324.08 |  +0.6% |
| v22.23.2  | 100K string cells | Local file |  77.35 |  73.79 |  -4.6% |
| v22.23.2  | 100K string cells | Buffer     |  78.80 |  73.75 |  -6.4% |
| Bun 1.4.1 | 1M numeric cells  | Local file | 267.04 | 271.93 |  +1.8% |
| Bun 1.4.1 | 1M numeric cells  | Buffer     | 268.97 | 264.69 |  -1.6% |
| Bun 1.4.1 | 100K string cells | Local file |  70.82 |  70.92 |  +0.1% |
| Bun 1.4.1 | 100K string cells | Buffer     |  73.13 |  74.55 |  +1.9% |

The large numeric workload is effectively unchanged in this run. Node's string
case improved, while Bun's string case stayed close to baseline. These five-sample
observations do not establish a general throughput improvement. The main changes
are fewer full-input copies, native admission before snapshot allocation, and
removing Calamine work from libuv's shared worker pool. JS array/string construction
and full Calamine range allocation remain.

## Artifact cost

Linux x64 GNU release build, Rust 1.98.1, thin LTO, stripped symbols:

| Artifact      |   Before |    After |    Added |
| ------------- | -------: | -------: | -------: |
| Native binary | 1.71 MiB | 2.28 MiB | 0.58 MiB |
| gzip level 6  | 0.79 MiB | 0.99 MiB | 0.20 MiB |

The complete scheduler adds more than the earlier minimal Tokio probe: it includes
native reader/stream permits, cancellable admission, and Promise bridges for all
operations. gzip size describes the binary alone, not the complete npm package.
No OpenDAL, HTTP, S3, or OSS dependencies are linked.

## Method and limits

Host: 12th Gen Intel(R) Core(TM) i5-12400, Linux x64. Node 22.23.2 and Bun 1.4.1.
Each case used a fresh process, one warmup and five measured serial operations,
with a warm filesystem cache. Baseline and current cases were run consecutively;
benchmark processes did not overlap. Node used `--expose-gc`; Bun used the helper's
available GC behavior. Buffer input was loaded once outside the timed interval.
Each read includes native parsing, JS result construction, and automatic cleanup.
The input source is a local synthetic workbook, never a production download.

The [raw report](native-scheduling-2026-09-19.json) records binary and fixture hashes,
input sizes, heartbeat gaps, heap deltas, native batch counts, and process peak RSS.
Peak RSS covers the whole process, including warmup and all samples; it is not an
isolated per-read peak. Heap deltas exclude native allocations and should not be
interpreted as total memory savings. Heartbeat gaps remain workload-dependent and
are not a hard event-loop latency guarantee.

Reproduce with the existing fixture generator and benchmark helper:

```sh
node scripts/generate-benchmarks.cjs /path/to/xlsx.js /tmp
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-workbook
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-buffer
bun scripts/benchmark.mjs /tmp/calamine-strings-100k.xlsx complete-workbook
bun scripts/benchmark.mjs /tmp/calamine-strings-100k.xlsx complete-buffer
```

## Validation

The current implementation passed 8 Rust tests and the same 42 integration tests
on Node and Bun. Coverage includes queued cancellation, retaining running permits,
shared admission across input types, mutable Buffer snapshots and view offsets,
SharedArrayBuffer rejection, full-queue cleanup, stream failures, paused iterators,
and native work inside a JS Worker followed by another read in its parent.
`pnpm build`, `pnpm check`, and `pnpm pack:check` passed, including Rust formatting,
strict Clippy, TypeScript 7 consumer checks, and offline packed installs on Node/Bun.
Only Linux x64 GNU was validated for this scheduler change; other targets still
need their configured CI builds and runtime checks.
