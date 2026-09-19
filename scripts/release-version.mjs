import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const cargo = await readFile('Cargo.toml', 'utf8');
const lock = await readFile('Cargo.lock', 'utf8');

assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], manifest.version);
assert.equal(lock.match(/name = "calamine_node"\nversion = "([^"]+)"/)?.[1], manifest.version);

if (process.env.RELEASE_TAG) {
  assert.equal(
    process.env.RELEASE_TAG,
    `v${manifest.version}`,
    'The GitHub release tag must match the committed package version',
  );
}

if (process.env.RELEASE_REF) {
  assert.equal(
    process.env.RELEASE_REF,
    `refs/tags/v${manifest.version}`,
    'Release from a version tag',
  );
}

console.log(`Release version: ${manifest.version}`);
