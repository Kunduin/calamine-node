# Changelog

## [0.2.0](https://github.com/Kunduin/calamine-node/compare/v0.1.0...v0.2.0) (2026-09-19)


### Features

* expose merged cell ranges ([f00e1d6](https://github.com/Kunduin/calamine-node/commit/f00e1d626e4307c6ce93257c848ace91393b3dce))


### Bug Fixes

* read merged cell ranges by default ([55528ef](https://github.com/Kunduin/calamine-node/commit/55528ef92ec1ffcb6196008ad45f675f824748af))

## 0.1.0 (2026-09-19)

### Features

- Asynchronous, read-only XLSX, XLS, and XLSM parsing for Node.js and Bun.
- Read local files, Buffers, Uint8Arrays, and byte streams with one `read` API.
- Select sheets, read formulas and defined names, and inspect VBA projects.
- Workbook handles and row batches for incremental consumption.
- Native concurrency, automatic waiting, cancellation, and configurable limits.
- Unlimited cell counts by default, with optional per-reader or per-read budgets.
- Native packages for Linux GNU/musl, macOS, and Windows on x64 and ARM64.

XLSB and ODS are available through explicit experimental opt-in. See the README
for format limitations, value semantics, and resource ownership.
