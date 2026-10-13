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
