# Continuity Claims Tool Test Report

- PASS: 25
- FAIL: 0
- Total: 25

| Fixture | Status | Detail |
|---|---:|---|
| tool reports unavailable when ClaimStore is not initialized | PASS | ok |
| tool rejects invalid status and kind filters before storage lookup | PASS | ok |
| tool rejects invalid numeric filters before storage lookup | PASS | ok |
| tool rejects unsupported actions before storage lookup | PASS | ok |
| get action returns claim diagnostics without source excerpts by default | PASS | ok |
| source excerpts are opt-in and no resolver is called | PASS | ok |
| verify action returns only claims requiring verification | PASS | ok |
| source action requires source_handle and filters by source handle | PASS | ok |
| stats action is read-only and compact | PASS | ok |
| context action renders safe read-only packet with source handles and no excerpts by default | PASS | ok |
| context_audit action renders redacted operator audit without claim text or source handles | PASS | ok |
| trial_plan action renders redacted manual trial decision without consuming context | PASS | ok |
| verification_plan action renders redacted verification steps without promoting claims | PASS | ok |
| preflight action renders redacted bundled operator receipt | PASS | ok |
| manual_review action blocks unsafe packets without leaking review content | PASS | ok |
| manual_review action prepares clean review packet without injection | PASS | ok |
| research action renders ClaimStore-backed candidate report without active claim noise | PASS | ok |
| research action is read-only and keeps source resolution off by default | PASS | ok |
| research action handles empty stores cleanly | PASS | ok |
| autonomy_review action renders dry-run policy receipts without mutation | PASS | ok |
| apply_review_decision dry-run renders exact gated payload without mutation | PASS | ok |
| apply_review_decision autonomously applies low-risk action without exact operator approval | PASS | ok |
| apply_review_decision applies exactly one archived-open-question mutation with receipts | PASS | ok |
| rollback_review_decision restores one prior autonomous apply receipt | PASS | ok |
| context action includes source excerpts only by explicit opt-in | PASS | ok |
