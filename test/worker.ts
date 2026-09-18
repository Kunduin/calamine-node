import { parentPort, workerData } from 'node:worker_threads';
import { openFile } from 'calamine-node';

if (typeof workerData !== 'string' || !parentPort) throw new Error('Invalid worker invocation');
const book = await openFile(workerData);
try {
  const result = await book.readSheet();
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no targetOrigin.
  parentPort.postMessage({ format: book.format, first: result.rows[0]?.[0] });
} finally {
  await book.close();
  parentPort.close();
}
