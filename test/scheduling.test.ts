import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createReader } from 'calamine-node';
import { fixture } from './helpers.js';

function stalledStream(): {
  source: ReadableStream<Uint8Array>;
  started: Promise<void>;
} {
  const { promise: started, resolve } = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({ pull: () => resolve() }, { highWaterMark: 0 });
  return { source, started };
}

test('native admission is shared by streams, paths and buffers; queued abort preserves its reason', async () => {
  const reader = createReader({ concurrency: 1, maxQueued: 1 });
  const bytes = await readFile(fixture());
  const running = new AbortController();
  const { source, started } = stalledStream();
  const streamRejection = assert.rejects(reader.openStream(source, { signal: running.signal }), {
    name: 'AbortError',
  });

  try {
    await started;
    const queued = new AbortController();
    const opening = reader.openBuffer(bytes, { signal: queued.signal });
    await assert.rejects(reader.openFile(fixture()), { code: 'ERR_QUEUE_FULL' });
    const reason = new Error('cancel queued input');
    queued.abort(reason);
    await assert.rejects(opening, (error) => error === reason);

    const replacement = reader.openBuffer(bytes);
    bytes.fill(0);
    await assert.rejects(reader.openFile(fixture()), { code: 'ERR_QUEUE_FULL' });
    running.abort();
    await streamRejection;

    const book = await replacement;
    try {
      assert.equal((await book.readSheet()).rows[0]?.[0], '中文');
    } finally {
      await book.close();
    }
  } finally {
    running.abort();
    await streamRejection;
  }
});

test('a queued stream is not pulled or locked when cancelled', async () => {
  const reader = createReader({ concurrency: 1, maxQueued: 1 });
  const active = stalledStream();
  const running = new AbortController();
  const streamRejection = assert.rejects(
    reader.openStream(active.source, { signal: running.signal }),
    { name: 'AbortError' },
  );

  try {
    await active.started;
    const queued = stalledStream();
    const cancellation = new AbortController();
    const opening = reader.openStream(queued.source, { signal: cancellation.signal });
    cancellation.abort();
    await assert.rejects(opening, { name: 'AbortError' });
    assert.equal(queued.source.locked, false);
  } finally {
    running.abort();
    await streamRejection;
  }
});

test('cleanup bypasses a full admission queue without bypassing concurrency', async () => {
  const reader = createReader({ concurrency: 1, maxQueued: 0 });
  const book = await reader.openFile(fixture());
  const running = new AbortController();
  const { source, started } = stalledStream();
  const streamRejection = assert.rejects(reader.openStream(source, { signal: running.signal }), {
    name: 'AbortError',
  });

  try {
    await started;
    const closing = book.close();
    assert.equal(book.close(), closing);
    await assert.rejects(reader.openFile(fixture()), { code: 'ERR_QUEUE_FULL' });
    running.abort();
    await streamRejection;
    await closing;
    assert.equal(book.closed, true);
  } finally {
    running.abort();
    await streamRejection;
    await book.close();
  }
});
