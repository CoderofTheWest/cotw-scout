# Record Mode Operator Test Report

- PASS: 7
- FAIL: 0
- Total: 7

| Fixture | Status | Detail |
|---|---:|---|
| preview activation preserves unrelated config and enables handoff only | PASS | ok |
| activation helper refuses to write without explicit confirm | PASS | ok |
| activation writes backup and rollback restores inert source-addressable config | PASS | ok |
| rollback preview is inert and keeps inject mode none | PASS | ok |
| operator summary omits full next config from json output | PASS | ok |
| operator script plans, applies, and rolls back temp config only with --yes | PASS | ok |
| operator script refuses broad source activation | PASS | ok |
