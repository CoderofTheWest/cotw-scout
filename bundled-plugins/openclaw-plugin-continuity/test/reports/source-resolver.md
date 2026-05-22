# Source Resolver Test Report

- PASS: 14
- FAIL: 0
- Total: 14

| Fixture | Status | Detail |
|---|---:|---|
| file resolver extracts workspace-relative line range | PASS | ok |
| file resolver blocks absolute paths and traversal | PASS | ok |
| handoff resolver scans configured handoff dirs and extracts lines | PASS | ok |
| digest resolver reads explicit thread version and field | PASS | ok |
| digest resolver refuses stale version mismatch | PASS | ok |
| digest resolver can resolve summary-backed handles from SummaryStore | PASS | ok |
| digest summary resolver enforces thread mismatch when available | PASS | ok |
| non-summary digest handles still require ActiveThreadDigestStore | PASS | ok |
| summary digest handles require SummaryStore before falling back to legacy digest fields | PASS | ok |
| transcript resolver supports current-session messages only | PASS | ok |
| archive resolver supports explicit exchange id and numeric fallback | PASS | ok |
| unsupported handle types are unresolved, not thrown | PASS | ok |
| custom adapter can resolve out-of-scope handle types | PASS | ok |
| resolver composes with provenance regrounding | PASS | ok |
