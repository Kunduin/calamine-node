# Performance

The README comparison measures complete JS row output, not Rust parsing alone.
This report covers the current Tokio implementation and public `read` API, measured
on 2026-09-19. Older design experiments and build logs are retained in Git history.

## Method

- Linux x64 GNU, Intel Core i5-12400, six physical cores / twelve logical CPUs.
- Node 22.23.2 and Bun 1.4.1; Calamine 0.36.1; SheetJS CE 0.20.3.
- Synthetic XLSX files from `scripts/generate-benchmarks.mjs`: 50,000 × 20 numeric
  cells (8,441,250 compressed bytes), and 10,000 × 10 strings of approximately 250
  characters each (1,677,646 compressed bytes).
- A fresh process per engine/runtime/input case, one complete warmup, then five
  measured reads or ten-request batches. Cases run serially, calamine-node before
  SheetJS. This is a local comparison, not a randomized benchmark study.
- Input is preloaded into a Buffer before timing. calamine-node's snapshot,
  parsing, JS conversion, and automatic native cleanup are timed. SheetJS uses
  `XLSX.read(buffer, { dense: true })` followed by `sheet_to_json` with `header: 1`,
  `raw: true`, and `defval: null` for every sheet.
- XLSX merge extraction is enabled by default. These synthetic files contain no
  merged cells; the additional XML scan is still included in every Calamine read.
- Warmup outputs are fingerprinted outside timing; row dimensions and SHA-256
  hashes match across engines. Each measured result's dimensions are checked.
- The script calls `globalThis.gc` before each sample when available; Node runs
  with `--expose-gc`. Per-case reports record whether forced GC was available.
  Inputs and complete JS results consume memory; no peak-memory advantage is claimed.

SheetJS uses the official package's `xlsx.js` Node entry. It executes on the calling
JS thread in this comparison. A separate Worker implementation would change
main-thread behavior;
its transfer, scheduling, and memory costs are not measured here.

## Single reads

Times are milliseconds. Elapsed time and main-thread CPU are medians across five
runs. Timer gap is the median of each run's largest observed gap between 1 ms
timer callbacks; it is not a worst-case latency bound.

| Runtime | Input        | Engine        | Elapsed | Main-thread CPU | Largest timer gap |
| ------- | ------------ | ------------- | ------: | --------------: | ----------------: |
| Node    | 1M numbers   | calamine-node |   453.0 |            81.2 |               2.4 |
| Node    | 1M numbers   | SheetJS       |  1488.5 |          1472.4 |            1490.4 |
| Node    | 100K strings | calamine-node |    94.4 |            22.7 |               2.8 |
| Node    | 100K strings | SheetJS       |   504.2 |           496.0 |             504.4 |
| Bun     | 1M numbers   | calamine-node |   396.9 |            27.2 |               2.2 |
| Bun     | 1M numbers   | SheetJS       |  1337.5 |          1332.0 |            1348.4 |
| Bun     | 100K strings | calamine-node |    89.5 |            18.4 |               1.9 |
| Bun     | 100K strings | SheetJS       |   242.7 |           240.9 |             242.8 |

## Concurrent reads: ten-request batches

The follow-up submits ten reads in one `Promise.all` batch. Each reads the same
preloaded synthetic Buffer independently. Input snapshots remain timed, and all
complete results remain retained until the batch finishes. The raw report records
this setup under `concurrentMethod`.

Both calamine configurations use the napi-rs runtime with
`TOKIO_WORKER_THREADS=12`, matching the host's logical CPU count. `concurrency: 1`
bounds native execution to one operation at a time; the default reader follows the
runtime's twelve-worker setting. All requests are submitted together in both cases.
The SheetJS baseline is direct synchronous parsing, so the batch runs sequentially
on the calling JS thread. This does not measure a separate SheetJS Worker pool.

All table values are milliseconds for the **whole ten-request batch**. Each case
uses a fresh process, one warmup batch and five measured batches. Only one benchmark
process runs at a time; no competing build or test jobs run during measurement.

| Runtime | Workload per request | Execution            | Batch elapsed | Main-thread CPU | Largest timer gap |
| ------- | -------------------- | -------------------- | ------------: | --------------: | ----------------: |
| Node    | 1M numbers           | calamine, limit 1    |        4408.1 |           856.5 |              19.3 |
| Node    | 1M numbers           | calamine, default 12 |        1271.5 |           817.6 |              10.7 |
| Node    | 1M numbers           | SheetJS, direct      |       14558.1 |         14429.3 |           14559.0 |
| Node    | 100K strings         | calamine, limit 1    |         935.5 |           377.9 |              21.8 |
| Node    | 100K strings         | calamine, default 12 |         356.2 |           257.6 |              16.9 |
| Node    | 100K strings         | SheetJS, direct      |        4920.2 |          4873.1 |            4920.8 |
| Bun     | 1M numbers           | calamine, limit 1    |        3826.5 |           267.5 |              21.4 |
| Bun     | 1M numbers           | calamine, default 12 |         829.9 |           255.2 |              17.0 |
| Bun     | 1M numbers           | SheetJS, direct      |       14640.5 |         14593.3 |           14652.4 |
| Bun     | 100K strings         | calamine, limit 1    |         874.4 |           319.0 |             127.5 |
| Bun     | 100K strings         | calamine, default 12 |         281.2 |           216.2 |              69.3 |
| Bun     | 100K strings         | SheetJS, direct      |        2817.8 |          2809.5 |            2822.1 |

README Speedup values compare SheetJS's direct-call elapsed time with calamine-node
at its default concurrency: 11.4× and 13.8× on Node, 17.6× and 10.0× on Bun.
Limit-one measurements remain in the report as additional data; they are not the
baseline for Speedup. These results include parsing and complete JS delivery.

Main-thread CPU is accumulated work, not the duration of one event-loop pause.
Native parsing leaves the JS thread available between result batches, while input
snapshots and result construction still use it. Concurrency and a faster total
read do not guarantee lower JS latency for every workload.

The repository's `docs/performance.json` retains all samples, fixture/output hashes,
native, JS implementation and benchmark-script hashes, and the SheetJS package
source/hash. That raw data is intentionally excluded from npm tarballs; this report
remains included.

## What the comparison supports

The measured complete reads are 3.3× and 5.3× faster on Node, and 3.4× and 2.7×
faster on Bun, respectively. Native parsing also leaves the JS thread available
for other work between result batches. It does not eliminate JS-thread costs or
prove a universal advantage for small files, every producer, XLS, or concurrent
customer workloads. Cell semantics outside these numeric/string fixtures differ
between libraries; see the [README](../README.md#cell-values-dates-and-formulas)
and [compatibility notes](compatibility.md) before migrating.

Native file input avoids loading the entire compressed file into a JS Buffer.
Batch consumption can avoid retaining all returned JS rows. Neither behavior is
measured by the Buffer/complete-result table, and neither makes Calamine allocate
worksheets incrementally. Concurrency bounds executing work, not queued input bytes
or retained results.

## Reproduce

Build the project, then obtain the
[official SheetJS 0.20.3 package](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz)
outside this repository. Supply its extracted `package/xlsx.js` path explicitly;
SheetJS is not a development or runtime dependency of calamine-node.

```sh
pnpm build
node scripts/generate-benchmarks.mjs /path/to/package/xlsx.js /tmp/calamine-bench

node --expose-gc scripts/benchmark.mjs \
  --input /tmp/calamine-bench/calamine-numeric-1m.xlsx --engine calamine
node --expose-gc scripts/benchmark.mjs \
  --input /tmp/calamine-bench/calamine-numeric-1m.xlsx --engine sheetjs \
  --sheetjs /path/to/package/xlsx.js
```

Repeat with `calamine-strings-100k.xlsx`. For Bun, replace `node --expose-gc` with
`bun`. Compare output hashes and dimensions before comparing timings. Run cases
serially and save the JSON output; competing builds or benchmarks distort results.

For the ten-request comparison, repeat the following with both inputs and runtimes:

```sh
export TOKIO_WORKER_THREADS=12

node --expose-gc scripts/benchmark.mjs \
  --input /tmp/calamine-bench/calamine-numeric-1m.xlsx \
  --engine calamine --requests 10 --concurrency 1
node --expose-gc scripts/benchmark.mjs \
  --input /tmp/calamine-bench/calamine-numeric-1m.xlsx \
  --engine calamine --requests 10
node --expose-gc scripts/benchmark.mjs \
  --input /tmp/calamine-bench/calamine-numeric-1m.xlsx \
  --engine sheetjs --sheetjs /path/to/package/xlsx.js --requests 10
```

This explicitly sets the runtime worker count to the host's twelve logical CPUs.
An explicit reader limit of one permits one native operation at a time; omitting
it follows the runtime's twelve-worker configuration. Requests are still submitted
as a batch in both cases, so the limit-one case is not ten sequential `await read`
calls. SheetJS's direct synchronous calls run sequentially despite `Promise.all`.

The same script accepts `--input-mode file` and `--samples 7` for focused experiments.
File mode includes file reading, with warm OS caches. Buffer mode reuses the same
input for each request; snapshots remain included. `Promise.all` retains complete
results until all requests finish.
Multiple requests do not make direct synchronous SheetJS parsing parallel.

See the [SheetJS input API](https://docs.sheetjs.com/docs/solutions/input/) and
[worker guidance](https://docs.sheetjs.com/docs/demos/bigdata/worker/) for its own
execution model. Main-thread CPU uses `process.threadCpuUsage`, which includes
synchronous native work and main-thread GC, not just JS source execution.
