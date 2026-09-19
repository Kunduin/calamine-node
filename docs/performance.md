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
  measured reads. Cases run serially, calamine-node before SheetJS. This is a
  local comparison, not a randomized benchmark study.
- Input is preloaded into a Buffer before timing. calamine-node's snapshot,
  parsing, JS conversion, and automatic native cleanup are timed. SheetJS uses
  `XLSX.read(buffer, { dense: true })` followed by `sheet_to_json` with `header: 1`,
  `raw: true`, and `defval: null` for every sheet.
- Warmup outputs are fingerprinted outside timing; row dimensions and SHA-256
  hashes match across engines. Each measured result's dimensions are checked.
- The script calls `globalThis.gc` before each sample when available; Node runs
  with `--expose-gc`. Per-case reports record whether forced GC was available.
  Inputs and complete JS results consume memory; no peak-memory advantage is claimed.

SheetJS uses the official package's `xlsx.js` Node entry. It executes on the calling JS thread in this
comparison. A separate Worker implementation would change main-thread behavior;
its transfer, scheduling, and memory costs are not measured here.

## Results

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

The same script accepts `--input-mode file`, `--requests 10`, `--concurrency 4`, and
`--samples 7` for focused experiments. File mode includes file reading, with warm
OS caches. Buffer mode reuses the same input for each request; snapshots remain
included. `Promise.all` retains complete results until all requests finish.
Multiple requests do not make direct synchronous SheetJS parsing parallel.

See the [SheetJS input API](https://docs.sheetjs.com/docs/solutions/input/) and
[worker guidance](https://docs.sheetjs.com/docs/demos/bigdata/worker/) for its own
execution model. Main-thread CPU uses `process.threadCpuUsage`, which includes
synchronous native work and main-thread GC, not just JS source execution.
