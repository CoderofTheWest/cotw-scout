# Continuity Claims Invocation Policy Test Report

- PASS: 20
- FAIL: 0
- Total: 20

| Fixture | Status | Detail |
|---|---:|---|
| continuity_claims is manifest-declared and runtime-registered by the continuity plugin | PASS | ok |
| continuity_claims registration is non-optional once plugin tools are admitted | PASS | ok |
| OpenClaw plugin exposure has a manifest/catalog availability layer | PASS | ok |
| OpenClaw plugin exposure admits plugin tools only through tool allowlist semantics when narrowed | PASS | ok |
| per-turn agent runtime applies final toolsAllow filtering after tool assembly | PASS | ok |
| per-turn toolsAllow is bridged into plugin tool resolution as runtimeToolAllowlist | PASS | ok |
| agent profile alsoAllow participates in plugin tool descriptor resolution | PASS | ok |
| Gateway tools.invoke resolver admits plugin tools through alsoAllow descriptor resolution | PASS | ok |
| agent tools alsoAllow survives final Codex app-server toolsAllow filtering | PASS | ok |
| tools.effective preloads standalone plugin registry before computing effective inventory | PASS | ok |
| plugin tool resolution preserves specific allowlist entries when wildcard policy is also present | PASS | ok |
| continuity_claims can be admitted by an exact per-turn toolsAllow entry without broad plugin group grants | PASS | ok |
| continuity claims diagnostics command is an explicit read-only workflow | PASS | ok |
| continuity claims diagnostics exposes a direct operator proof path | PASS | ok |
| continuity claim fixture seed is explicit and dry-run-first | PASS | ok |
| continuity claim review decision command is explicit and dry-run-first | PASS | ok |
| continuity claim review gateway method returns bounded operator failures instead of transport errors | PASS | ok |
| continuity claim source resolution is explicit read-only operator surface | PASS | ok |
| continuity claim source verification helper is explicit and read-only | PASS | ok |
| invocation availability failure is policy/exposure, not missing continuity tool registration | PASS | ok |
