# Active Thread Digest Test Report

- PASS: 4
- FAIL: 0
- Total: 4

| Fixture | Status | Detail |
|---|---:|---|
| creates valid digest with source handles | PASS | fresh / verify=false |
| nine day old digest is stale and verify-required | PASS | stale / verify=true |
| selects current continuity digest over parallel instagram thread | PASS | selected=continuity-spine |
| missing source handles forces verification policy | PASS | fresh / verify=true |
