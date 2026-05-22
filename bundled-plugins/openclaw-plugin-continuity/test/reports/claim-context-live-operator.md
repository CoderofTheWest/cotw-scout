# Claim Context Live Operator Test Report

- PASS: 8
- FAIL: 0
- Total: 8

| Fixture | Status | Detail |
|---|---:|---|
| live activation enables only accepted verified minimal injection | PASS | ok |
| validation refuses recording flags, excerpts, and non-accepted injection | PASS | ok |
| activation helper refuses to write without explicit confirm | PASS | ok |
| activation writes backup and rollback disables claim-context live gate | PASS | ok |
| operator summary omits full next config from json output | PASS | ok |
| operator script plans, applies, and rolls back temp config only with --yes | PASS | ok |
| operator script rejects source excerpt flags | PASS | ok |
| rollback preview is valid and disables claim context | PASS | ok |
