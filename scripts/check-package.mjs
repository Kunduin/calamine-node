import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  const packageDirectory = join(temporary, 'node_modules/calamine-node');
  const packagedFiles = await readdir(packageDirectory);
  assert.deepEqual(packagedFiles.toSorted(), [
    'LICENSE',
    'README.md',
    'THIRD_PARTY_LICENSES.txt',
    'dist',
    'docs',
    'lib',
    'native',
    'package.json',
  ]);
  assert.ok((await readdir(join(packageDirectory, 'docs'))).every((file) => file.endsWith('.md')));

  await copyFile(
    new URL('./fixtures/package-runtime.mjs', import.meta.url),
    join(temporary, 'smoke.mjs'),
  );
  await execute(process.execPath, ['smoke.mjs', fixture], { cwd: temporary });
  await execute('bun', ['smoke.mjs', fixture], { cwd: temporary });
  await copyFile(
    new URL('./fixtures/package-types.ts', import.meta.url),
    join(temporary, 'types.ts'),
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
