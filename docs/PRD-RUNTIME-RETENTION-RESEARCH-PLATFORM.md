# PRD: Runtime Retention and Research Platform Layer

Status: proposed. This PRD defines the retention and archival layer needed to keep COTW responsive while preserving research-grade evidence for harness refinement and future post-training work. No autonomous training launch, adapter promotion, prompt rewrite, or trusted-memory promotion is implied by this document.

Related artifact: `docs/AUDIT-RUNTIME-RETENTION-ARCHIVAL-2026-05-22.md`.

## Primitive 1: Core Objective

Ship a unified Runtime Retention and Research Platform layer that keeps the live COTW runtime bounded, explainable, and fast while preserving source-addressed trajectory evidence for harness refinement, diagnostics, and future post-training dataset generation.

The platform must make runtime data easy to understand:

- what is hot and can affect the current session;
- what is warm and available for recent diagnostics;
- what is cold archive and never injected by default;
- what is research-grade evidence;
- what is eligible for human-reviewed training export;
- what must remain provenance-labeled because it came from imported history, not live experience.

## Primitive 2: Functional Requirements

### Artifact Registry

- [ ] Add a central registry of runtime artifact classes.
- [ ] Each artifact class declares owner, path glob, source type, sensitivity, hot budget, warm budget, cold/archive strategy, compaction strategy, export policy, and restore policy.
- [ ] Registry entries cover at minimum gateway logs, stream debug logs, runtime metrics, session transcripts, session checkpoints, trajectory files, spine ledger, spine archive, evolution ledgers, metabolism candidates, cognitive observations, Harness Refiner analysis files, teacher relabels, research ledgers, and research bundles.
- [ ] Registry entries distinguish live telemetry, imported archive material, derived summaries, cognitive observations, and training candidates.
- [ ] Registry entries declare whether an artifact can ever be injected into live context. Default is `false`.

### Read-Only Retention Audit

- [ ] Add a script or module that scans registered artifact classes and reports count, total bytes, largest files, newest/oldest timestamps, current lifecycle tier, and policy violations.
- [ ] Audit mode must be read-only.
- [ ] Audit output must be available as JSON for tests and UI.
- [ ] Audit output must be human-readable from the CLI.
- [ ] Audit must separate runtime files from project/model artifacts so training model files do not pollute hot-runtime health.

### Lifecycle Tiers

- [ ] Implement the following tiers:

| Tier | Meaning | Injection default | Typical examples |
| --- | --- | --- | --- |
| Hot | Required for current or recent live behavior | Only if explicitly trusted by subsystem | current session state, hot spine ledger, pending candidate queue |
| Warm | Recent diagnostics and review | No | recent trajectories, runtime metrics tail, refiner analysis |
| Cold | Archived evidence | No | old sessions, old checkpoints, old logs, spine archive chunks |
| Research Export | Redacted curated bundle | No | relabel packets, score receipts, digest clusters |
| Training Candidate | Human-reviewed shard candidate | No direct runtime injection | repaired windows, preferred turns, post-training fixtures |

### Safe Apply Mode

- [ ] Add an operator-invoked retention apply mode after read-only audit ships.
- [ ] Apply mode only acts on registry-owned artifact classes.
- [ ] Apply mode performs atomic writes or append-only archive moves.
- [ ] Apply mode writes a retention receipt with before/after size, file count, policy applied, skipped files, and rollback path.
- [ ] Apply mode must refuse to run while a visible stream is active.
- [ ] Apply mode must refuse to run in protected source/template directories unless the artifact class explicitly allows it.

### Research Platform Digest

- [ ] Add a digest view that answers: "What research data do we have and what is it good for?"
- [ ] Digest groups artifacts into rollout diagnostics, PRM/process scores, failure signatures, teacher relabels, harness proposals, cognitive-surprise events, and training candidates.
- [ ] Digest includes counts, hashes, source labels, redaction state, and approval state.
- [ ] Digest explicitly marks `trainingApproval: false` unless a human-reviewed approval receipt exists.
- [ ] Digest can be exported as a manifest without copying raw data.

### Cognitive Layer Handling

- [ ] Treat cognitive-layer outputs as observations, not memory.
- [ ] The registry must include cognitive observation files and classify them as diagnostic/research signals.
- [ ] Cognitive surprise and entropy can feed Stability loop detection, Metabolism candidate selection, and Harness Refiner scoring.
- [ ] Cognitive observations cannot become trusted prompt context unless a separate review path creates a source-addressed accepted claim.
- [ ] Research export can include cognitive features only with redaction and feature-level schema metadata.

### Post-Training Future-Proofing

- [ ] Retention receipts and research manifests must include model/checkpoint/adapter hash fields when available.
- [ ] Training-candidate manifests must include original student response, process scores, teacher repair, source window id, redaction policy, shard id, and inclusion decision.
- [ ] Dataset generation must be possible without launching training.
- [ ] Training launch and adapter promotion remain out of scope and require separate approval lanes.

### GUI Integration

- [ ] Add a Retention Health panel in the existing diagnostic/workbench area.
- [ ] Panel shows top oversized artifact classes, hot/warm/cold totals, recent policy violations, and last audit time.
- [ ] Panel links to Research Platform digest.
- [ ] Panel provides read-only "Copy audit summary" and "Open manifest" actions before any apply controls ship.
- [ ] Any apply action requires explicit user confirmation and produces a visible receipt.

## Primitive 3: Technical Constraints

| Constraint | Value | Rationale |
| --- | --- | --- |
| Runtime | Existing Electron main process and OpenClaw plugin runtime | Avoid a new service for v1. |
| Registry format | Versioned JavaScript or JSON policy module | Testable, portable to Scout, easy to inspect. |
| Writes | Atomic JSON writes, append-only JSONL receipts, file moves where safe | Avoid corrupting evidence. |
| Hook posture | No heavy retention work inside live response hooks | Prevent Stop-button and beachball regressions. |
| Source separation | Live telemetry, imported archive, and generated research bundles remain distinct | Preserve honesty and prevent context contamination. |
| Training | Dataset export only | Training launch and adapter promotion require a later PRD. |
| Public repo | Scout carries the public/developer-facing version of this layer | Scout is the clean public source path for developer builds. |

## Primitive 4: User Journeys

### Journey 1: Chris Checks Why the App Feels Heavy

1. Chris opens Retention Health.
2. The app shows gateway logs, session index, trajectory files, and spine archive as the largest artifact classes.
3. Chris sees which items are hot, warm, and cold.
4. The panel makes clear whether any item affects live response latency.
5. Chris can export a read-only audit summary for Wren or another developer.

### Journey 2: The System Prepares Research Data Without Training

1. Harness Refiner records trajectory windows, scores, proposals, and relabel candidates.
2. Teacher repairs are written as relabel receipts.
3. Research Platform Digest groups the evidence by experiment, failure signature, and approval state.
4. Chris exports a manifest showing what could become a training shard.
5. The manifest states that training approval is false and no adapter promotion occurred.

### Journey 3: Nightshift Runs Safe Retention

1. Nightshift runs a read-only retention audit.
2. It detects oversized append-only logs and stale derived artifacts.
3. It writes a summary receipt.
4. If apply mode is enabled, it rotates only low-risk registered artifacts.
5. It never mutates current session state or trusted memory.

### Journey 4: Imported Archive Data Stays Honest

1. An old imported archive remains searchable for research.
2. Retention audit classifies it as imported archive material.
3. The digest can include it as source-labeled evidence.
4. It is not treated as firsthand live telemetry.
5. It is not injected into the prompt unless a separate accepted-claim path approves a specific source-addressed claim.

## Primitive 5: Verification Criteria

### Automated Verification

- [ ] Registry unit test: every known artifact class has owner, source type, lifecycle policy, and injection eligibility.
- [ ] Audit fixture test: oversized JSONL, JSON, SQLite, and directory fixtures produce correct byte/count summaries.
- [ ] Source-separation test: imported archive fixtures are reported separately from live telemetry.
- [ ] Hot-path test: retention audit and apply cannot run while visible stream state is active.
- [ ] Apply dry-run test: read-only audit never writes files.
- [ ] Apply receipt test: low-risk rotation writes before/after receipt and preserves rollback path.
- [ ] Research manifest test: exported digest includes hashes, redaction state, source labels, and `trainingApproval: false`.
- [ ] Cognitive layer test: cognitive observations are classified as diagnostic/research signals and not trusted memory.

### Manual Verification

- [ ] Run audit against a live local runtime and confirm largest surfaces match disk inspection.
- [ ] Confirm Retention Health renders without loading whole JSONL logs into the GUI.
- [ ] Confirm the current session still resumes after old trajectories/checkpoints are archived.
- [ ] Confirm Evolve and Harness Refiner still find recent proposal receipts after retention runs.
- [ ] Confirm no cold archive material appears in live prompt context by default.

## First Build Slice

1. Add `lib/runtime-retention-registry.js` with artifact class definitions.
2. Add `scripts/runtime-retention-audit.js` read-only CLI.
3. Add tests with temp runtime fixtures.
4. Add a Workbench/diagnostics read-only Retention Health view.
5. Add Research Platform Digest manifest generation using existing Harness Refiner artifacts.

No destructive retention apply should ship until the read-only audit is boring across companion and Scout.

## Second Build Slice

1. Add low-risk apply mode for gateway logs, stream debug logs, runtime metrics, and derived analysis JSONLs.
2. Add retention receipts.
3. Add Nightshift audit scheduling.
4. Add cold archive chunk manifests for spine archive and trajectories.
5. Add restore/read-range helpers for archived transcripts.

## Explicit Non-Goals

- No autonomous recursive self-learning.
- No model post-training launch.
- No adapter promotion.
- No unreviewed prompt/scaffold rewrite.
- No deletion of source-addressed evidence without a receipt.
- No collapse of imported archive memory into live firsthand memory.

## Open Questions

- Should cold archives be compressed in v1, or should v1 prioritize plain JSONL plus manifests for debuggability?
- Should session `sessions.json` be replaced by a SQLite or paged index, or only compacted after the retention layer exists?
- Which GUI surface owns Retention Health: Settings, Workbench, Evolve, or a dedicated Research tab?
- How much of the public Scout repo should expose research-platform internals versus developer-safe diagnostics only?

## References

- `docs/AUDIT-RUNTIME-RETENTION-ARCHIVAL-2026-05-22.md`
- `lib/spine-ledger.js`
- `lib/runtime-load-report.js`
- `bundled-plugins/lib/runtime-metrics.js`
- `bundled-plugins/openclaw-plugin-metabolism/lib/candidateStore.js`
- `bundled-plugins/openclaw-plugin-harness-refiner/`
- `docs/PRD-CODE-EVOLUTION-CLOSED-LOOP.md`
