# Record Mode Proof Plan Test Report

- PASS: 13
- FAIL: 0
- Total: 13

| Fixture | Status | Detail |
|---|---:|---|
| proof plan creates narrow handoff record-mode config and rollback | PASS | ok |
| proof plan supports exactly one selected candidate source | PASS | ok |
| proof validator rejects prompt injection and disabled persistence | PASS | ok |
| proof validator rejects broad candidate-source enablement | PASS | ok |
| rollback validator rejects any persistence or source generation left enabled | PASS | ok |
| markdown renderer emits dry-run checklist without applying anything | PASS | ok |
| json renderer emits machine-readable dry-run boundaries | PASS | ok |
| unsupported proof source fails before plan creation | PASS | ok |
| renderer rejects unsupported output formats | PASS | ok |
| dry-run script renders markdown without runtime actions | PASS | ok |
| dry-run script renders json and rejects unsupported options | PASS | ok |
| dry-run script is included in packaged plugin files | PASS | ok |
| npm package dry-run includes executable proof-plan script | PASS | ok |
