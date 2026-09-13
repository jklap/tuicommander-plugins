# XLSX Preview

Preview spreadsheets in TUICommander as sortable tables, the way `csv-preview` does for delimited text.

Handles `.xlsx`, `.xlsm`, `.xltx`, `.xltm`, `.xlsb`, `.xls`, `.ods` and `.fods` through SheetJS.

## Features

- Opens spreadsheets through the file preview plugin hook, so a click in the File Browser is enough
- One tab per worksheet; the first sheet opens first
- The first row of each sheet becomes the table header, and any column sorts on click
- Cells show the value the spreadsheet displays — dates keep the workbook's own format, and percentages and currencies stay formatted
- Edit button opens the raw file in the code editor

## Limits

- 2000 rows and 200 columns per sheet. The whole workbook is embedded in the panel, so the cap bounds the payload; the panel reports what it hides.
- 10 MB per file — the ceiling `host.readFileBase64()` enforces.
- Cell styling, merged cells, charts and images are not rendered. This is a reader for the values, not a spreadsheet.

## Tests

```bash
node --test xlsx-preview/
```

## Capabilities

- `ui:file-preview`
- `ui:panel`
- `fs:read`

SheetJS (`xlsx`) 0.20.3 is vendored under `vendor/` with its Apache-2.0 license.
