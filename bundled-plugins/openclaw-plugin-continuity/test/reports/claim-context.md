# Claim Context Test Report

- PASS: 15
- FAIL: 0
- Total: 15

| Fixture | Status | Detail |
|---|---:|---|
| context packet is read-only and not injection-ready by default | PASS | ok |
| packet preserves verification requirements instead of upgrading claims to truth | PASS | ok |
| retracted, stale, and do-not-use claims are excluded from usable context | PASS | ok |
| candidate-only handoff claims are excluded from usable context | PASS | ok |
| fixture-only claims are excluded unless explicitly requested | PASS | ok |
| source handles are preserved but excerpts stay hidden by default | PASS | ok |
| source excerpts are opt-in at packet and render layers | PASS | ok |
| packet limit is bounded and reports omitted included claims | PASS | ok |
| ranking prefers usable active high-confidence claims before verify-required pointers | PASS | ok |
| diversity caps prevent non-candidate handoff-derived cluster from filling preview packet | PASS | ok |
| packet includes redacted operator audit without claim text or source handles | PASS | ok |
| quality assessment marks all-verification previews as review-required | PASS | ok |
| quality assessment remains redacted and diagnostic only | PASS | ok |
| readiness guidance explains empty previews without claim details | PASS | ok |
| classifier treats missing diagnostics and do-not-use as excluded | PASS | ok |
