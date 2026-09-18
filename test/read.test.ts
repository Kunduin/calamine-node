import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createReader, openFile, read } from 'calamine-node';
import { fixture } from './helpers.js';

for (const format of ['xlsx', 'xls']) {
  test(`${format}: a full workbook is ordinary data, with all sheets in workbook order`, async () => {
    const result = await read(fixture(`cells.${format}`));
    assert.equal(result.format, format);
    assert.deepEqual(
      result.sheets.map((sheet) => sheet.name),
      ['Data', 'Offset', 'Errors', 'Empty'],
    );
    assert.deepEqual(
      result.sheets.map((sheet) => sheet.index),
      [0, 1, 2, 3],
    );
    assert.deepEqual(result.sheets[1]?.rows, [
      ['offset', null],
      [null, 8],
    ]);
    assert.deepEqual(result.sheets[1]?.origin, { row: 2, column: 2 });
    assert.deepEqual(result.sheets[3]?.rows, []);
    assert.equal('close' in result, false);
    assert.equal('vbaProject' in result, false);
    assert.deepEqual(structuredClone(result), result);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
}

test('complete reads accept paths, file URLs and byte views with identical results', async () => {
  const expected = await read(fixture(), { sheets: 0 });
  assert.equal(expected.sheets.length, 1);
  assert.equal(expected.sheets[0]?.name, 'Data');
  assert.equal(expected.sheets[0]?.rows[0]?.[0], '中文');

  assert.deepEqual(await read(pathToFileURL(fixture()), { sheets: 0 }), expected);
  const bytes = await readFile(fixture());
  const padded = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 6, bytes.length);
  assert.deepEqual(await read(view, { sheets: 0 }), expected);

  const book = await openFile(fixture());
  try {
    assert.deepEqual(await book.readSheet(), expected.sheets[0]);
  } finally {
    await book.close();
  }
});

test('selection resolves names and indices, preserves order, and removes duplicates', async () => {
  const result = await read(fixture(), { sheets: ['Errors', 0, 2, 'Data'] });
  assert.deepEqual(
    result.sheets.map((sheet) => sheet.name),
    ['Errors', 'Data'],
  );
});

test('single selectors and lists retain the workbook result shape and original sheet index', async () => {
  const all = await read(fixture());
  const expected = { ...all, sheets: [all.sheets[1]] };

  for (const sheets of ['Offset', 1, ['Offset'], [1]] as const) {
    assert.deepEqual(await read(fixture(), { sheets }), expected);
  }
});

test('string selectors are literal names, including all and wildcard characters', async () => {
  for (const sheets of ['all', '*']) {
    await assert.rejects(read(fixture(), { sheets }), { code: 'ERR_SHEET' });
  }
});

test('JavaScript callers receive errors for invalid scalar and array selectors', async () => {
  for (const sheets of [null, true, {}, -1, 1.5, NaN, Infinity, ['Data', null]]) {
    await assert.rejects(
      async () => Reflect.apply(read, undefined, [fixture(), { sheets }]),
      TypeError,
    );
  }
});

test('all selected rectangles share one result budget, including empty-sheet boundaries', async () => {
  // Data = 3x4, Offset = 2x2, Errors = 1x1, Empty = 0.
  const exact = await read(fixture(), { maxCells: 17 });
  assert.equal(exact.sheets.length, 4);
  await assert.rejects(read(fixture(), { maxCells: 16 }), { code: 'ERR_CELL_LIMIT' });
  await assert.rejects(read(fixture(), { sheets: [0, 1], maxCells: 12 }), {
    code: 'ERR_CELL_LIMIT',
  });
  assert.equal((await read(fixture(), { sheets: ['Empty'], maxCells: 0 })).sheets.length, 1);
  await assert.rejects(read(fixture(), { sheets: 0, maxCells: 0 }), { code: 'ERR_CELL_LIMIT' });
  assert.deepEqual((await read(fixture(), { sheets: 'Empty', maxCells: 0 })).sheets[0]?.rows, []);
});

test('an empty selection returns metadata without materializing cell data', async () => {
  const reader = createReader({ maxCells: 0, experimentalFormats: ['xlsb'] });
  const metadata = await reader.read(fixture('upstream/issues.xlsb'), { sheets: [] });
  assert.deepEqual(metadata.sheets, []);
  assert.ok(metadata.definedNames.some((entry) => entry.name === 'OneRange'));
});

test('formulas and optional VBA retain the handle API semantics', async () => {
  const result = await read(fixture(), {
    sheets: ['Data'],
    content: 'formulas',
    includeVba: true,
  });
  assert.deepEqual(result.sheets[0]?.rows, [['2+3']]);
  assert.deepEqual(result.sheets[0]?.origin, { row: 2, column: 1 });
  assert.equal(result.vbaProject, null);

  const macro = await read(fixture('upstream/vba.xlsm'), { sheets: [], includeVba: true });
  assert.ok(macro.vbaProject?.modules.some((entry) => entry.name === 'testVBA'));
  await assert.rejects(
    read(fixture('upstream/vba.xlsm'), {
      sheets: [],
      includeVba: true,
      maxVbaBytes: 1,
    }),
    { code: 'ERR_VBA_LIMIT' },
  );
});

test('reader defaults and per-call limits apply to complete reads', async () => {
  const reader = createReader({ maxCells: 4, maxInputBytes: 8 });
  await assert.rejects(reader.read(fixture()), { code: 'ERR_INPUT_LIMIT' });
  await assert.rejects(reader.read(fixture(), { maxInputBytes: 1_000_000 }), {
    code: 'ERR_CELL_LIMIT',
  });
  assert.equal(
    (
      await reader.read(fixture(), {
        sheets: 'Offset',
        maxInputBytes: 1_000_000,
      })
    ).sheets[0]?.rowCount,
    2,
  );
  assert.equal(
    (
      await reader.read(fixture(), {
        maxInputBytes: 1_000_000,
        maxCells: 17,
      })
    ).sheets.length,
    4,
  );

  const bytes = await readFile(fixture());
  await assert.rejects(read(bytes, { maxInputBytes: 8 }), { code: 'ERR_INPUT_LIMIT' });
  await assert.rejects(read(Readable.from([bytes]), { maxInputBytes: 8 }), {
    code: 'ERR_INPUT_LIMIT',
  });
});

test('bytes and options are captured before the asynchronous open', async () => {
  const bytes = await readFile(fixture());
  const options = { sheets: ['Offset'], maxCells: 4, content: 'values' as const };
  const reading = read(bytes, options);
  bytes.fill(0);
  options.sheets[0] = 'missing';
  options.maxCells = 0;
  const result = await reading;
  assert.equal(result.sheets[0]?.name, 'Offset');
  assert.equal(result.sheets[0]?.rows[0]?.[0], 'offset');
});

test('invalid selectors and configuration reject; cancellation keeps its reason', async () => {
  await assert.rejects(read(fixture(), { sheets: ['missing'] }), { code: 'ERR_SHEET' });
  await assert.rejects(read(fixture(), { sheets: [-1] }), TypeError);
  await assert.rejects(read(fixture(), { batchSize: 0 }), TypeError);
  await assert.rejects(read(fixture(), { maxInputBytes: 0 }), TypeError);
  const controller = new AbortController();
  const reason = new Error('user cancelled');
  controller.abort(reason);
  await assert.rejects(read(fixture(), { signal: controller.signal }), (error) => error === reason);
});

test('Node, Web and iterable streams clean up before a complete result resolves', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calamine-complete-test-'));
  const reader = createReader({ tempDirectory: directory });
  const bytes = await readFile(fixture());
  const sources = [
    Readable.from([bytes]),
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    (async function* () {
      yield bytes;
    })(),
  ];

  try {
    for (const source of sources) {
      const result = await reader.read(source);
      assert.equal(result.sheets[0]?.rows[0]?.[0], '中文');
      assert.deepEqual(await readdir(directory), []);
    }
    await assert.rejects(reader.read(Readable.from([bytes]), { sheets: ['missing'] }), {
      code: 'ERR_SHEET',
    });
    await assert.rejects(reader.read(Readable.from([bytes]), { sheets: 0, maxCells: 1 }), {
      code: 'ERR_CELL_LIMIT',
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('cancelling a complete streamed read releases its temporary input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'calamine-complete-abort-'));
  const reader = createReader({ tempDirectory: directory });
  const controller = new AbortController();
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  let cancelled = false;
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

  try {
    const reading = reader.read(source, { signal: controller.signal });
    const rejected = assert.rejects(reading, { name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
    assert.equal(cancelled, true);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
