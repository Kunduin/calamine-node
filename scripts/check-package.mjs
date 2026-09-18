import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), 'calamine-package-'));
const fixture = resolve('test/fixtures/cells.xlsx');

try {
  await execute('pnpm', ['pack', '--pack-destination', temporary]);
  const files = await readdir(temporary);
  const tarball = files.find((file) => file.endsWith('.tgz'));
  assert.ok(tarball, 'pnpm pack must produce a tarball');

  await writeFile(
    join(temporary, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }),
  );
  await execute('pnpm', ['add', '--offline', '--ignore-scripts', join(temporary, tarball)], {
    cwd: temporary,
  });
  const manifest = JSON.parse(
    await readFile(join(temporary, 'node_modules/calamine-node/package.json'), 'utf8'),
  );
  assert.equal(manifest.name, 'calamine-node');
  assert.equal(manifest.license, 'MIT');
  const packagedFiles = await readdir(join(temporary, 'node_modules/calamine-node'));
  assert.ok(packagedFiles.includes('LICENSE'));
  assert.ok(packagedFiles.includes('THIRD_PARTY_LICENSES.txt'));
  assert.equal(packagedFiles.includes('NOTICE'), false);

  const source = `
    import assert from 'node:assert/strict';
    import { openFile, read } from 'calamine-node';
    const result = await read(process.argv[2]);
    assert.equal(result.sheets.length, 4);
    assert.equal(result.sheets[0].name, 'Data');
    assert.equal(result.sheets[0].rows[0][0], '中文');
    const selected = await read(process.argv[2], { sheets: 'Data' });
    assert.deepEqual(selected, { ...result, sheets: [result.sheets[0]] });
    assert.deepEqual(structuredClone(result), result);
    const workbook = await openFile(process.argv[2]);
    try {
      assert.deepEqual(await workbook.readSheet(), result.sheets[0]);
    } finally {
      await workbook.close();
    }
  `;
  await writeFile(join(temporary, 'smoke.mjs'), source);
  await execute(process.execPath, ['smoke.mjs', fixture], { cwd: temporary });
  await execute('bun', ['smoke.mjs', fixture], { cwd: temporary });
  await writeFile(
    join(temporary, 'types.ts'),
    `
    import { Readable } from 'node:stream';
    import {
      openFile, read, createReader,
      type Cell, type WorkbookResult, type ReadOptions, type SheetReadOptions,
    } from 'calamine-node';
    const result: WorkbookResult = await read(Buffer.alloc(0), {
      sheets: ['Sales', 0], maxCells: 100, maxInputBytes: 1_000_000, includeVba: true,
    });
    const options: ReadOptions = {
      sheets: 'Sales', content: 'formulas', signal: new AbortController().signal,
    };
    const selected: WorkbookResult = await read(new URL('file:///example.xlsx'), options);
    const indexed: WorkbookResult = await read('example.xlsx', { sheets: 0 });
    const reader = createReader();
    await reader.read(Readable.from([Buffer.alloc(0)]));
    await reader.read(new ReadableStream<Uint8Array>(), { sheets: ['Sales'] });
    const name: string | undefined = selected.sheets[0]?.name;
    const rows: Cell[][] | undefined = result.sheets[0]?.rows;
    const workbook = await openFile('example.xlsx');
    const sheetOptions: SheetReadOptions = { maxCells: 100 };
    const cell: Cell | undefined = (await workbook.readSheet(0, sheetOptions)).rows[0]?.[0];
    console.log(name, rows, cell, indexed);
    await workbook.close();
  `,
  );
  await writeFile(
    join(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2023',
        module: 'NodeNext',
        lib: ['ES2024', 'DOM', 'ESNext.Disposable'],
        types: ['node'],
        typeRoots: [resolve('node_modules/@types')],
      },
      include: ['types.ts'],
    }),
  );
  await execute('pnpm', ['exec', 'tsc', '--project', join(temporary, 'tsconfig.json')]);
  console.log(
    'Packed package passed offline install, Node/Bun runtime and TypeScript 7 consumer checks.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
