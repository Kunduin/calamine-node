// Generate only synthetic performance workloads into the caller's directory.
// node scripts/generate-benchmarks.mjs <SheetJS module path> <output directory>
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [modulePath, directory] = process.argv.slice(2);
if (!modulePath || !directory) {
  throw new Error(
    'Usage: node scripts/generate-benchmarks.mjs <SheetJS module path> <output directory>',
  );
}

const require = createRequire(import.meta.url);
const XLSX = require(resolve(modulePath));
const output = resolve(directory);
mkdirSync(output, { recursive: true });

for (const [name, count, columns, text] of [
  ['numeric-1m', 50000, 20, false],
  ['strings-100k', 10000, 10, true],
]) {
  const workbook = XLSX.utils.book_new();
  const rows = Array.from({ length: count }, (_, row) =>
    Array.from({ length: columns }, (_cell, column) =>
      text ? `${row}:${column}:${'x'.repeat(250)}` : row * columns + column,
    ),
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  XLSX.writeFile(workbook, join(output, `calamine-${name}.xlsx`), {
    compression: true,
  });
}
