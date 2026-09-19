import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { publish: { type: 'boolean', default: false } },
});
if (positionals.length !== 1) {
  throw new Error('Usage: node scripts/publish-release.mjs <tarball-directory> [--publish]');
}

const directory = resolve(positionals[0]);
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const source = JSON.parse(await readFile('package.json', 'utf8'));
const packages = manifest.packages;
assert.equal(manifest.name, source.name);
assert.equal(manifest.version, source.version);
assert.equal(packages.length, source.napi.targets.length + 1);
assert.equal(packages.at(-1)?.name, manifest.name, 'The root package must be published last');
assert.equal(new Set(packages.map(({ name }) => name)).size, packages.length);

// Validate every tarball before the first registry write.
for (const entry of packages) {
  assert.equal(entry.version, manifest.version);
  assert.equal(basename(entry.filename), entry.filename);
  assert.ok(entry.filename.endsWith('.tgz'));
  const bytes = await readFile(join(directory, entry.filename));
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(integrity, entry.integrity, `Tarball changed: ${entry.filename}`);
}

const unpublished = [];
for (const entry of packages) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.ok) {
    const published = await response.json();
    assert.equal(
      published.dist?.integrity,
      entry.integrity,
      `Published bytes differ for ${entry.name}@${entry.version}; keep the original release artifacts`,
    );
    console.log(`Already published with matching integrity: ${entry.name}@${entry.version}`);
    continue;
  }
  assert.equal(response.status, 404, `Registry lookup failed for ${entry.name}`);
  unpublished.push(entry);
}

for (const entry of unpublished) {
  const args = [
    'publish',
    join(directory, entry.filename),
    '--ignore-scripts',
    '--access',
    'public',
    '--registry',
    'https://registry.npmjs.org',
    '--tag',
    manifest.version.includes('-') ? 'next' : 'latest',
  ];
  if (!values.publish) args.push('--dry-run');
  execFileSync('npm', args, { stdio: 'inherit' });
}
