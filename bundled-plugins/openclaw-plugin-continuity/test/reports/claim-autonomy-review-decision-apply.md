# Claim Autonomy Review Decision Apply Test Report

- PASS: 6
- FAIL: 0
- Total: 6

| Fixture | Status | Detail |
|---|---:|---|
| dry-run renders exact approval string and does not mutate | PASS | ok |
| low-risk apply proceeds autonomously without operator approval | PASS | ok |
| apply archive_open_question writes before and after receipts only for exact payload | PASS | ok |
| rollback_review_decision restores from before receipt and appends rollback receipt | PASS | ok |
| hold_as_hypothesis keeps claim non-active and candidate-only | PASS | ok |
| active claims are refused even with exact approval | PASS | ok |
