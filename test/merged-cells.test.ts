import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createReader, openFile, read, type CellRange, type SheetResult } from 'calamine-node';
import { fixture } from './helpers.js';

const ranges: CellRange[] = [
  { start: { row: 2, column: 2 }, end: { row: 2, column: 4 } },
  { start: { row: 3, column: 2 }, end: { row: 5, column: 2 } },
  { start: { row: 3, column: 3 }, end: { row: 5, column: 4 } },
  { start: { row: 2, column: 6 }, end: { row: 2, column: 8 } },
  { start: { row: 509, column: 2 }, end: { row: 514, column: 2 } },
];

function valueAt(sheet: SheetResult, row: number, column: number) {
  if (sheet.origin === null) return null;
  return sheet.rows[row - sheet.origin.row]?.[column - sheet.origin.column] ?? null;
}

function anchorValue(sheet: SheetResult, row: number, column: number) {
  const range = sheet.mergedCells?.find(
    ({ start, end }) =>
      row >= start.row && row <= end.row && column >= start.column && column <= end.column,
  );
  return range ? valueAt(sheet, range.start.row, range.start.column) : valueAt(sheet, row, column);
}

for (const format of ['xlsx', 'xls']) {
  test(`${format}: merged ranges preserve anchors, coordinates and ordinary blanks`, async () => {
    const path = fixture(`merged.${format}`);
    const result = await read(path, { includeMergedCells: true });
    assert.deepEqual(result, await read(await readFile(path), { includeMergedCells: true }));
    const sheet = result.sheets[0];
    assert.ok(sheet);
    assert.deepEqual(sheet.origin, { row: 2, column: 2 });
    assert.deepEqual(sheet.mergedCells, ranges);
    assert.equal(valueAt(sheet, 2, 3), null);
    assert.equal(anchorValue(sheet, 2, 4), 'horizontal');
    assert.equal(anchorValue(sheet, 5, 2), 'vertical');
    assert.equal(anchorValue(sheet, 5, 4), 'rectangle');
    assert.equal(anchorValue(sheet, 2, 8), null);
    assert.equal(anchorValue(sheet, 3, 5), null);
    assert.equal(anchorValue(sheet, 515, 2), null);
    assert.equal(anchorValue(sheet, 514, 2), 'cross-batch');
    assert.equal(anchorValue(sheet, 516, 2), 'after-merge');
    assert.deepEqual(result.sheets[1]?.rows, []);
    assert.deepEqual(result.sheets[1]?.mergedCells, [
      { start: { row: 1, column: 1 }, end: { row: 4, column: 3 } },
    ]);
    assert.deepEqual(result.sheets[2]?.mergedCells, []);
  });

  test(`${format}: batches retain absolute merge ranges across batch boundaries`, async () => {
    const workbook = await openFile(fixture(`merged.${format}`));
    try {
      const complete = await workbook.readSheet('Merged', { includeMergedCells: true });
      const rows = [];
      let batches = 0;
      for await (const batch of workbook.readBatches('Merged', {
        batchSize: 512,
        includeMergedCells: true,
      })) {
        assert.deepEqual(batch.mergedCells, ranges);
        assert.deepEqual(batch.origin, complete.origin);
        assert.equal(batch.offset, rows.length);
        rows.push(...batch.rows);
        batches += 1;
      }
      assert.equal(batches, 2);
      assert.deepEqual(rows, complete.rows);
      const formulas = await workbook.readSheet('Merged', {
        content: 'formulas',
        includeMergedCells: true,
      });
      assert.deepEqual(formulas.mergedCells, ranges);
    } finally {
      await workbook.close();
    }
  });
}

test('merge metadata is opt-in and never changes raw rows or result cell budgets', async () => {
  const path = fixture('merged.xlsx');
  const plain = await read(path);
  const included = await read(path, { includeMergedCells: true });
  for (const [index, sheet] of plain.sheets.entries()) {
    assert.equal('mergedCells' in sheet, false);
    assert.deepEqual(sheet.rows, included.sheets[index]?.rows);
  }
  const result = await read(path, { sheets: 'EmptyMerged', maxCells: 0, includeMergedCells: true });
  assert.equal(result.sheets[0]?.mergedCells?.length, 1);
});

test('independent concurrent files keep their own merge metadata', async () => {
  const reader = createReader({ concurrency: 2 });
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      reader.read(fixture(`merged.${index % 2 === 0 ? 'xlsx' : 'xls'}`), {
        includeMergedCells: true,
      }),
    ),
  );
  for (const result of results) assert.deepEqual(result.sheets[0]?.mergedCells, ranges);
});

test('JavaScript callers receive explicit errors for unsupported merge reads', async () => {
  await assert.rejects(
    async () => Reflect.apply(read, undefined, [fixture(), { includeMergedCells: 'yes' }]),
    TypeError,
  );
  const reader = createReader({ experimentalFormats: ['xlsb', 'ods'] });
  for (const format of ['xlsb', 'ods']) {
    await assert.rejects(
      reader.read(fixture(`upstream/issues.${format}`), { includeMergedCells: true }),
      {
        code: 'ERR_UNSUPPORTED',
      },
    );
  }
  const workbook = await openFile(fixture());
  try {
    await assert.rejects(workbook.readSheet('missing', { includeMergedCells: true }), {
      code: 'ERR_SHEET',
    });
    assert.deepEqual(
      (await workbook.readSheet('Data', { includeMergedCells: true })).mergedCells,
      [],
    );
  } finally {
    await workbook.close();
  }
});
