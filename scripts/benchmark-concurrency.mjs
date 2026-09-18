// Local synthetic inputs only. The directory contains 0.xlsx, 1.xlsx, etc.
// node --expose-gc scripts/benchmark-concurrency.mjs <package-dir> <input-dir> <file|buffer> <requests> <concurrency|default> [samples]
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [
  moduleDirectory,
  inputDirectory,
  inputKind,
  requestValue,
  concurrencyValue,
  sampleValue = '5',
] = process.argv.slice(2);
const requests = Number(requestValue);
const concurrency = concurrencyValue === 'default' ? undefined : Number(concurrencyValue);
const sampleCount = Number(sampleValue);
assert.ok(moduleDirectory && inputDirectory);
assert.ok(inputKind === 'file' || inputKind === 'buffer');
assert.ok(Number.isInteger(requests) && requests > 0);
assert.ok(concurrency === undefined || (Number.isInteger(concurrency) && concurrency > 0));
assert.ok(Number.isInteger(sampleCount) && sampleCount > 0);
assert.equal(typeof process.threadCpuUsage, 'function');

const { createReader } = await import(
  pathToFileURL(resolve(moduleDirectory, 'dist/index.js')).href
);
const reader = createReader(concurrency === undefined ? {} : { concurrency });
const paths = Array.from({ length: requests }, (_, index) => join(inputDirectory, `${index}.xlsx`));
const inputs =
  inputKind === 'buffer' ? await Promise.all(paths.map((path) => readFile(path))) : paths;

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = values.toSorted((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

async function readAll(onComplete = () => {}) {
  return Promise.all(
    inputs.map(async (input, index) => {
      const result = await reader.read(input);
      onComplete(index);
      return result;
    }),
  );
}

const warmup = await readAll();
const expectedRows = warmup.reduce((total, result) => total + result.sheets[0].rowCount, 0);
const expectedCells = warmup.reduce(
  (total, result) => total + result.sheets[0].rowCount * result.sheets[0].columnCount,
  0,
);
warmup.length = 0;
const samples = [];

for (let run = 0; run < sampleCount; run++) {
  globalThis.gc?.();
  await delay(25);
  const gaps = [];
  const fileProbeTimes = [];
  const completions = [];
  let lastTick = performance.now();
  const probeStop = new AbortController();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    gaps.push(now - lastTick);
    lastTick = now;
  }, 1);
  const fileProbe = (async () => {
    while (!probeStop.signal.aborted) {
      const started = performance.now();
      await stat(paths[0]);
      fileProbeTimes.push(performance.now() - started);
      await delay(10);
    }
  })();

  const cpuStart = process.threadCpuUsage();
  const processCpuStart = process.cpuUsage();
  const loopStart = performance.eventLoopUtilization();
  const started = performance.now();
  const pending = readAll(() => completions.push(performance.now() - started));
  const submitMs = performance.now() - started;
  const results = await pending;
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuStart);
  const processCpu = process.cpuUsage(processCpuStart);
  const loop = performance.eventLoopUtilization(loopStart);
  probeStop.abort();
  gaps.push(performance.now() - lastTick);
  clearInterval(heartbeat);
  await fileProbe;

  assert.equal(
    results.reduce((total, result) => total + result.sheets[0].rows.length, 0),
    expectedRows,
  );
  results.length = 0;
  samples.push({
    wallMs,
    submitMs,
    mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
    processCpuMs: (processCpu.user + processCpu.system) / 1000,
    eventLoopActiveMs: loop.active,
    eventLoopUtilization: loop.utilization,
    heartbeatP99GapMs: percentile(gaps, 0.99),
    heartbeatMaxGapMs: Math.max(...gaps),
    fileProbeP95Ms: percentile(fileProbeTimes, 0.95),
    fileProbeMaxMs: Math.max(...fileProbeTimes),
    fileProbeCount: fileProbeTimes.length,
    requestFirstCompleteMs: Math.min(...completions),
    requestP50CompleteMs: percentile(completions, 0.5),
    requestLastCompleteMs: Math.max(...completions),
  });
}

const medians = Object.fromEntries(
  Object.keys(samples[0]).map((key) => [
    key,
    percentile(
      samples.map((sample) => sample[key]),
      0.5,
    ),
  ]),
);
console.log(
  JSON.stringify({
    node: process.version,
    inputKind,
    requests,
    concurrency: concurrency ?? 'runtime-default',
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? 'default (4)',
    inputBytesPerFile: (await stat(paths[0])).size,
    expectedRows,
    expectedCells,
    processPeakRssMiB: process.resourceUsage().maxRSS / 1024,
    medians,
    samples,
  }),
);
