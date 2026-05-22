# Claim Candidates Test Report

- PASS: 10
- FAIL: 0
- Total: 10

| Fixture | Status | Detail |
|---|---:|---|
| default config does not generate or persist candidates | PASS | ok |
| candidate generation requires explicit per-source flags | PASS | ok |
| record persistence remains separately gated | PASS | ok |
| handoff candidate generation creates sourced summary and open-thread claims | PASS | ok |
| handoff candidate generation skips queued-message and working-memory wrapper noise | PASS | ok |
| summary candidates remain verify-required when source handles are absent | PASS | ok |
| summary candidates preserve supplied source handles | PASS | ok |
| digest candidates reuse Build 2 digest claim primitive | PASS | ok |
| createClaimCandidates aggregates enabled sources but still observe-only | PASS | ok |
| markdown section parser preserves line numbers for source handles | PASS | ok |
