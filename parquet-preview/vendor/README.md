# Vendored reader sources

Pinned npm sources: hyparquet 1.33.0, fflate 0.8.2, fzstd 0.1.1. Each package retains its MIT licence and package metadata. Runtime imports use only browser-compatible ES modules. Unused declarations and upstream readmes are omitted. fflate esm/browser.js is renamed browser.mjs without a content change for explicit Node ESM tests.

Local hyparquet patch: src/convert.js formats DECIMAL values with exact BigInt arithmetic and scale-preserving text instead of Number; it also handles logical-only DECIMAL annotations. The generated 30-digit PyArrow decimal fixture protects this patch. No other upstream source edits.

Sources: https://registry.npmjs.org/hyparquet/-/hyparquet-1.33.0.tgz, https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz, https://registry.npmjs.org/fzstd/-/fzstd-0.1.1.tgz.
