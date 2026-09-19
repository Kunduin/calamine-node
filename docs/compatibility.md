# Compatibility and known limits

The implementation locks Calamine 0.36.1. Current local runtime checks cover
Node 22 and Bun 1.4 on Linux x64 GNU. Other configured targets require matching
runtime validation before a release claims support for them. See
[platform verification](platforms.md).

## Format status

- XLSX/XLSM: tested synthetic mixed cells, formulas, errors, coordinates, VBA,
  empty sheets, and a larger workbook. Rust unit tests cover both date epochs and
  the Excel 1900 leap-day quirk.
- XLS: tested values, coordinates, errors and empty sheets. In the synthetic fixture,
  Calamine returns a styled date as a numeric serial. The SheetJS BIFF8 writer also
  omits the formula record, although it preserves its cached value. The API reports
  the types and formula records Calamine actually reads; it does not infer dates
  from values or reconstruct missing formulas.
- XLSB/ODS: experimental and disabled by default. Calamine's own `issues.xlsb` and
  `issues.ods` fixtures pass value, formula and defined-name tests. This does not imply
  that all producers' documents interoperate correctly.

## Reproduced interoperability gaps

`scripts/generate-fixtures.mjs` generates documents using SheetJS 0.20.3. With the
current Calamine release:

1. In `cells.xlsb`, expected first-row values are `['中文', 42, true, '']`;
   Calamine returns `['中文', null, null, null]`. The SheetJS reader reads the expected
   values. This case loses values without a parsing error.
2. `cells.ods` fails to open with an error about text where `table-cell` was expected.
   SheetJS reads it. This is an interoperability observation, not a determination
   of which producer/parser violates the file specification.

These samples are retained for reproduction. Opting into experimental formats accepts
these known parser limitations. Do not use XLSB for correctness-critical ingestion
without validating representative producer files against an independent reader.
No upstream issue or patch has been published on behalf of this project.

## Upstream behavior retained intentionally

Local known extensions select a format before parsing. For a file with an incorrect
known extension, pass its bytes to `openBuffer` instead. Buffer detection attempts
Calamine readers with shared immutable data, so cloning the reader does not clone
the entire input. When automatic detection fails, upstream may return a generic
format error instead of the most specific parser error.

Formula mode reads expressions; value mode reads cached results. Dates and errors
use the tags described in the README. No additional date inference, locale-aware
formatting or formula execution is performed.

The stream API spools first. Batch output still retains Calamine's full worksheet
range. XLS and ODS can parse all worksheets during open. Limits do not provide a
hard bound on native allocation, decompression or execution time.

## Coverage boundaries

Images, tables, merged-cell geometry, formatted display text, encrypted workbooks,
writing and macro execution are outside this initial public API. The package provides
Calamine's core workbook reader capabilities, not a complete binding for every
format-specific method.
