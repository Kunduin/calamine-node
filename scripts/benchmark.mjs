import { performance } from 'node:perf_hooks';
import { stat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { openFile, read } from '../dist/index.js';
import native from '../native/binding.cjs';
const require = createRequire(import.meta.url);
const mode = process.argv[3];
const XLSX = mode === 'sheetjs' ? require(process.argv[4]) : undefined;
const path = process.argv[2];
if (!path || !mode)
  throw new Error('Usage: node scripts/benchmark.mjs <file> <mode> [absolute SheetJS module path]');
const inputBuffer = mode === 'complete-buffer' ? await readFile(path) : undefined;
let jsonRows;
let batchCalls = 0;
const nativeBatch = native.NativeSheet.prototype.batch;
native.NativeSheet.prototype.batch = function (...args) {
  batchCalls++;
  return nativeBatch.apply(this, args);
};
if (mode === 'stringify' || mode === 'parse-json') {
  const book = await openFile(path);
  try {
    jsonRows = (await book.readSheet()).rows;
  } finally {
    await book.close();
  }
  if (mode === 'parse-json') jsonRows = JSON.stringify(jsonRows);
}
async function operation() {
  if (mode === 'complete-buffer') return (await read(inputBuffer)).sheets[0].rowCount;
  if (mode === 'complete-sheet') return (await read(path, { sheets: 0 })).sheets[0].rowCount;
  if (mode === 'complete-workbook') return (await read(path)).sheets[0].rowCount;
  if (mode === 'stringify') return Buffer.byteLength(JSON.stringify(jsonRows));
  if (mode === 'parse-json') return JSON.parse(jsonRows).length;
  if (mode === 'sheetjs') {
    const book = XLSX.read(await readFile(path), { dense: true });
    return XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], {
      header: 1,
      raw: true,
      defval: null,
    }).length;
  }
  if (mode === 'parse-only' || mode === 'single-native-batch') {
    const book = await new native.NativeReader(2).openPath(path, 64 * 1024 * 1024);
    let sheet;
    try {
      sheet = await book.loadSheet(0, 2000000, false);
      if (mode === 'parse-only') return sheet.info.rowCount;
      return (await sheet.batch(0, sheet.info.rowCount)).rows.length;
    } finally {
      if (sheet) await sheet.close();
      await book.close();
    }
  }
  const book = await openFile(path);
  try {
    if (mode === 'read-sheet') return (await book.readSheet()).rows.length;
    if (mode === 'read-sheet-256') return (await book.readSheet(0, { batchSize: 256 })).rows.length;
    if (mode === 'read-sheet-512') return (await book.readSheet(0, { batchSize: 512 })).rows.length;
    let count = 0;
    for await (const batch of book.readBatches(0, { batchSize: 1024 })) count += batch.rows.length;
    return count;
  } finally {
    await book.close();
  }
}
await operation();
const samples = [];
for (let run = 0; run < 5; run++) {
  globalThis.gc?.();
  await new Promise((r) => setTimeout(r, 10));
  const heapBefore = process.memoryUsage().heapUsed;
  batchCalls = 0;
  let last = performance.now(),
    delay = 0,
    ticks = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    delay = Math.max(delay, now - last);
    last = now;
    ticks++;
  }, 1);
  const started = performance.now();
  const count = await operation();
  const elapsed = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((r) => setTimeout(r, 3));
  clearInterval(heartbeat);
  samples.push({
    ms: elapsed,
    gapMs: delay,
    ticks,
    heapDeltaMiB: (heapAfter - heapBefore) / 1048576,
    count,
    batchCalls,
  });
}
function median(key) {
  return samples.map((s) => s[key]).toSorted((a, b) => a - b)[2];
}
console.log(
  JSON.stringify({
    runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
    input: path.split('/').pop(),
    inputBytes: (await stat(path)).size,
    mode,
    p50Ms: median('ms'),
    p50GapMs: median('gapMs'),
    maxGapMs: Math.max(...samples.map((s) => s.gapMs)),
    p50HeapDeltaMiB: median('heapDeltaMiB'),
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    count: samples[0].count,
    batchCalls: samples[0].batchCalls,
  }),
);
