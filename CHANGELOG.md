# Changelog

## 0.1.0 (2026-09-19)

### Features

- Asynchronous, read-only XLSX, XLS, and XLSM parsing for Node.js and Bun.
- Read local files, Buffers, Uint8Arrays, and byte streams with one `read` API.
- Select sheets, read formulas and defined names, and inspect VBA projects.
- Workbook handles and row batches for incremental consumption.
- Native concurrency, automatic waiting, cancellation, and configurable limits.
- Native packages for Linux GNU/musl, macOS, and Windows on x64 and ARM64.

XLSB and ODS are available through explicit experimental opt-in. See the README
for format limitations, value semantics, and resource ownership.
