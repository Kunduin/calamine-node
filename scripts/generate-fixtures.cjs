// Synthetic, redistributable workbooks. No customer or production data.
// Usage: node scripts/generate-fixtures.cjs /absolute/path/to/xlsx.js
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const XLSX = require(process.argv[2]);
const output = join(__dirname, '..', 'test', 'fixtures');
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

console.log(`Generated synthetic fixtures with SheetJS ${XLSX.version}`);
