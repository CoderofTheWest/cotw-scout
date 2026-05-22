# Claim Review Decision Test Report

- PASS: 8
- FAIL: 0
- Total: 8

| Fixture | Status | Detail |
|---|---:|---|
| dry-run verify records no mutation and does not promote unsafe claims | PASS | ok |
| apply verify updates lastVerifiedAt but preserves staleness policy | PASS | ok |
| dry-run accept_verified plans activation without mutation | PASS | ok |
| apply accept_verified activates claim with explicit policy and verification source | PASS | ok |
| accept_verified requires source evidence and explicit usable staleness policy | PASS | ok |
| apply retract normalizes persisted ClaimStore sources before writing | PASS | ok |
| apply supersede marks old claim superseded and records edge when replacement is named | PASS | ok |
| review decisions require explicit evidence boundaries for verify/supersede | PASS | ok |
