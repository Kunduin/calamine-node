import assert from 'node:assert/strict';
import { openFile, read } from 'calamine-node';

const path = process.argv[2];
const result = await read(path);
assert.equal(result.sheets.length, 4);
assert.equal(result.sheets[0].name, 'Data');
assert.equal(result.sheets[0].rows[0][0], '中文');

const selected = await read(path, { sheets: 'Data' });
assert.deepEqual(selected, { ...result, sheets: [result.sheets[0]] });
assert.deepEqual(structuredClone(result), result);

const workbook = await openFile(path);
try {
  assert.deepEqual(await workbook.readSheet(), result.sheets[0]);
} finally {
  await workbook.close();
}
