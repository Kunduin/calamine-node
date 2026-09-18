import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createReader, type ByteStream } from 'calamine-node';
import { fixture } from './helpers.js';

async function withReader(
  run: (reader: ReturnType<typeof createReader>, directory: string) => Promise<void>,
  maxInputBytes?: number,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'calamine-stream-test-'));
  const reader = createReader({
    tempDirectory: directory,
    ...(maxInputBytes === undefined ? {} : { maxInputBytes }),
  });
  try {
    await run(reader, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const kind of ['node', 'web', 'iterable']) {
  test(`${kind} stream reads with backpressure and removes the temporary file on close`, async () => {
    await withReader(async (reader, directory) => {
      const bytes = await readFile(fixture());
      const chunks = [bytes.subarray(0, 37), bytes.subarray(37)];
      let source: ByteStream;
      if (kind === 'node') source = Readable.from(chunks);
      else if (kind === 'web')
        source = new ReadableStream<Uint8Array>({
          pull(controller) {
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
        });
      else
        source = (async function* () {
          yield* chunks;
        })();

      const book = await reader.openStream(source);
      try {
        assert.equal((await book.readSheet()).rows[0]?.[0], '中文');
        assert.equal((await readdir(directory)).length, 1);
      } finally {
        await book.close();
      }
      assert.deepEqual(await readdir(directory), []);
    });
  });
}

test('failed, invalid and oversized streams clean up their temporary files', async () => {
  await withReader(async (reader, directory) => {
    const failure = new Error('download failed');
    const source = (async function* () {
      yield new Uint8Array(4);
      throw failure;
    })();
    await assert.rejects(reader.openStream(source), (error) => error === failure);
    await assert.rejects(reader.openStream(Readable.from(['text'])), TypeError);
    await assert.rejects(reader.openStream(Readable.from([new Uint8Array(9)])), {
      code: 'ERR_INPUT_LIMIT',
    });
    await assert.rejects(reader.openStream(Readable.from([new Uint8Array(0)])), {
      code: 'ERR_WORKBOOK',
    });
    assert.deepEqual(await readdir(directory), []);
  }, 8);
});

test('aborting a stalled Web stream cancels the source and cleans up', async () => {
  await withReader(async (reader, directory) => {
    let cancelled = false;
    const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>(
      {
        pull() {
          markStarted();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const opening = reader.openStream(source, { signal: controller.signal });
    const rejection = assert.rejects(opening, { name: 'AbortError' });
    await started;
    controller.abort();
    await rejection;
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(directory), []);
  });
});
