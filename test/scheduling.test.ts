import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createReader } from 'calamine-node';
import { fixture } from './helpers.js';

for (const mode of ['default', 'explicit']) {
  test(`reader concurrency uses the ${mode} runtime configuration`, async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./runtime-defaults.js', import.meta.url)), mode],
      { env: { ...process.env, TOKIO_WORKER_THREADS: '3' }, timeout: 15_000 },
    );
    assert.match(stdout, /Reader runs [13] operations and queues the next\./);
  });
}

function stalledStream(): {
  source: ReadableStream<Uint8Array>;
  started: Promise<void>;
} {
  const { promise: started, resolve } = Promise.withResolvers<void>();
  const source = new ReadableStream<Uint8Array>({ pull: () => resolve() }, { highWaterMark: 0 });
  return { source, started };
}

test('streams, paths and buffers share execution slots; queued abort preserves its reason', async () => {
  const reader = createReader({ concurrency: 1 });
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
    const reason = new Error('cancel queued input');
    queued.abort(reason);
    await assert.rejects(opening, (error) => error === reason);

    const replacement = reader.openBuffer(bytes);
    bytes.fill(0);
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
  const reader = createReader({ concurrency: 1 });
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

test('cleanup waits for a worker and remains idempotent', async () => {
  const reader = createReader({ concurrency: 1 });
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

test('a burst of files waits automatically without queue-full failures', async () => {
  const reader = createReader({ concurrency: 1 });
  const bytes = await readFile(fixture());
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, index) => reader.read(index % 2 === 0 ? bytes : fixture())),
  );
  assert.equal(results.length, 40);
  for (const result of results) {
    assert.equal(result.sheets[0]?.rows[0]?.[0], '中文');
  }
});
