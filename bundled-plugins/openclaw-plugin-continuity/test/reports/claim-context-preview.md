# Claim Context Preview Test Report

- PASS: 9
- FAIL: 0
- Total: 9

| Fixture | Status | Detail |
|---|---:|---|
| preview is disabled by default and does not query store | PASS | ok |
| preview refuses mode off and invalid live injection combinations | PASS | ok |
| enabled preview renders packet without making it injection-ready | PASS | ok |
| live minimal mode only selects applied accept_verified claims and becomes injection-ready | PASS | ok |
| live minimal mode stays preview-only when no accepted verified claim is available | PASS | ok |
| enabled preview scans beyond output limit so excluded candidates do not starve usable claims | PASS | ok |
| enabled preview returns a redacted audit report for operator review | PASS | ok |
| preview preserves source excerpts only by explicit config opt-in | PASS | ok |
| preview returns disabled result when store is unavailable | PASS | ok |
