# Source Addressable Init Test Report

- PASS: 11
- FAIL: 0
- Total: 11

| Fixture | Status | Detail |
|---|---:|---|
| default source-addressable memory config remains runtime-disabled | PASS | ok |
| plugin schema exposes sourceAddressableMemory without enabling it | PASS | ok |
| plugin manifest exposes source-addressable memory and Build 1 runtime config keys | PASS | ok |
| manifest contracts expose registered continuity tools including read-only claim diagnostics | PASS | ok |
| ClaimStore is gated behind explicit enablement and non-off mode | PASS | ok |
| observe init logs stats only and does not create claims or inject prompts | PASS | ok |
| candidate observe wiring is explicitly enabled and logs counts plus persistence outcomes | PASS | ok |
| Build 3 claim context defaults remain diagnostic-only and non-injecting | PASS | ok |
| Build 3 runtime preview wiring is observe-only and non-injecting | PASS | ok |
| Build 5 claim context injection is gated behind explicit live minimal config and injection-ready preview | PASS | ok |
| candidate persistence path is helper-gated and does not inject prompt context | PASS | ok |
