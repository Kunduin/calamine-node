# Platform builds and CI costs

The package declares eight native targets. Cross-compiling a `.node` file verifies
compilation and linking; compatibility requires loading it and running tests on a
matching operating system, architecture and C runtime.

## Local verification — 2026-09-18–19

Host: Linux x64 GNU, Intel Core i5-12400. Rust 1.98.1, napi-rs CLI 3.10.4,
Zig 0.15.2, cargo-zigbuild 0.23.4 and cargo-xwin 0.23.1. The local build loop uses
four Cargo build jobs and writes platform binaries to `native/`.

| Target             | Native binary              | Local runtime verification                    |
| ------------------ | -------------------------- | --------------------------------------------- |
| Linux x64 GNU      | Built                      | Node 22.23.2: 41 tests; Bun 1.4.1: 41 tests   |
| Linux ARM64 GNU    | Built                      | Requires ARM64 runner                         |
| Linux x64 musl     | Built                      | Alpine 3.22 / Node 22.23.2: 41 tests          |
| Linux ARM64 musl   | Built                      | Requires ARM64 musl runner                    |
| macOS x64          | Built by cross-compilation | Requires Intel Mac                            |
| macOS ARM64        | Built by cross-compilation | Requires Apple Silicon Mac                    |
| Windows x64 MSVC   | SDK setup did not finish   | Rust target check passed; no DLL runtime test |
| Windows ARM64 MSVC | SDK setup did not finish   | Rust target check passed; no DLL runtime test |

The six successful builds produced ELF or Mach-O shared libraries with the expected
architectures. The build loop took 3.5–20.5 seconds per successful target after tool
installation; the x64 GNU target was already cached. These are local observations,
not cold-build timings on GitHub-hosted runners.
The [machine-readable report](builds/2026-09-19.json) records commands, exit codes,
timings, binary sizes, SHA-256 hashes and runtime checks. The six binaries total
about 12.9 MiB uncompressed and remain in the ignored `native/` directory.

Both Windows `cargo check --locked --target ...` checks passed. Full native builds
were attempted through cargo-xwin, but the default backend did not finish preparing
the Microsoft SDK/CRT within a 360-second budget per target. A separate attempt
used the alternate clang backend and also timed out after 180 seconds per target.
Toolchain preparation is not a compiler rejection of the project, and a successful check is not a linked
DLL. The workflow uses native Windows runners to avoid this cross-toolchain setup.

The Alpine test used the locally cached Alpine 3.22 image after pulling the Node
image failed. Its Node package was downloaded from the official Alpine CDN and
verified with `apk verify`; all 41 tests then passed with the musl binary. The test
container was removed afterward. No production services were tested.

GNU targets use the official `--use-napi-cross` toolchain with a glibc 2.17 floor.
The observed ELF symbol requirements are at most GLIBC 2.14 for x64 and GLIBC 2.17
for ARM64. This is a linker inspection, not a runtime test on older distributions.
Musl binaries depend on `libc.so` and contain no GLIBC version requirements.
Both Windows MSVC targets are configured to link the CRT statically.

The local cross-compilers are development tools, not npm package dependencies.
For reproduction from Linux, install the target standard libraries with
`rustup target add <target>`, then use the official CLI:

```sh
# Linux GNU (x64 or ARM64): the CLI downloads its GCC cross-toolchain.
pnpm exec napi build --platform --release --output-dir native --js binding.cjs --dts binding.d.cts --target aarch64-unknown-linux-gnu --use-napi-cross

# Musl/macOS: requires Zig and cargo-zigbuild on PATH.
# Windows MSVC: requires Clang and cargo-xwin; the Microsoft SDK/CRT is downloaded.
pnpm exec napi build --platform --release --output-dir native --js binding.cjs --dts binding.d.cts --target x86_64-unknown-linux-musl -x
```

The macOS cross-build works for this dependency graph, which does not need Apple
frameworks. Future native dependencies may require a real macOS SDK. Prefer native
macOS and Windows runners for release builds. See the
[napi-rs cross-build guide](https://napi.rs/docs/cross-build).

## GitHub Actions workflow

[CI.yml](../.github/workflows/CI.yml) uses standard GitHub-hosted runners:

- Eight build jobs, one per declared target, each followed by Node 22 tests.
- Native ARM64 runners for Linux and Windows; separate Intel and Apple Silicon Macs.
- Linux musl tests run in an Alpine Node container on the matching CPU architecture.
- Bun 1.4.1 tests run on Linux GNU x64 and ARM64, plus the quality job.
- Six additional Node 24/26 jobs cover Linux GNU x64, macOS ARM64 and Windows x64.
  They download the previously built native binary, JS and compiled tests, so they
  do not install Rust, install npm dependencies or compile the addon again.
- A quality job runs formatting, linting, strict TypeScript, Rust tests and packed
  package checks. Rust build caches are saved on main; artifacts are kept for 3 days.
- Build/quality jobs time out after 20 minutes; runtime-only jobs after 10 minutes.
  New runs cancel older runs for the same ref. Nothing publishes automatically.

The workflow passed local actionlint validation. A staged artifact with no
`node_modules` also passed the 41 Node tests on Linux x64 GNU, checking the runtime
jobs' artifact reuse. This repository currently has no GitHub remote, so hosted
workflow runs have not been executed or timed.

## Cost estimate

Rates checked on 2026-09-18. Standard GitHub-hosted runner execution is free for
public repositories. Larger runners remain paid; this workflow does not use them.
Private repositories receive a monthly allowance (GitHub Free: 2,000 minutes;
Pro: 3,000), after which runner usage is billed. Artifact storage has a separate
allowance and is shared with GitHub Packages; cache storage includes 10 GB per
repository. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

| Standard runner     | Overage rate, USD/minute |
| ------------------- | -----------------------: |
| Linux x64           |                    0.006 |
| Linux ARM64         |                    0.005 |
| Windows x64 / ARM64 |                    0.010 |
| macOS Intel / ARM64 |                    0.062 |

These are the [published runner rates](https://docs.github.com/en/billing/reference/actions-runner-pricing),
not measurements of this repository on GitHub. Assuming **6–10 minutes per build
job**, **4 minutes for quality** and **2 minutes for each runtime-only job**, one
complete run is approximately **USD 1.33–2.00** when all execution is billed, excluding
storage. This sums all jobs, not just wall-clock duration, and applies before any
included allowance. Caches, downloads, queueing and runner hardware affect the
actual duration. Public-repository standard runner execution remains USD 0.

For example, 100 fully billed runs under those assumptions would be about
USD 133–200 before storage. Artifact overage is USD 0.25/GB-month under the billing
documentation above. Short artifact retention and reuse of native binaries keep
costs down without dropping architecture tests. Prefer measuring the first hosted
run before setting a private-repository budget.
