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

  const source = `
    import assert from 'node:assert/strict';
    import { openFile } from 'calamine-node';
    const workbook = await openFile(process.argv[2]);
    try {
      assert.equal((await workbook.readSheet()).rows[0][0], '中文');
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
    import { openFile, type Cell } from 'calamine-node';
    const workbook = await openFile('example.xlsx');
    const cell: Cell | undefined = (await workbook.readSheet()).rows[0]?.[0];
    console.log(cell);
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
