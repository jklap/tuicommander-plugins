# Parquet Preview

Open `.parquet` files to inspect schema, nullability, metadata row count and pages of 100 rows. Read only: no queries or editing. Snappy, gzip and Zstd are supported locally without network requests.

Requires TUICommander 2.0.1 or later built with `fileSize` and `readFileRange`. File reads use the standard `fs:read` capability. The preview reads the footer and requested row groups, not the entire file. Each host read is at most 8 MiB. A single library range is limited to 128 MiB; oversized row groups show an error. Decompression and decoding may require additional memory proportional to the selected row groups. Reopen after the file changes.

Null cells show italic `NULL`. Nested values show JSON. INT64 values keep their decimal digits. Dates and timestamps show ISO text. A documented local reader patch formats decimals with BigInt arithmetic to preserve digits. Custom timestamp parsers preserve microsecond and nanosecond fractions.

## Vendored reader

- hyparquet 1.33.0 (MIT), published 2026-11-08, 303397 unpacked npm bytes. Pure JavaScript ES modules, built-in Snappy; its AsyncBuffer supports range reads and row pruning. Browser support avoids native addons and a large general-purpose query engine.
- fflate 0.8.2 (MIT): synchronous gzip decoder; fzstd 0.1.1 (MIT): synchronous Zstd decoder. Pure JavaScript keeps WebView deployment offline and avoids WASM loader constraints. fzstd has a slower release cadence; real Zstd fixtures verify this version.
- The local patch in hyparquet/src/convert.js replaces numeric decimal conversion with exact scaled text, including logical-only DECIMAL annotations. Source packages are pinned under `vendor/`, with upstream licences. Node-specific hyparquet entrypoints are not imported. No runtime package installation or CDN.

Generate fixtures with `python parquet-preview/scripts/generate-fixtures.py` in an environment with PyArrow. Fixtures contain 205 rows in four row groups (60/60/60/25) in each supported codec. Run `node --test parquet-preview/model.test.js`.
