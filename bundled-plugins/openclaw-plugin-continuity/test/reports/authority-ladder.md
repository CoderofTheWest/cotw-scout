# Authority Ladder Test Report

- PASS: 5
- FAIL: 0
- Total: 5

| Fixture | Status | Decision | Winner | Verification |
|---|---:|---|---|---:|
| current user correction supersedes archive | PASS | use | current-night (current_user_correction:late night) | false |
| live config beats stale handoff runtime claim | PASS | use | config-duckduckgo (live_config:DuckDuckGo) | false |
| unsourced digest claim requires verification before answer | PASS | verify_first | digest-pushed (digest:yes) | true |
| verified runtime check beats unsourced digest | PASS | use | git-not-pushed (live_runtime:no) | false |
| superseded archive claim is rejected | PASS | use | new-claim (current_user_correction:zed) | false |
