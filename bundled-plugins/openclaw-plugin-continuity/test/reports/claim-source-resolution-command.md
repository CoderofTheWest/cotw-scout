# Claim Source Resolution Command Test Report

- PASS: 9
- FAIL: 0
- Total: 9

| Fixture | Status | Detail |
|---|---:|---|
| claim action resolves exact claim sources and keeps operator boundaries | PASS | ok |
| claim action returns bounded output for missing claim without resolving | PASS | ok |
| handle action resolves one handle and lists linked claims | PASS | ok |
| default resolver wires SummaryStore for digest-backed source handles | PASS | ok |
| unresolved source handles stay bounded and do not throw transport errors | PASS | ok |
| command rejects mutation, promotion, consumption, and injection flags | PASS | ok |
| parser requires exact claim id or source handle | PASS | ok |
| content is bounded by max-content-chars | PASS | ok |
| command reports inert default when ClaimStore is unavailable | PASS | ok |
