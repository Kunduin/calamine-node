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
| Node    | 1M numbers   | calamine-node |   327.2 |            80.6 |               2.3 |
| Node    | 1M numbers   | SheetJS       |  1453.5 |          1415.3 |            1453.7 |
| Node    | 100K strings | calamine-node |    74.2 |            22.8 |               2.7 |
| Node    | 100K strings | SheetJS       |   485.3 |           481.2 |             485.9 |
| Bun     | 1M numbers   | calamine-node |   274.7 |            28.7 |               1.8 |
| Bun     | 1M numbers   | SheetJS       |  1259.0 |          1252.4 |            1269.2 |
| Bun     | 100K strings | calamine-node |    75.3 |            21.1 |               2.1 |
| Bun     | 100K strings | SheetJS       |   241.2 |           240.0 |             241.3 |

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
| Node    | 1M numbers           | calamine, limit 1    |        3166.7 |           902.2 |              19.5 |
| Node    | 1M numbers           | calamine, default 12 |        1091.5 |           815.2 |              11.2 |
| Node    | 1M numbers           | SheetJS, direct      |       14488.4 |         14275.0 |           14489.1 |
| Node    | 100K strings         | calamine, limit 1    |         633.8 |           258.3 |              17.3 |
| Node    | 100K strings         | calamine, default 12 |         341.1 |           250.3 |              15.5 |
| Node    | 100K strings         | SheetJS, direct      |        4918.2 |          4876.4 |            4918.8 |
| Bun     | 1M numbers           | calamine, limit 1    |        2595.9 |           321.3 |              26.1 |
| Bun     | 1M numbers           | calamine, default 12 |         644.9 |           257.0 |              14.2 |
| Bun     | 1M numbers           | SheetJS, direct      |       14899.0 |         14853.5 |           14909.5 |
| Bun     | 100K strings         | calamine, limit 1    |         619.4 |           244.0 |              87.5 |
| Bun     | 100K strings         | calamine, default 12 |         274.3 |           217.9 |              74.6 |
| Bun     | 100K strings         | SheetJS, direct      |        2531.8 |          2523.2 |            2543.5 |

Raising calamine's execution limit from one to twelve reduces numeric batch elapsed
time by a factor of 2.90 on Node and 4.03 on Bun; string batches improve by 1.86 and
2.26 respectively. This measures native concurrency plus JS delivery, not an
isolated parser or thread-pool microbenchmark.

Main-thread CPU is accumulated work, not the duration of one event-loop pause.
The Node numeric batch uses about 815 ms on that thread across a 1,091 ms read;
its median per-run largest timer gap is about 11 ms. Conversely, Bun's string batch
finishes sooner than Node's but shows a larger timer gap (about 75 versus 15 ms).
The measurements do not isolate the cause of that difference. Concurrency and a
faster total read do not guarantee lower JS latency for every workload.

The repository's `docs/performance.json` retains all samples, fixture/output hashes,
native and benchmark-script hashes, and the SheetJS package source/hash. That raw
data is intentionally excluded from npm tarballs; this report remains included.

## What the comparison supports

The measured complete reads are 4.4× and 6.5× faster on Node, and 4.6× and 3.2×
faster on Bun, respectively. Native parsing also leaves the JS thread available
for other work between result batches. It does not eliminate JS-thread costs or
prove a universal advantage for small files, every producer, XLS, or concurrent
customer workloads. Cell semantics outside these numeric/string fixtures differ
between libraries; see the README and compatibility notes before migrating.

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
