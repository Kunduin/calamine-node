# Concurrent reads and JavaScript thread costs — 2026-09-19

Single-file elapsed time does not establish concurrent throughput, main-thread CPU
cost, or event-loop latency. This follow-up measures those separately and informs
the change from a fixed default concurrency of two to Tokio's actual worker count.

The explicit-limit measurements below predate removal of the public queue-length
bound. Subsequent builds queue extra work automatically instead of returning a
queue-full error; the running-task semaphore and CPU-based default remain.

## Decision

Leave napi-rs's runtime and Tokio's blocking-pool configuration intact. Omitted
reader concurrency follows `Handle::current().metrics().num_workers()`, normally
available logical CPUs. This automatically honors `TOKIO_WORKER_THREADS` configured
before loading the addon. Explicit reader concurrency still overrides the execution limit.
Before the queue-bound removal, the host's effective default was independently
checked as **12** using native stream permits. Current default/override tests instead
verify that an extra stream waits until an active stream releases its permit.

Tokio's [async worker default](https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html#method.worker_threads)
is based on available CPUs. Its [blocking-pool default](https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html#method.max_blocking_threads)
is a separate ceiling of **512**, with threads created on demand. The latter is
not an appropriate CPU parser parallelism target. We keep the native semaphore
rather than allowing all CPU-heavy requests into that pool without a reader bound.

For this host, numeric Buffer throughput at concurrency 6 and automatic concurrency
12 was very close (1,090.5 ms and 1,082.6 ms for ten files). There is no evidence here
that pushing beyond available CPUs would help. The main thread already accounts
for about 0.82 seconds of CPU per ten complete results.

## Results

Node 22.23.2 on an Intel Core i5-12400, six physical cores / twelve logical CPUs.
Each numeric file contains 1,000,000 cells and is 8,441,250 compressed bytes. Each
string file contains 100,000 cells, approximately 250 characters per value, and is
1,677,646 compressed bytes. Ten requests use ten independent copies of the same
synthetic workbook. This controls input shape; it does not represent a mixed customer workload.

All times are milliseconds. CPU is accumulated main-thread user + system time.
Gap is the median of each batch's largest observed interval between 1 ms heartbeat
callbacks. It is not a worst-case bound across every run or all future workloads.

| Implementation     | Cells per file | Input  | Requests | Concurrency | Total elapsed | Main-thread CPU | Event-loop utilization | Heartbeat max gap |
| ------------------ | -------------- | ------ | -------: | ----------: | ------------: | --------------: | ---------------------: | ----------------: |
| Previous           | 1M numbers     | buffer |        1 |           2 |         326.6 |            84.2 |                  25.7% |               3.7 |
| Native scheduler   | 1M numbers     | buffer |        1 |           2 |         330.9 |            81.3 |                  24.7% |               3.2 |
| Previous           | 1M numbers     | buffer |       10 |           2 |        1945.3 |           819.2 |                  42.5% |              17.6 |
| Native scheduler   | 1M numbers     | buffer |       10 |           2 |        1911.5 |           798.2 |                  41.9% |              20.6 |
| Previous           | 1M numbers     | buffer |       10 |           4 |        1345.4 |           835.1 |                  62.8% |              32.4 |
| Native scheduler   | 1M numbers     | buffer |       10 |           4 |        1304.0 |           811.0 |                  62.9% |              24.5 |
| Previous           | 1M numbers     | buffer |       10 |          10 |        1353.0 |           843.5 |                  63.7% |              44.0 |
| Native scheduler   | 1M numbers     | buffer |       10 |          10 |        1103.7 |           827.9 |                  77.1% |              14.4 |
| Previous           | 1M numbers     | file   |       10 |           2 |        1990.7 |           823.8 |                  41.7% |               3.8 |
| Native scheduler   | 1M numbers     | file   |       10 |           2 |        2032.0 |           833.8 |                  41.5% |              12.0 |
| Previous           | 1M numbers     | file   |       10 |           4 |        1350.9 |           799.4 |                  60.6% |               4.9 |
| Native scheduler   | 1M numbers     | file   |       10 |           4 |        1292.6 |           781.2 |                  61.1% |              10.9 |
| Previous           | 1M numbers     | file   |       10 |          10 |        1327.9 |           803.8 |                  62.3% |              12.5 |
| Native scheduler   | 1M numbers     | file   |       10 |          10 |        1114.2 |           820.1 |                  76.2% |              13.5 |
| Previous           | 100K strings   | buffer |        1 |           2 |          88.2 |            30.3 |                  37.0% |               3.6 |
| Native scheduler   | 100K strings   | buffer |        1 |           2 |          81.6 |            27.8 |                  37.3% |               3.1 |
| Previous           | 100K strings   | buffer |       10 |           2 |         475.5 |           248.7 |                  55.5% |              12.8 |
| Native scheduler   | 100K strings   | buffer |       10 |           2 |         511.4 |           324.4 |                  66.2% |              20.5 |
| Previous           | 100K strings   | buffer |       10 |          10 |         399.2 |           267.6 |                  71.2% |              16.9 |
| Native scheduler   | 100K strings   | buffer |       10 |          10 |         345.7 |           254.5 |                  77.4% |              15.2 |
| CPU default change | 1M numbers     | buffer |       10 |           6 |        1090.5 |           822.4 |                  76.0% |              12.0 |
| CPU default change | 1M numbers     | buffer |       10 |   auto (12) |        1082.6 |           821.2 |                  77.3% |              21.4 |
| CPU default change | 1M numbers     | file   |       10 |   auto (12) |        1065.1 |           797.9 |                  76.5% |              10.1 |
| CPU default change | 100K strings   | buffer |       10 |   auto (12) |         354.8 |           265.6 |                  78.1% |              17.1 |

Ten numeric Buffer reads improved from **1,945.3 ms** with the old default of two
to **1,082.6 ms** with the new automatic limit of twelve: approximately **44% less
wall time**, or **1.80× throughput** for this batch. Main-thread CPU stayed near
**819–821 ms**. This comparison combines the scheduler change with a higher default.
At the same explicit concurrency of ten, the scheduler comparison was 1,353.0 ms
versus 1,103.7 ms. The previous AsyncTask version still used Node's default libuv
pool of four threads; increasing its reader limit does not resize that shared pool.

The improvement is not universal. With concurrency two, the native scheduler's
ten-string-file case was slower (511.4 ms versus 475.5 ms), and several timer and
filesystem-probe delays were worse. Automatic concurrency improved that workload
to 354.8 ms in the follow-up, but it does not make arbitrary concurrent JS delivery
free. The full sample data preserves these regressions and variability.

Creating the same JS cell arrays still needs main-thread work. More parallel native
parsing delivers that work in a shorter interval, so event-loop utilization can
rise even when accumulated main-thread CPU is nearly unchanged. An accumulated
0.82 seconds is spread across batches; it is not one uninterrupted 0.82-second
pause. Conversely, using native async work does not guarantee short JS callbacks:
Buffer snapshots, Node-API value construction and garbage collection still matter.

A serial asynchronous `fs.stat` probe ran approximately every 10 ms. In the explicit
concurrency-ten string case, its median per-batch p95 fell from 112.8 ms to 12.3 ms.
Other cases did not uniformly improve. These probe timings include native queueing,
OS scheduling and JS callback delivery, so they are not an isolated measurement
of libuv waiting time. See the raw report rather than extrapolating a universal
I/O-latency gain from this one case.

## Equal thread-pool comparison

The original libuv baseline above used its default pool of four. A follow-up sets
`UV_THREADPOOL_SIZE=12` in **both** implementations, with parser concurrency twelve.
This separates pool capacity from the location of the queue. Each row still uses
ten complete reads, one warmup and five measured batches.

| Input                     | Previous elapsed | Tokio elapsed | Previous main-thread CPU | Tokio main-thread CPU |
| ------------------------- | ---------------: | ------------: | -----------------------: | --------------------: |
| 1M numeric cells, Buffer  |        1098.9 ms |     1089.0 ms |                 839.1 ms |              829.8 ms |
| 1M numeric cells, file    |        1080.5 ms |     1083.0 ms |                 796.7 ms |              812.7 ms |
| 100K string cells, Buffer |         371.6 ms |      343.3 ms |                 275.0 ms |              259.6 ms |

At matched capacity, numeric throughput is essentially the same. This does not
support claiming that moving a queue from JS to Rust inherently speeds up parsing,
or that Tokio's blocking executor is inherently faster than libuv. The scheduler
change chiefly gives the parser its own execution pool and simpler native ownership;
reduced input copies and workload-specific allocation behavior remain relevant.
Removing a queue-full error is an API choice, separate from choosing an executor.

## Measurement

The [raw report](concurrency-2026-09-19.json) includes all five samples per case,
completion times, input submission duration, process CPU and peak RSS, fixture
hashes and native artifact identifiers. Each case starts a fresh process, performs
one full-batch warmup, then five measured batches with forced GC beforehand. Cases
run serially with warm input caches. Buffer inputs are loaded before timing;
snapshots, parsing, complete JS construction and native cleanup are timed.
`Promise.all` retains all results until the last completes. A streaming consumer
that discards batches would have different memory behavior.

[process.threadCpuUsage](https://nodejs.org/api/process.html#processthreadcpuusagepreviousvalue)
measures CPU consumed on the calling thread, including synchronous native work.
[Event-loop utilization](https://nodejs.org/api/perf_hooks.html#performanceeventlooputilizationutilization1-utilization2)
measures active versus idle loop time and is not CPU usage. Both are recorded to
avoid treating total operation latency or heartbeat gaps as main-thread CPU time.
The probes also consume a small amount of main-thread time in both implementations.

Prepare a directory with synthetic copies named `0.xlsx` through `9.xlsx`, then:

```sh
node --expose-gc scripts/benchmark-concurrency.mjs . /tmp/numeric-copies buffer 10 default
node --expose-gc scripts/benchmark-concurrency.mjs . /tmp/numeric-copies buffer 10 2
node --expose-gc scripts/benchmark-concurrency.mjs . /tmp/numeric-copies file 10 10
```

The first argument selects an independently built package checkout, allowing the
same helper to compare old and new implementations. The final optional argument
sets measured batch count (default five). The helper needs a Node version exposing
`process.threadCpuUsage`. It leaves queue policy to the selected implementation:
the historical baseline defaults to eight waiting requests; current builds wait
automatically without a queue-length quota.

## Validation

The CPU-based default passed `pnpm build`, `pnpm check`, and `pnpm pack:check`:
7 Rust tests, the same 45 integration tests on Node and Bun, strict formatting/lint
and TypeScript checks, plus packed offline installs. Fresh-process tests verify that
`TOKIO_WORKER_THREADS=3` starts three concurrent operations when the reader limit
is omitted and queues the next. An explicit limit of one starts one and queues
the next. A forty-file burst at concurrency one completes without overload errors.
No custom runtime, CPU detection, or environment-variable parser was introduced.
