# Claim Context Preview Operator Test Report

- PASS: 9
- FAIL: 0
- Total: 9

| Fixture | Status | Detail |
|---|---:|---|
| preview activation enables diagnostics without prompt injection or excerpts | PASS | ok |
| preview activation preserves existing record-mode recording flags | PASS | ok |
| validation refuses injection and source excerpts | PASS | ok |
| activation helper refuses to write without explicit confirm | PASS | ok |
| activation writes backup and rollback disables only claim context | PASS | ok |
| operator summary omits full next config from json output | PASS | ok |
| operator script plans, applies, and rolls back temp config only with --yes | PASS | ok |
| operator script rejects injection and source excerpt flags | PASS | ok |
| rollback preview is valid and disables claim context | PASS | ok |
