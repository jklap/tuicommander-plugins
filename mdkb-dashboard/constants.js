// Constants shared by the dashboard modules.

export const DB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M1 3.5c0-1.865 2.91-3 6-3s6 1.135 6 3v9c0 1.865-2.91 3-6 3s-6-1.135-6-3v-9zm1.156 4.843C3.328 9.372 5.089 10 7 10s3.672-.628 4.844-1.657v2.157c0 .828-1.89 2-5.344 2S1.5 11.328 1.5 10.5V8.343h.156-.5.5zm0 4C3.328 13.372 5.089 14 7 14s3.672-.628 4.844-1.657V14.5c0 .828-1.89 2-5.344 2S1.5 15.328 1.5 14.5v-2.157h.156-.5.5zM7 1.5c-3.454 0-5.344 1.172-5.344 2S3.546 5.5 7 5.5s5.344-1.172 5.344-2S10.454 1.5 7 1.5zM2.156 4.843C3.328 5.872 5.089 6.5 7 6.5s3.672-.628 4.844-1.657V6.5c0 .828-1.89 2-5.344 2S1.5 7.328 1.5 6.5V4.843h.156-.5.5z"/></svg>`;

/**
 * Maintenance actions surfaced as header buttons. `argv` is appended after
 * `["--format", "json"]` (except compact, which ignores --format). `json:false`
 * means stdout is not a single parseable JSON document — we run fire-and-forget
 * and re-read state from `status` afterwards.
 */
export const ACTIONS = {
  update: { label: "Reindex", argv: ["update"], json: false, slow: true },
  "update-force": { label: "Force reindex", argv: ["update", "--force"], json: false, slow: true },
  "code-force": { label: "Rebuild code", argv: ["update", "--code", "--force"], json: true, slow: true },
  embed: { label: "Re-embed", argv: ["update", "--reembed"], json: true, slow: true },
  compact: { label: "Compact", argv: ["compact"], json: false, slow: true, noFormat: true },
};
