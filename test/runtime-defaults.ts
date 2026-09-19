import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createReader, type WorkbookHandle } from 'calamine-node';

// Run in a fresh process because napi-rs shares one initialized runtime.
const explicit = process.argv[2] === 'explicit';
const expected = explicit ? 1 : 3;
const reader = createReader(explicit ? { concurrency: 1 } : {});
const controllers: AbortController[] = [];
const openings: Promise<WorkbookHandle>[] = [];

function startStream(): Promise<void> {
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const source = new ReadableStream<Uint8Array>(
    { pull: () => started.resolve() },
    { highWaterMark: 0 },
  );
  controllers.push(controller);
  const opening = reader.openStream(source, { signal: controller.signal });
  openings.push(opening);
  return Promise.race([
    started.promise,
    opening.then(() => {
      throw new Error('A stalled stream unexpectedly opened');
    }),
  ]);
}

try {
  for (let index = 0; index < expected; index++) {
    await startStream();
  }

  let extraStarted = false;
  const waiting = startStream().then(() => {
    extraStarted = true;
  });
  // Existing streams retain all worker permits. Extra work must wait, not reject.
  await delay(20);
  assert.equal(extraStarted, false);
  controllers[0]?.abort();
  await waiting;
  assert.equal(extraStarted, true);
} finally {
  for (const controller of controllers) {
    controller.abort();
  }
  await Promise.allSettled(openings);
}

console.log(`Reader runs ${expected} operations and queues the next.`);
