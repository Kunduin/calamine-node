# Platforms and CI

All eight targets below have passed native loading and runtime tests on
[GitHub-hosted runners](https://github.com/Kunduin/calamine-node/actions/runs/35416056809).
Every release repeats these checks on its tagged commit.

## Target matrix

The target list in `package.json` and `.github/workflows/CI.yml`
cover:

| Target             | Build environment                     | Runtime check           |
| ------------------ | ------------------------------------- | ----------------------- |
| Linux x64 GNU      | Ubuntu x64, napi-rs cross toolchain   | Node 22 and Bun         |
| Linux ARM64 GNU    | Ubuntu ARM64, napi-rs cross toolchain | Node 22 and Bun         |
| Linux x64 musl     | Ubuntu x64, Zig                       | Node 22 in Alpine x64   |
| Linux ARM64 musl   | Ubuntu ARM64, Zig                     | Node 22 in Alpine ARM64 |
| macOS x64          | Intel macOS runner                    | Node 22                 |
| macOS ARM64        | Apple Silicon runner                  | Node 22                 |
| Windows x64 MSVC   | Windows x64 runner                    | Node 22                 |
| Windows ARM64 MSVC | Windows ARM64 runner                  | Node 22                 |

Node 24 and 26 additionally reuse built artifacts on Linux x64 GNU, macOS ARM64,
and Windows x64. These jobs run the compiled tests without rebuilding Rust.
GNU builds use the napi-rs cross toolchain's glibc 2.17 target baseline; this is a
build configuration, not a claim of runtime verification on every distribution.

Compilation and linking alone do not verify native loading, ABI compatibility,
or runtime behavior. Do not label a platform supported based solely on a successful
cross-build.

## Workflow behavior

The quality job checks formatting, linting, Rust and TypeScript, Node/Bun tests,
and installed npm artifacts. Build jobs test their matching operating system,
CPU architecture, and C runtime before uploading artifacts.

Rust caches are saved on `main`. Artifacts are retained for three days and reused
by runtime-only jobs. New push and PR runs cancel older checks for the same ref;
release runs are not cancelled by later pushes. Build and quality jobs time out
after twenty minutes; runtime-only jobs after ten minutes.

The Publish workflow calls this same CI before assembling and checking npm
tarballs. It retains the complete release packages for 14 days. Version changes
are reviewed through Release Please PRs; see [release instructions](development.md#routine-releases).

The workflow uses standard GitHub-hosted runners. Check your repository's current
[Actions billing settings](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
for allowances and prices. Estimate costs from measured hosted-job durations;
local cross-build timings and historical runner rates are not reliable budgets.

## Local builds

Use `pnpm build` for the current host. To build another target, install its Rust
standard library and follow the [napi-rs cross-build guide](https://napi.rs/docs/cross-build).
Release verification still requires running the resulting addon on its actual
platform. Prefer the native Windows and macOS CI runners to maintaining local
cross-platform SDK installations.
