import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--locked', '--format-version', '1'], { encoding: 'utf8' }),
);
const sections = [
  'Third-party notices for the native build.\nGenerated from the committed Cargo.lock.\n',
];

for (const dependency of metadata.packages.toSorted((left, right) =>
  left.name.localeCompare(right.name),
)) {
  if (dependency.name === 'calamine_node') continue;
  const directory = dirname(dependency.manifest_path);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(license|copying|notice)([.\-_]|$)/i.test(entry.name))
    .map((entry) => entry.name)
    .toSorted();
  const napiLicense =
    files.length === 0 && dependency.repository === 'https://github.com/napi-rs/napi-rs'
      ? readFileSync('node_modules/@napi-rs/cli/LICENSE', 'utf8')
      : undefined;
  if (files.length === 0 && !napiLicense) {
    throw new Error(`Missing license files for ${dependency.name}`);
  }

  sections.push(
    `\n${'='.repeat(72)}\n${dependency.name} ${dependency.version}\nLicense: ${dependency.license}\nhttps://crates.io/crates/${dependency.name}/${dependency.version}\n`,
  );
  if (napiLicense) sections.push(napiLicense);
  for (const filename of files) {
    sections.push(`\n--- ${filename} ---\n${readFileSync(join(directory, filename), 'utf8')}`);
  }
}

writeFileSync('THIRD_PARTY_LICENSES.txt', sections.join('\n'));
