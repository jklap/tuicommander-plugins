# Projects permission evidence

Retrieved read-only from GitHub Docs on 2026-10-25:
https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects#authentication

> In all of the following curl command examples, replace TOKEN with a token that has the read:project scope (for queries) or project scope (for queries and mutations).

The same guide uses `updateProjectV2ItemFieldValue` for field updates.
`read:project` is read-only; `project` permits reads and mutations. This is
documentation evidence, not a recorded mutation failure or a successful write.

Source HTML SHA-256: `ac2e9150a11a8768478abced14f20b0cedb716164ab2bd551942c8ff7bfd2faf`.
