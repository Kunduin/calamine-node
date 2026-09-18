# Native dependency size comparison — 2026-09-19

OpenDAL with S3 and OSS adds about **4.80 MiB uncompressed / 2.20 MiB gzip** over
the direct HTTP implementation in this experiment. It is a meaningful dependency,
even when unrelated services and layers are disabled. Tokio alone adds only about
0.23 MiB uncompressed.

These are measured, loadable Linux x64 GNU native addons, not crate download sizes,
dependency counts used as a size estimate, or unused dependencies declared in a
manifest. The project's shipping implementation and dependency manifests were not
changed. The full measurements and artifact hashes are in
[the JSON report](native-size-2026-09-19.json).

## Results

One MiB is 1,048,576 bytes. Compression is gzip level 6 applied to one `.node` file;
it approximates the binary's contribution to a download, not an actual npm tarball.
JavaScript, declarations, documentation, and package metadata are excluded from all
rows equally.

| Configuration                     | Native addon |   gzip-6 | Active dependency packages |
| --------------------------------- | -----------: | -------: | -------------------------: |
| Existing parser                   |     1.71 MiB | 0.79 MiB |                         61 |
| Parser + Tokio async probe        |     1.93 MiB | 0.89 MiB |                         62 |
| Parser + native HTTP/TLS download |     6.87 MiB | 2.85 MiB |                        137 |
| Parser + OpenDAL S3               |    10.64 MiB | 4.67 MiB |                        191 |
| Parser + OpenDAL S3 and OSS       |    11.67 MiB | 5.05 MiB |                        193 |

The dependency counts include normal and build dependencies for the selected target,
excluding the root crate, dev-only dependencies, and inactive features/targets. They
are Rust build dependencies, not packages that npm consumers must separately install.

- HTTP/TLS adds 5.17 MiB raw / 2.06 MiB gzip over the original parser.
- OpenDAL S3+OSS adds another 4.80 MiB raw / 2.20 MiB gzip over direct HTTP.
- Adding OSS to the OpenDAL S3 build costs 1.03 MiB raw / 0.39 MiB gzip.
- The combined addon is about 6.84 times the original native binary's size.

## Method

The experiment copied commit `1f57e633ae596b736ecedc3f70f9411b70b24bec` into an
isolated directory. Existing parser source and the original locked package versions
were retained. One conditional Rust module added callable Node-API probes. All five
variants used the same final source tree and lockfile, with feature flags selecting
which probes to compile.

Common build settings:

- `x86_64-unknown-linux-gnu`, rustc 1.98.1, host linker.
- `cargo build --release --locked --lib --target x86_64-unknown-linux-gnu --no-default-features -j 4`.
- The project's existing `opt-level = 3`, `lto = "thin"`, `strip = "symbols"`;
  default unwind panic behavior.
- The produced `libcalamine_node.so` was copied directly to a `.node` file.
- No `opt-level = "z"`, UPX, alternate TLS provider, or custom linker optimization
  was introduced to favor one variant.

Versions were checked against crates.io before building:

- napi 3.12.6 and Calamine 0.36.1, unchanged from the project.
- Tokio 1.53.1.
- reqwest 0.13.5, with default features disabled and `rustls`, `stream` enabled.
- OpenDAL and its HTTP transport 0.59.2.
- futures-util 0.3.34.

The HTTP probe holds a reusable reqwest client. The OpenDAL probe holds a reusable
operator built with a typed S3 or OSS builder, plus retry and timeout layers. Both
download incrementally into a size-limited Rust-owned buffer, then invoke the
existing Calamine adapter in `spawn_blocking`. The returned summary includes sheet
count and the first worksheet's parsed dimensions. This makes network, signing,
stream-consumption, and parsing paths reachable from exported Node-API methods.

OpenDAL default features were disabled. Only `executors-tokio`, `layers-retry`,
`layers-timeout`, and the selected `services-s3`/`services-oss` were enabled.
Its official `opendal-http-transport-reqwest` crate was configured with `rustls` and
installed directly. There is no need to register URI factories when typed builders
already select the backend. Avoiding the general service registry reduced the
combined build from 12.81 MiB to 11.67 MiB; both configurations had a working HTTP
transport. A preliminary build without an installed transport failed its runtime
check and is excluded from the results.

ELF dependency inspection found only the normal system C/math/compiler runtime
libraries. The additional storage and TLS functionality was not moved into a
separately distributed shared library to make the addon appear smaller.

## Validation and limits

All five final addons loaded and parsed the existing synthetic XLSX fixture in
Node 22.23.2 and Bun 1.4.1. The async variants also completed their Tokio probe.
Every network variant downloaded and parsed that fixture from a loopback HTTP
server twice with the same client, and rejected an input exceeding its byte limit.
The OpenDAL checks exercised S3 and OSS requests with synthetic credentials and
checked the corresponding authorization header schemes.

The mock server does not validate cloud signatures. HTTPS support was compiled in,
but these smoke checks used local HTTP, not a TLS handshake or a real cloud service.
No production systems, actual OSS credentials, or customer workbooks were used.

These probes estimate the linked cost of practical input paths. They do not implement
the complete proposed public remote-reading API, credential refresh policy, global
admission budgets, cancellation protocol, or disk-spooling policy. Existing parser
exports in the archived baseline still use AsyncTask. These isolated probes are
not a completed migration to Tokio, a throughput benchmark, or a memory benchmark.
The later production implementation uses Tokio for bounded parsing; these measurements
remain the historical comparison, not its final binary size.

Build timings in the JSON are cached sequential observations and must not be used
to compare cold CI build times. Results cover only this Linux x64 GNU host build,
not the project's glibc-floor cross build or the other seven platform targets.

## Reproduction

The accompanying `native-size-experiment.tar.gz` contains the isolated source,
lockfile, synthetic fixtures, probe, build driver, and smoke checks. Its checksum is
recorded in the JSON report. With Rust, Python 3, Node, and Bun installed, extract it
into an empty directory and run:

```sh
python3 build.py
python3 verify.py
```

The build driver creates its own `target/`, `logs/`, and `artifacts/` directories.
It records raw/gzip sizes, SHA-256 values, and active dependency trees. Each variant
is tested in a fresh Node/Bun process. Exact binary hashes may depend on build paths
and the host toolchain; the recorded hashes identify the artifacts measured here.

## Implication for packaging

OpenDAL remains a reasonable choice for a server library deliberately offering
native S3/OSS integration. Its benefit is maintained storage behavior and a reusable
abstraction, not a negligible footprint. These results do not establish a runtime
performance advantage over direct HTTP.

For local-file-only consumers, including it in every native binary imposes a clear
download-size cost. Cargo features select functionality when building the addon;
an npm consumer cannot remove already compiled storage support through a JS import.

The decision after reviewing these measurements is to defer native networking.
Applications can continue using their OSS/S3 SDK to obtain a Buffer, download
directly to a local file, or provide a generic stream. Local file reading remains
supported. No OpenDAL, reqwest, or additional runtime dependency was added to the
shipping project, and no separate remote-input npm package is being introduced.
Input ownership/copying and parsing/output costs can be improved independently.
