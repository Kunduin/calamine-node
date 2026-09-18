import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { openFile } from 'calamine-node';
import { fixture } from './helpers.js';

test('batches preserve coordinates and release the sheet on an early return', async () => {
  const book = await openFile(fixture());
  try {
    const batches = [];
    for await (const batch of book.readBatches('Offset', { batchSize: 1 })) batches.push(batch);
    assert.deepEqual(
      batches.map((batch) => batch.offset),
      [0, 1],
    );
    assert.deepEqual(
      batches.map((batch) => batch.origin),
      [
        { row: 2, column: 2 },
        { row: 2, column: 2 },
      ],
    );

    for await (const batch of book.readBatches(0, { batchSize: 1 })) {
      assert.equal(batch.rows.length, 1);
      break;
    }
    assert.equal((await book.readSheet(0)).rows.length, 3);
  } finally {
    await book.close();
  }
});

test('concurrent operations on one workbook fail explicitly', async () => {
  const book = await openFile(fixture());
  const iterator = book.readBatches(0, { batchSize: 1 });
  try {
    await iterator.next();
    await assert.rejects(book.readSheet(1), { code: 'ERR_BUSY' });
    await assert.rejects(book.readVbaProject(), { code: 'ERR_BUSY' });
    await iterator.return(undefined);
    assert.equal((await book.readSheet(1)).rows.length, 2);
  } finally {
    await iterator.return(undefined);
    await book.close();
  }
});

test('close is idempotent and invalidates a paused iterator', async () => {
  const book = await openFile(fixture());
  const iterator = book.readBatches(0, { batchSize: 1 });
  await iterator.next();
  const closing = book.close();
  assert.equal(book.close(), closing);
  await closing;
  assert.equal(book.closed, true);
  await assert.rejects(iterator.next(), { code: 'ERR_CLOSED' });
  await assert.rejects(book.readSheet(), { code: 'ERR_CLOSED' });
});

test('close safely waits for an in-flight sheet load', async () => {
  const book = await openFile(fixture('large.xlsx'));
  const reading = book.readSheet();
  const rejection = assert.rejects(reading, { code: 'ERR_CLOSED' });
  await book.close();
  await rejection;
});

test('abort before opening and between batches preserves the abort reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel this operation');
  controller.abort(reason);
  await assert.rejects(
    openFile(fixture(), { signal: controller.signal }),
    (error) => error === reason,
  );

  const book = await openFile(fixture());
  const reading = new AbortController();
  const iterator = book.readBatches(0, { batchSize: 1, signal: reading.signal });
  try {
    await iterator.next();
    reading.abort(reason);
    await assert.rejects(iterator.next(), (error) => error === reason);
    assert.equal((await book.readSheet()).rows.length, 3);
  } finally {
    await iterator.return(undefined);
    await book[Symbol.asyncDispose]();
  }
});

test('large asynchronous reads allow event-loop progress', async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 1);
  const book = await openFile(fixture('large.xlsx'));
  try {
    let rows = 0;
    for await (const batch of book.readBatches()) {
      rows += batch.rows.length;
      assert.ok(batch.rows.length * batch.columnCount <= 16_384);
    }
    assert.equal(rows, 10_000);
    assert.ok(ticks > 0, 'JavaScript timers must run while native parsing is pending');
  } finally {
    clearInterval(timer);
    await book.close();
  }
});

test('native work in a JavaScript Worker closes and exits cleanly', async () => {
  const result = await new Promise<unknown>((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: fixture() });
    let message: unknown;
    worker.on('message', (value: unknown) => {
      message = value;
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code === 0) resolve(message);
      else reject(new Error(`Worker exited with ${code}`));
    });
  });
  assert.deepEqual(result, { format: 'xlsx', first: '中文' });
  const book = await openFile(fixture());
  try {
    assert.equal((await book.readSheet()).rows[0]?.[0], '中文');
  } finally {
    await book.close();
  }
});
