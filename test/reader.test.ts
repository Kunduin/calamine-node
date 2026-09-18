import assert from 'node:assert/strict';
import { readFile, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createReader, openFile, openBuffer } from 'calamine-node';
import { fixture } from './helpers.js';

for (const format of ['xlsx', 'xls']) {
  test(`${format}: values, sparse ranges, errors and empty sheets`, async () => {
    const book = await openFile(fixture(`cells.${format}`));
    try {
      assert.equal(book.format, format);
      assert.deepEqual(
        book.sheets.map((sheet) => sheet.name),
        ['Data', 'Offset', 'Errors', 'Empty'],
      );
      const data = await book.readSheet('Data');
      assert.deepEqual(data.rows.slice(0, 2), [
        ['中文', 42, true, ''],
        [null, -3.25, '0007', false],
      ]);
      assert.equal(data.rows[2]?.[1], 5);
      assert.equal(data.rowCount, 3);
      assert.equal(data.columnCount, 4);

      const offset = await book.readSheet(1);
      assert.deepEqual(offset.origin, { row: 2, column: 2 });
      assert.deepEqual(offset.rows, [
        ['offset', null],
        [null, 8],
      ]);
      assert.deepEqual((await book.readSheet('Errors')).rows, [
        [{ kind: 'error', value: '#DIV/0!' }],
      ]);
      const empty = await book.readSheet('Empty');
      assert.deepEqual(empty.rows, []);
      assert.equal(empty.origin, null);
      assert.equal(empty.rowCount, 0);
      assert.equal(await book.readVbaProject(), null);
    } finally {
      await book.close();
    }
  });
}

test('XLSX dates retain serial and wall-clock components', async () => {
  const book = await openFile(pathToFileURL(fixture()));
  try {
    assert.deepEqual((await book.readSheet()).rows[2]?.[0], {
      kind: 'datetime',
      value: 44197.5,
      calendar: [2021, 1, 1, 12, 0, 0, 0],
    });
    const formulas = await book.readSheet('Data', { content: 'formulas' });
    assert.deepEqual(formulas.origin, { row: 2, column: 1 });
    assert.deepEqual(formulas.rows, [['2+3']]);
  } finally {
    await book.close();
  }
});

test('buffers are snapshotted at invocation, including queued calls and subarrays', async () => {
  const reader = createReader({ concurrency: 1 });
  const bytes = await readFile(fixture());
  const larger = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
  const input = larger.subarray(6, 6 + bytes.length);
  const first = reader.openBuffer(bytes);
  const second = reader.openBuffer(input);
  input.fill(0);
  const books = await Promise.all([first, second]);
  try {
    for (const book of books) assert.equal((await book.readSheet()).rows[0]?.[0], '中文');
  } finally {
    await Promise.all(books.map((book) => book.close()));
  }
});

test('extensionless files and buffers use upstream automatic format detection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calamine-test-'));
  try {
    const path = join(directory, 'workbook');
    await copyFile(fixture('cells.xls'), path);
    for (const book of [await openFile(path), await openBuffer(await readFile(path))]) {
      assert.equal(book.format, 'xls');
      await book.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('malformed inputs, filesystem errors and input limits reject', async () => {
  await assert.rejects(openBuffer(Buffer.from('not a workbook')), { code: 'ERR_WORKBOOK' });
  await assert.rejects(openBuffer(Buffer.from('PKbroken workbook')), { code: 'ERR_WORKBOOK' });
  await assert.rejects(openFile(fixture('missing.xlsx')), { code: 'ERR_IO' });
  await assert.rejects(openFile(fixture('.')), { code: 'ERR_INPUT' });
  const reader = createReader({ maxInputBytes: 8 });
  await assert.rejects(reader.openFile(fixture()), { code: 'ERR_INPUT_LIMIT' });
  await assert.rejects(reader.openBuffer(new Uint8Array(9)), { code: 'ERR_INPUT_LIMIT' });
  assert.throws(() => createReader({ concurrency: 0 }), TypeError);
  assert.throws(() => createReader({ maxCells: Number.NaN }), TypeError);
});

test('sheet selectors and rectangular cell limits reject without poisoning the workbook', async () => {
  const book = await openFile(fixture());
  try {
    await assert.rejects(book.readSheet('missing'), { code: 'ERR_SHEET' });
    await assert.rejects(book.readSheet(99), { code: 'ERR_SHEET' });
    await assert.rejects(book.readSheet(-1), TypeError);
    await assert.rejects(book.readSheet(0, { batchSize: 0 }), TypeError);
    await assert.rejects(book.readSheet(0, { maxCells: 2 }), { code: 'ERR_CELL_LIMIT' });
    assert.equal((await book.readSheet(0)).rows.length, 3);
  } finally {
    await book.close();
  }
});

for (const format of ['xlsb', 'ods']) {
  test(`${format}: upstream regression fixture values, formulas and defined names`, async () => {
    const reader = createReader({ experimentalFormats: ['xlsb', 'ods'] });
    const book = await reader.openFile(fixture(`upstream/issues.${format}`));
    try {
      assert.equal(book.format, format);
      assert.deepEqual((await book.readSheet('issue2')).rows, [
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]);
      assert.equal(
        book.definedNames.find((name) => name.name === 'OneRange')?.formula,
        format === 'ods' ? 'Sheet1.$A$1' : 'Sheet1!$A$1',
      );
      const formula = await book.readSheet('Sheet1', { content: 'formulas' });
      assert.equal(formula.rowCount, 1);
      assert.match(String(formula.rows[0]?.[0]), /OneRange/);
    } finally {
      await book.close();
    }
  });
}

test('VBA is extracted as source and reference metadata, with an output limit', async () => {
  const book = await openFile(fixture('upstream/vba.xlsm'));
  try {
    const project = await book.readVbaProject();
    assert.ok(project);
    const module = project.modules.find((entry) => entry.name === 'testVBA');
    assert.ok(module);
    assert.match(module.source, /Hello from vba!/);
    assert.ok(Array.isArray(project.references));
    await assert.rejects(book.readVbaProject({ maxBytes: 1 }), { code: 'ERR_VBA_LIMIT' });
  } finally {
    await book.close();
  }
});

test('formats with known interoperability gaps require explicit opt-in', async () => {
  await assert.rejects(openFile(fixture('upstream/issues.xlsb')), {
    code: 'ERR_EXPERIMENTAL_FORMAT',
  });
  await assert.rejects(openFile(fixture('upstream/issues.ods')), {
    code: 'ERR_EXPERIMENTAL_FORMAT',
  });
});
