// Synthetic, redistributable workbooks. No customer or production data.
// Usage: node scripts/generate-fixtures.mjs /absolute/path/to/xlsx.js
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = process.argv[2];
if (!modulePath) {
  throw new Error('Usage: node scripts/generate-fixtures.mjs <SheetJS module path>');
}

const require = createRequire(import.meta.url);
const XLSX = require(resolve(modulePath));
const output = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
mkdirSync(output, { recursive: true });

for (const bookType of ['xlsx', 'biff8', 'xlsb', 'ods']) {
  const workbook = XLSX.utils.book_new();
  const data = XLSX.utils.aoa_to_sheet([
    ['中文', 42, true, ''],
    [null, -3.25, '0007', false],
    [44197.5, 5, null, 'end'],
  ]);
  data.A3.z = 'yyyy-mm-dd hh:mm:ss';
  data.B3.f = '2+3';

  XLSX.utils.book_append_sheet(workbook, data, 'Data');
  XLSX.utils.book_append_sheet(
    workbook,
    {
      '!ref': 'C3:D4',
      C3: { t: 's', v: 'offset' },
      D4: { t: 'n', v: 8 },
    },
    'Offset',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    {
      '!ref': 'A1',
      A1: { t: 'e', v: 7 },
    },
    'Errors',
  );
  XLSX.utils.book_append_sheet(workbook, {}, 'Empty');

  const extension = bookType === 'biff8' ? 'xls' : bookType;
  XLSX.writeFile(workbook, join(output, `cells.${extension}`), { bookType, compression: true });
}

const large = XLSX.utils.book_new();
const rows = Array.from({ length: 10_000 }, (_, row) =>
  Array.from({ length: 16 }, (_cell, column) => (column === 0 ? `row-${row}` : row * 16 + column)),
);
XLSX.utils.book_append_sheet(large, XLSX.utils.aoa_to_sheet(rows), 'Data');
XLSX.writeFile(large, join(output, 'large.xlsx'), { compression: true });

const sparse = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  sparse,
  {
    '!ref': 'A1:ALL2001',
    A1: { t: 'n', v: 1 },
    ALL2001: { t: 'n', v: 2 },
  },
  'Data',
);
XLSX.writeFile(sparse, join(output, 'sparse-large.xlsx'), { compression: true });

console.log(`Generated synthetic fixtures with SheetJS ${XLSX.version}`);
