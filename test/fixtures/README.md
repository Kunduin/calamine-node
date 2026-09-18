# Test fixture provenance

`cells.xlsx`, `cells.xls`, `cells.xlsb`, `cells.ods`, and `large.xlsx` contain synthetic
values created by `scripts/generate-fixtures.cjs`, using SheetJS 0.20.3. Regeneration
takes an explicit path to a SheetJS installation; SheetJS is not a package dependency.
These generated workbooks are covered by this project's MIT license.

Files under `upstream/` are regression fixtures from Calamine 0.36.1:
https://github.com/tafia/calamine/tree/v0.36.1/tests
The upstream MIT license is included in that directory. The VBA fixture contains
only a demonstration macro; tests read its source without executing it.

No production or customer spreadsheets are included.
