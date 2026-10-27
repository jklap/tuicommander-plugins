The `create-lan.json`, `create-aitr.json`, and `create-users.json` fixtures were
recorded from Jira Cloud on 2026-10-13 using GET-only requests. They cover all
20 LAN issue types and three AITR types. The create responses retain required
fields plus Assignee, Labels and Priority. Allowed values retain only option
identity, display and active-state properties. No values or required flags were
invented. Full scrubbed responses remain in the review evidence directory.

People are replaced with `review-user-N` and `Reviewer N`; emails, avatar URLs,
self URLs and credentials are removed. A pre-commit scan checks for the authorized
key and `@lansweeper.com` without printing the key. `cloud-contract.json` preserves
the older synthetic documentation-shape fixture and is not live evidence.

`create-lan-wide.json` holds the full 57-field create metadata of the LAN Task
type, recorded the same way (GET only, 2026-10-13). Every field Jira offered is
kept; only the allowed values are cut to the first 12 per field, and issue type
descriptions are blanked. It exists to test the layout of a wide schema.

`grouped-priority-model.json` is the scrubbed provider model recorded during the read-only Jira review on 2026-10-13. It preserves the observed status-grouped result of a priority grouping request. The host regression uses these rows and the real provider declarations to verify unsupported groups are not offered; it is not a REST response or evidence of live server acceptance.

## Authorized test-site recording, 2026-10-27

`cloud.json` now contains real responses from `https://straus-team.atlassian.net`,
a separate operator-owned test site. Writes were authorized only on that site.
The REST API created the `TUIC` scratch project and two issues. The recording
contains actual response bodies for:

- Basic-auth `myself` verification and project creation.
- Project issue types and the full Task create schema.
- Issue creation, a successful transition, and issue/ADF read-back.
- Independent comment pages at offsets 0 and 1, after two real comment writes.
- Enhanced search pages with an opaque `nextPageToken` and a malformed-JQL 400.
- The scratch Scrum board's configuration and its legal per-issue transitions.

`provenance.records` retains each method, path, timestamp, HTTP status, relevant
headers and scrubbed response body. Top-level fields reference those responses
for bounded provider replay tests. Account IDs become `recorded-user-N`; user
display names, email addresses, avatar URLs and self links are redacted. The
exact authorized test email, API key and Basic-auth payload are scanned before
commit. No raw response or credential file is committed.

The previous synthetic values remain in `cloud-contract.json` only for explicit
contract edge cases. `provider.test.js`, `main.test.js` and `jql-errors.test.js`
use those inputs; `recorded-cloud.test.js` uses the real recording instead.
The older recorded-detail tests still supply local empty comment/transition
responses and do not claim those are recordings.

## Evidence still required for provider closure

- A board column containing multiple statuses. The recorded scratch board has
  one status per column; no response was edited to invent another workflow.
- An observed 429 response with its `Retry-After` header. Do not generate load
  to force a rate limit; retain this boundary as unverified until observed.
- Data Center PAT/context-path behavior and multi-site live behavior. Cloud
  recordings do not prove these independent environments.
- Native loaded-plugin authentication/settings/create evidence is tracked in
  the parent repository's live report; REST recordings alone do not prove it.

Use an operator-authorized test account/site. Record method, endpoint, date,
status, relevant headers and scrub rules with each new fixture. Never copy a
credential from a token store or label a constructed response as a recording.
