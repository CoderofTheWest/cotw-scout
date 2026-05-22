# Claim Candidate Operator Test Report

Generated: 2026-05-06T23:07:09.682Z

| Test | Status | Detail |
| --- | --- | --- |
| activation enables one candidate source and preserves live verified gate | PASS | ok |
| activation supports summary or digest but still exactly one source | PASS | ok |
| validation rejects automatic belief promotion shapes | PASS | ok |
| activation helper refuses writes without explicit confirm | PASS | ok |
| activation writes backup and rollback closes candidate lane while preserving live gate | PASS | ok |
| rollback validation requires candidate lane closed but live gate preserved | PASS | ok |
| operator summary omits full next config from json output | PASS | ok |
| operator script plans, applies, and rolls back temp config only with --yes | PASS | ok |
| operator script rejects promotion and excerpt flags | PASS | ok |
