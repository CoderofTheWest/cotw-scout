# Claim Review Decision Command Test Report

- PASS: 8
- FAIL: 0
- Total: 8

| Fixture | Status | Detail |
|---|---:|---|
| parser requires explicit decision and claim id | PASS | ok |
| dry-run accept_verified plans promotion without mutating store | PASS | ok |
| apply accept_verified is explicit and records mutation through operator command | PASS | ok |
| verify command updates verification timestamp but does not promote | PASS | ok |
| command refuses source resolution and metadata display flags | PASS | ok |
| command reports inert default when ClaimStore is unavailable | PASS | ok |
| command reports missing claim as a bounded operator failure without mutation | PASS | ok |
| command returns decision validation errors instead of mutating | PASS | ok |
