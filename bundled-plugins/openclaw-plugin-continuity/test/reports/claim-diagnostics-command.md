# Claim Diagnostics Command Test Report

- PASS: 21
- FAIL: 0
- Total: 21

| Fixture | Status | Detail |
|---|---:|---|
| default command action is stats | PASS | ok |
| list action returns compact claim diagnostics without source handles or excerpts | PASS | ok |
| verify action is read-only and returns only verification-required claims | PASS | ok |
| command refuses source excerpt and metadata flags | PASS | ok |
| context action renders safe source-handle packet without source excerpts | PASS | ok |
| context action scans beyond output limit so excluded candidates do not starve useful claims | PASS | ok |
| audit action renders redacted operator audit without claim text or source handles | PASS | ok |
| trial action renders redacted manual trial plan without source handles | PASS | ok |
| verification action renders redacted verification plan without source handles | PASS | ok |
| preflight action renders redacted bundled operator receipt | PASS | ok |
| review action blocks mixed packets and stays redacted | PASS | ok |
| review action can prepare a clean narrow packet without source excerpts | PASS | ok |
| review action excludes fixture-only claims unless explicitly included | PASS | ok |
| research action loads candidate-only verify-required and stale claims without active claim noise | PASS | ok |
| research action stays read-only and does not resolve source excerpts | PASS | ok |
| research action handles empty stores cleanly | PASS | ok |
| command rejects invalid status and kind filters before querying | PASS | ok |
| command rejects dangling value flags instead of treating them as empty filters | PASS | ok |
| command rejects invalid numeric filters before querying | PASS | ok |
| command reports inert default when ClaimStore is unavailable | PASS | ok |
| argument parser keeps the exposed workflow to stats list verify context audit trial verification preflight review research | PASS | ok |
