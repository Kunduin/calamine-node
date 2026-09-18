import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Gate } from '../lib/gate.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  return Promise.withResolvers<void>();
}

test('admission is bounded; cancellation frees a queued slot without starting its work', async () => {
  const gate = new Gate(1, 1);
  const blocked = deferred();
  const running = gate.run(() => blocked.promise);
  const cancellation = new AbortController();
  let started = false;
  const queued = gate.run(async () => {
    started = true;
  }, cancellation.signal);
  await assert.rejects(
    gate.run(async () => {}),
    { code: 'ERR_QUEUE_FULL' },
  );
  cancellation.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(started, false);
  const replacement = gate.run(async () => {});
  blocked.resolve();
  await Promise.all([running, replacement]);
});

test('a running task retains its permit until actual completion after abort', async () => {
  const gate = new Gate(1, 1);
  const blocked = deferred();
  const entered = deferred();
  const cancellation = new AbortController();
  const running = gate.run(async () => {
    entered.resolve();
    await blocked.promise;
  }, cancellation.signal);
  await entered.promise;
  cancellation.abort();
  let nextStarted = false;
  const next = gate.run(async () => {
    nextStarted = true;
  });
  await Promise.resolve();
  assert.equal(nextStarted, false);
  blocked.resolve();
  await Promise.all([running, next]);
  assert.equal(nextStarted, true);
});

test('cleanup is admitted even when the public queue is full', async () => {
  const gate = new Gate(1, 0);
  const blocked = deferred();
  const running = gate.run(() => blocked.promise);
  const cleanup = gate.run(async () => {}, undefined, true);
  blocked.resolve();
  await Promise.all([running, cleanup]);
});
