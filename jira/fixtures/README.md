The `create-lan.json`, `create-aitr.json`, and `create-users.json` fixtures were
recorded from Jira Cloud on 2026-10-13 using GET-only requests. They cover all
20 LAN issue types and three AITR types. The create responses retain required
fields plus Assignee, Labels and Priority. Allowed values retain only option
identity, display and active-state properties. No values or required flags were
invented. Full scrubbed responses remain in the review evidence directory.

People are replaced with `review-user-N` and `Reviewer N`; emails, avatar URLs,
self URLs and credentials are removed. A pre-commit scan checks for the authorized
key and `@lansweeper.com` without printing the key. `cloud.json` remains the older
synthetic documentation-shape fixture and is not live evidence.

`create-lan-wide.json` holds the full 57-field create metadata of the LAN Task
type, recorded the same way (GET only, 2026-10-13). Every field Jira offered is
kept; only the allowed values are cut to the first 12 per field, and issue type
descriptions are blanked. It exists to test the layout of a wide schema.

`grouped-priority-model.json` is the scrubbed provider model recorded during the read-only Jira review on 2026-10-13. It preserves the observed status-grouped result of a priority grouping request. The host regression uses these rows and the real provider declarations to verify unsupported groups are not offered; it is not a REST response or evidence of live server acceptance.

## Evidence still required for provider closure

The files above do not make `cloud.json` a recorded fixture. In particular,
recorded issue detail does not prove the separate comments or transitions calls.
The recorded-detail tests supply empty comment and transition responses locally.

The remaining real-site evidence is:

- Per-issue `GET /rest/api/3/issue/{key}/transitions` and independent
  `GET /rest/api/3/issue/{key}/comment` pages.
- `GET /rest/agile/1.0/board/{boardId}/configuration`, including a column with
  multiple statuses and the relation to the issue's legal transitions.
- An observed 429 response with its `Retry-After` header. Do not generate load
  to force a rate limit; retain this boundary as unverified until observed.
- Account verification through the core Basic/PAT port and a post-write ADF
  read-back. ADF write/read-back needs separate scratch-project write consent;
  read-only recording authorization does not permit it.

Use an operator-authorized test account/site. Record method, endpoint, date,
status, relevant headers and scrub rules with each new fixture. Never copy a
credential from a token store or label a constructed response as a recording.
