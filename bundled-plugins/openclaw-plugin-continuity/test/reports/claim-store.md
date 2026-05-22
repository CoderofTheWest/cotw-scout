# Claim Store Test Report

- PASS: 10
- FAIL: 0
- Total: 10

| Fixture | Status | Detail |
|---|---:|---|
| createTables is idempotent and records named migration | PASS | ok |
| storeClaim persists claim and source refs transactionally | PASS | ok |
| storeClaim accepts raw input with explicit id and normalizes sources | PASS | ok |
| storeClaim replaces old sources for same claim id | PASS | ok |
| storeEdge persists supersession relationship | PASS | ok |
| listClaims and getSourcesByHandle return filtered records | PASS | ok |
| queryClaims supports source handle and source inclusion filters | PASS | ok |
| getClaimsBySourceHandle requires an explicit handle | PASS | ok |
| queryClaims supports verification and confidence/text filters | PASS | ok |
| getStats summarizes claims/sources/edges | PASS | ok |
