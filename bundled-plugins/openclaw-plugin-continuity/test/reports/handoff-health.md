# Handoff Health Test Report

- PASS: 8
- FAIL: 0
- Total: 8

| Fixture | Status | Classification |
|---|---:|---|
| absent handoff is ignored | PASS | absent / ignore / inject=false |
| fresh matching handoff is authoritative | PASS | fresh / authoritative / inject=true |
| fresh runtime claim without source handles requires verification | PASS | fresh / supporting / inject=true |
| stale same-thread handoff is non-authoritative | PASS | stale / non_authoritative / inject=false |
| cross-thread handoff is orphaned/non-authoritative | PASS | orphaned / non_authoritative / inject=false |
| stale previous-session handoff requires suspect handling and verification | PASS | stale / non_authoritative / inject=false |
| consumed handoff is ignored | PASS | consumed / ignore / inject=false |
| unparseable timestamp is quarantined as orphaned | PASS | orphaned / non_authoritative / inject=false |
