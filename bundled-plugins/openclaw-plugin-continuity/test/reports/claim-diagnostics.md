# Claim Diagnostics Test Report

- PASS: 8
- FAIL: 0
- Total: 8

| Fixture | Status | Detail |
|---|---:|---|
| createClaimDiagnostic omits source excerpts and source content by default | PASS | ok |
| diagnostic marks runtime claims verify-before-asserting | PASS | ok |
| diagnostic marks superseded/retracted claims as do-not-use | PASS | ok |
| source excerpts are opt-in and truncated | PASS | ok |
| inspectClaim reads a single claim from an explicit store only | PASS | ok |
| inspectClaimWithResolvedSources does not resolve unless explicitly requested | PASS | ok |
| resolved source content remains hidden unless explicitly requested | PASS | ok |
| summarizeClaimStore returns compact diagnostic counts | PASS | ok |
