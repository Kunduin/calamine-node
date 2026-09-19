import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NapiCli, parseTriple } from '@napi-rs/cli';

const [artifactsArgument, outputArgument, ...extra] = process.argv.slice(2);
if (!artifactsArgument || !outputArgument || extra.length > 0) {
  throw new Error('Usage: node scripts/prepare-release.mjs <artifacts> <output>');
}

const artifacts = resolve(artifactsArgument);
const output = resolve(outputArgument);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const targets = manifest.napi.targets.map(parseTriple);
const baseline = join(artifacts, 'bindings-x86_64-unknown-linux-gnu');

assert.ok(
  !(await readdir('native')).some((file) => file.endsWith('.node')),
  'Prepare releases in a clean checkout without local native binaries',
);

// A fresh output directory prevents mixing tarballs from different releases.
await mkdir(output);

for (const target of targets) {
  const directory = join(artifacts, `bindings-${target.triple}`, 'native');
  const binaries = (await readdir(directory)).filter((file) => file.endsWith('.node'));
  assert.deepEqual(binaries, [`${manifest.napi.binaryName}.${target.platformArchABI}.node`]);

  for (const file of ['binding.cjs', 'binding.d.cts']) {
    assert.deepEqual(
      await readFile(join(directory, file)),
      await readFile(join(baseline, 'native', file)),
      `Generated bindings differ for ${target.triple}`,
    );
  }
}

await cp(join(baseline, 'dist'), 'dist', { recursive: true });
for (const file of ['binding.cjs', 'binding.d.cts']) {
  await copyFile(join(baseline, 'native', file), join('native', file));
}

const napi = new NapiCli();
await napi.createNpmDirs({});
await napi.artifacts({ outputDir: artifacts });
await napi.prePublish({ skipOptionalPublish: true, ghRelease: false, rootPublisher: 'npm' });

const packages = [];
for (const target of targets) {
  const directory = join('npm', target.platformArchABI);
  const path = join(directory, 'package.json');
  const platform = JSON.parse(await readFile(path, 'utf8'));

  for (const file of ['LICENSE', 'THIRD_PARTY_LICENSES.txt']) {
    await copyFile(file, join(directory, file));
    if (!platform.files.includes(file)) platform.files.push(file);
  }
  await writeFile(path, `${JSON.stringify(platform, null, 2)}\n`);
  packages.push(pack(directory, true));
}

const prepared = JSON.parse(await readFile('package.json', 'utf8'));
assert.deepEqual(
  prepared.optionalDependencies,
  Object.fromEntries(packages.map(({ name }) => [name, manifest.version])),
);
packages.push(pack('.', false));

await writeFile(
  join(output, 'manifest.json'),
  `${JSON.stringify({ name: manifest.name, version: manifest.version, packages }, null, 2)}\n`,
);
console.log(`Prepared ${packages.length} packages in ${output}. Nothing was published.`);

function pack(directory, native) {
  const results = Object.values(
    JSON.parse(
      execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], {
        cwd: directory,
        encoding: 'utf8',
      }),
    ),
  );
  assert.equal(results.length, 1);
  const [result] = results;
  const files = result.files.map(({ path }) => path);
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('THIRD_PARTY_LICENSES.txt'));
  assert.equal(files.filter((file) => file.endsWith('.node')).length, native ? 1 : 0);
  assert.equal(result.version, manifest.version);
  return {
    name: result.name,
    version: result.version,
    filename: result.filename,
    integrity: result.integrity,
  };
}
