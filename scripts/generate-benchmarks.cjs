// Generate only synthetic performance workloads into the caller's directory.
// node scripts/generate-benchmarks.cjs <absolute SheetJS module path> <output directory>
const XLSX = require(process.argv[2]);
for (const [name, count, columns, text] of [
  ['numeric-1m', 50000, 20, false],
  ['strings-100k', 10000, 10, true],
]) {
  const workbook = XLSX.utils.book_new();
  const rows = Array.from({ length: count }, (_, r) =>
    Array.from({ length: columns }, (_cell, c) =>
      text ? `${r}:${c}:` + 'x'.repeat(250) : r * columns + c,
    ),
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), 'Data');
  XLSX.writeFile(workbook, require('node:path').join(process.argv[3], `calamine-${name}.xlsx`), {
    compression: true,
  });
}
