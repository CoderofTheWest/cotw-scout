# Claim Source Verification Command Test Report

- PASS: 6
- FAIL: 0
- Total: 6

| Fixture | Status | Detail |
|---|---:|---|
| compare action resolves attached source and emits read-only guidance | PASS | ok |
| helper requires exact claim id and exact attached source handle | PASS | ok |
| unresolved source returns bounded guidance without comparison | PASS | ok |
| low-overlap source blocks promotion guidance | PASS | ok |
| command rejects mutation, promotion, consumption, and injection flags | PASS | ok |
| command reports inert default when ClaimStore is unavailable | PASS | ok |
