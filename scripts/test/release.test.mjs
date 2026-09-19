import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), 'calamine-release-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'calamine-node', version: '0.1.0', napi: { targets: ['test'] } }),
  );
  return directory;
}

function run(script, directory, args = [], env = {}) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL(`../${script}`, import.meta.url)), ...args],
    {
      cwd: directory,
      env: { ...process.env, RELEASE_TAG: '', RELEASE_REF: '', ...env },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
}

async function tarballs(directory) {
  const packages = [];
  for (const name of ['calamine-node-test', 'calamine-node']) {
    const filename = `${name}-0.1.0.tgz`;
    const bytes = Buffer.from(name);
    await writeFile(join(directory, filename), bytes);
    packages.push({
      name,
      version: '0.1.0',
      filename,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }
  return { name: 'calamine-node', version: '0.1.0', packages };
}

async function rejectPublication(directory, manifest, expected) {
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const result = run('publish-release.mjs', directory, [directory, '--publish']);
  assert.equal(result.error, undefined, 'Validation must finish before network publication');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, expected);
}

test('release tag and both Rust versions must match the npm version', async (context) => {
  const directory = await fixture(context);
  await writeFile(join(directory, 'Cargo.toml'), '[package]\nversion = "0.1.0"\n');
  await writeFile(join(directory, 'Cargo.lock'), 'name = "calamine_node"\nversion = "0.1.0"\n');
  assert.equal(run('release-version.mjs', directory, [], { RELEASE_TAG: 'v0.1.0' }).status, 0);

  const wrongTag = run('release-version.mjs', directory, [], { RELEASE_TAG: 'main' });
  assert.notEqual(wrongTag.status, 0);
  assert.match(wrongTag.stderr, /tag must match/);

  const branch = run('release-version.mjs', directory, [], { RELEASE_REF: 'refs/heads/v0.1.0' });
  assert.notEqual(branch.status, 0);
  assert.match(branch.stderr, /Release from a version tag/);

  await writeFile(join(directory, 'Cargo.lock'), 'name = "calamine_node"\nversion = "0.0.9"\n');
  assert.notEqual(run('release-version.mjs', directory).status, 0);
});

test('a changed final tarball prevents publishing any platform package', async (context) => {
  const directory = await fixture(context);
  const manifest = await tarballs(directory);
  await writeFile(join(directory, manifest.packages.at(-1).filename), 'changed');
  await rejectPublication(directory, manifest, /Tarball changed: calamine-node-0.1.0.tgz/);
});

test('the root package cannot precede platform packages', async (context) => {
  const directory = await fixture(context);
  const manifest = await tarballs(directory);
  manifest.packages.reverse();
  await rejectPublication(directory, manifest, /root package must be published last/);
});

test('a missing platform package prevents publication', async (context) => {
  const directory = await fixture(context);
  const manifest = await tarballs(directory);
  manifest.packages.shift();
  await rejectPublication(directory, manifest, /AssertionError/);
});

test('tarball paths cannot escape the release directory', async (context) => {
  const directory = await fixture(context);
  const manifest = await tarballs(directory);
  manifest.packages[0].filename = '../outside.tgz';
  await rejectPublication(directory, manifest, /AssertionError/);
});
