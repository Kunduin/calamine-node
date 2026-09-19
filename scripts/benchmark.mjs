import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, platform, arch } from 'node:os';
import { basename, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createReader } from '../dist/index.js';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    engine: { type: 'string', default: 'calamine' },
    sheetjs: { type: 'string' },
    'input-mode': { type: 'string', default: 'buffer' },
    requests: { type: 'string', default: '1' },
    concurrency: { type: 'string' },
    samples: { type: 'string', default: '5' },
  },
});

function positiveInteger(value, name) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number > 0, `${name} must be a positive integer`);
  return number;
}

assert.ok(values.input, '--input is required');
assert.ok(['calamine', 'sheetjs'].includes(values.engine), '--engine must be calamine or sheetjs');
assert.ok(['buffer', 'file'].includes(values['input-mode']), '--input-mode must be buffer or file');
assert.ok(values.engine !== 'sheetjs' || values.sheetjs, '--sheetjs must name a SheetJS module');

const requests = positiveInteger(values.requests, '--requests');
const sampleCount = positiveInteger(values.samples, '--samples');
const concurrency = values.concurrency
  ? positiveInteger(values.concurrency, '--concurrency')
  : undefined;
const path = resolve(values.input);
const bytes = await readFile(path);
const reader = createReader(concurrency === undefined ? {} : { concurrency });
const require = createRequire(import.meta.url);
const sheetjs = values.engine === 'sheetjs' ? require(resolve(values.sheetjs)) : undefined;

async function readRows() {
  const input = values['input-mode'] === 'buffer' ? bytes : path;
  if (!sheetjs) {
    const result = await reader.read(input);
    return result.sheets.map((sheet) => sheet.rows);
  }

  const workbook = sheetjs.read(typeof input === 'string' ? await readFile(input) : input, {
    dense: true,
  });
  return workbook.SheetNames.map((name) =>
    sheetjs.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
    }),
  );
}

function readAll() {
  return Promise.all(Array.from({ length: requests }, () => readRows()));
}

function describeRows(sheets) {
  const hash = createHash('sha256');
  const dimensions = sheets.map((rows) => {
    hash.update(`${rows.length}\n`);
    for (const row of rows) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
    return { rows: rows.length, columns: rows[0]?.length ?? 0 };
  });
  return { dimensions, sha256: hash.digest('hex') };
}

// Validate output outside the timed section. Compare this fingerprint across engines.
const warmup = await readAll();
const output = describeRows(warmup[0]);
warmup.length = 0;
const samples = [];

for (let index = 0; index < sampleCount; index++) {
  globalThis.gc?.();
  await delay(20);

  let lastTick = performance.now();
  let maxGapMs = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
  }, 1);
  const cpuStart = process.threadCpuUsage?.();
  const started = performance.now();
  let results;

  try {
    results = await readAll();
    const wallMs = performance.now() - started;
    const cpu = cpuStart === undefined ? undefined : process.threadCpuUsage(cpuStart);
    // Let the timer observe the final synchronous span, including a blocking SheetJS read.
    await delay(0);
    samples.push({
      wallMs,
      mainThreadCpuMs: cpu === undefined ? null : (cpu.user + cpu.system) / 1000,
      heartbeatMaxGapMs: maxGapMs,
    });
  } finally {
    clearInterval(heartbeat);
  }

  for (const sheets of results) {
    assert.deepEqual(
      sheets.map((rows) => ({ rows: rows.length, columns: rows[0]?.length ?? 0 })),
      output.dimensions,
    );
  }
  results.length = 0;
}

function median(key) {
  const sorted = samples.map((sample) => sample[key]).toSorted((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

console.log(
  JSON.stringify(
    {
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      host: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
      },
      engine: values.engine,
      sheetjsVersion: sheetjs?.version,
      input: basename(path),
      inputBytes: bytes.length,
      inputSha256: createHash('sha256').update(bytes).digest('hex'),
      inputMode: values['input-mode'],
      requests,
      concurrency: concurrency ?? 'runtime-default',
      output,
      forcedGc: typeof globalThis.gc === 'function',
      medians: {
        wallMs: median('wallMs'),
        mainThreadCpuMs: median('mainThreadCpuMs'),
        heartbeatMaxGapMs: median('heartbeatMaxGapMs'),
      },
      samples,
    },
    null,
    2,
  ),
);
