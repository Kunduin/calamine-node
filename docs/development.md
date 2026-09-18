# Development and packaging

## Layout

- `src/source.rs`: Calamine input types and delegation to upstream readers.
- `src/cell.rs`: explicit cell-value conversion, including dates/errors/large integers.
- `src/workbook.rs`, `src/sheet.rs`, `src/vba.rs`: owned handles and napi-rs AsyncTasks.
- `lib/reader.ts`: validated input entry points and admission configuration.
- `lib/read.ts`: sheet selection and complete workbook collection with automatic cleanup and aggregate limits.
- `lib/options.ts`: shared option validation and collection defaults.
- `lib/workbook.ts`: public lifetime and iteration behavior.
- `lib/gate.ts`, `lib/stream.ts`: bounded work admission and temporary input spooling.
- `native/`: generated napi-rs loader/declarations and local compiled binaries.
- `test/`: portable node:test suites and attributed fixtures.

Read [the API review](api-review.md) before expanding the public surface. It separates
current implementation from proposed improvements and inventories existing Calamine
capabilities to avoid duplicating upstream functionality.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm pack:check
```

`check` runs oxfmt, cargo fmt, oxlint, Clippy with warnings denied, strict TypeScript
checks, Rust tests, and the same compiled integration tests under Node and Bun.
`pack:check` is currently a POSIX development/CI script. It packs the local binary,
installs the tarball offline into a temporary project, and verifies package imports
and native loading with both runtimes. Temporary files are removed in finally.

Use `pnpm format` before reviewing changes. Generated native loader and declaration
files are excluded from formatting/linting; regenerate them with `pnpm build:native`.
Both language sources are formatted; Rust attributes stay attached to declarations.

The package uses Node-API 8. Stable TypeScript 7 builds ESM JS and declarations;
CommonJS import behavior is not part of the initial public compatibility contract.
Rust's `dyn-symbols` feature allows pure Rust unit tests to link without a Node host;
the real Node-API boundary is validated by Node and Bun integration tests. Complete
reads and handle reads use the same sheet result shape: metadata is directly
available as `sheet.name`, `sheet.index`, `sheet.kind` and `sheet.visibility`.
`read(input, options)` always returns `WorkbookResult`; selecting one sheet changes
the contents of `result.sheets`, not the return type. `ReadOptions` configures complete
reads, while `SheetReadOptions` configures a handle's `readSheet` and `readBatches`.

## Platform builds

The napi-rs scaffold configuration lists:

- Linux x64/arm64, GNU and musl.
- macOS x64/arm64.
- Windows x64/arm64, MSVC.

The workflow builds artifacts for these targets and runs Node tests on native Linux,
macOS and Windows runners. It runs Bun tests and packed-install tests on Linux.
Cross-built arm64/musl artifacts still need matching runtime validation before
publication. CI is configured but has not been run remotely for this new repository.

There is deliberately no automatic publish job. Building an artifact is not proof
that it works on its target host.

## Preparing a future release

1. Finalize the public API, package ownership/name, repository URL and supported target set.
2. Pass all checks, including current compatibility notes and representative producer workbooks.
3. Build and test every target being advertised, then collect all `.node` artifacts under `native/`.
4. Run the official CLI's `pnpm exec napi create-npm-dirs` to generate platform packages.
5. Use `pnpm artifacts` to copy collected artifacts into those platform packages.
6. Review `pnpm exec napi prepublish --dry-run` and the generated optional dependencies.
   The non-dry-run prepublish command can publish platform packages; it is a release
   action, not a normal build/check command.
7. Verify release tarballs and clean installs for every supported target before publishing
   platform packages and then the main package with provenance.

The local tarball bundles the current host's binary. It is a smoke-test artifact,
not a complete cross-platform release. No remote repository or npm package was
created by initialization.

## Reproduce performance measurements

Only use local synthetic or explicitly approved files. The helper accepts an
explicit SheetJS installation path as an optional comparison tool; SheetJS is not
an installed dependency of this package.

```sh
node scripts/generate-benchmarks.cjs /path/to/xlsx.js /tmp
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-workbook
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx complete-sheet
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet-256
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet-512
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx parse-only
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx single-native-batch
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx batches
node --expose-gc scripts/benchmark.mjs /tmp/calamine-strings-100k.xlsx stringify
node --expose-gc scripts/benchmark.mjs /tmp/calamine-strings-100k.xlsx parse-json
node --expose-gc scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx sheetjs /path/to/xlsx.js
bun scripts/benchmark.mjs /tmp/calamine-numeric-1m.xlsx read-sheet
```

The `complete-sheet` mode calls `read(path, { sheets: 0 })`; `complete-workbook` calls
`read(path)`. Archived reports retain the API names used when measured.

The helper measures one warmup and five runs. Do not run competing benchmarks in
parallel. Record hardware, runtimes, input shape, warm/cold state, first-result and
completion times, JS heartbeat gaps and memory methodology. Compare semantically
equivalent results, not just differently configured parsers.
