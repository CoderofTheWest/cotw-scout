# Runtime Retention and Archival Audit - 2026-05-22

## Executive Read

The recent Stop-button and spine-ledger fixes address the immediate hot-path symptoms, but they do not by themselves give COTW a complete retention architecture.

The system now has several strong local protections:

- the visible reply stream no longer waits up to 60 seconds for post-response compaction before clearing the Stop state;
- the hot spine ledger compacts bounded collections into `ledger.archive.jsonl`;
- Metabolism caps pending candidate files and clears old processed files;
- Runtime Load reads only a bounded tail of the metrics JSONL;
- Harness Refiner exports redacted research bundles with a manifest and training approval disabled by default.

The remaining issue is architectural: retention is enforced piecemeal by each subsystem. There is no shared registry that says which runtime artifacts are hot, warm, cold, archival, training-eligible, source-separated, or safe to inject back into live context.

## Current Evidence

Local runtime file-size scan on 2026-05-22 found the largest active surfaces under the Trail Guide and OpenClaw runtime roots:

| Surface | Example size | Observed path shape | Current risk |
| --- | ---: | --- | --- |
| Gateway stdout log | 37.3 MB | `~/.openclaw-cotw/logs/gateway.log` | Unbounded log growth can slow diagnostics and inflate backups. |
| Spine archive | 31.3 MB | `<workspace>/spine/ledger.archive.jsonl` | Hot ledger is bounded, but archive retention is not governed. |
| Session index | 17.9 MB | `~/.openclaw-cotw/agents/trail-guide/sessions/sessions.json` | Session metadata can become a large startup/read surface. |
| Session JSONL files | 13.2 MB each observed | `~/.openclaw-cotw/agents/trail-guide/sessions/*.jsonl` | Individual transcripts remain durable but lack lifecycle tiers. |
| Checkpoint JSONL files | 12.8 MB each observed | `*.checkpoint.*.jsonl` | Checkpoints can accumulate beside full sessions. |
| Trajectory JSONL files | 10.5 MB each observed | `*.trajectory.jsonl` | Valuable research data, but not classified by retention/export policy. |
| Training/model artifacts | 11.4 MB tokenizer files repeated | `<workspace>/projects/cotw-scaffold-tuning/models/**` | Legitimate project artifacts, but should be excluded from runtime hot audits. |

This is not catastrophic. It is exactly the shape of a real research runtime starting to grow up: enough receipts and trajectories exist that storage policy now matters.

## Data Planes Found

### 1. Hot GUI and stream plane

Main surfaces:

- Electron conversation state and config session pointers;
- `electron-stream-debug.jsonl`;
- visible reply finalization and compaction completion;
- runtime metrics JSONL via `OPENCLAW_RUNTIME_METRICS_PATH` / `COTW_RUNTIME_METRICS_PATH`.

Current state:

- The Stop-button hang was caused by visible stream completion being coupled to slower post-response compaction/lifecycle work.
- The shipped fix caps visible finalization waiting and lets background runtime work finish without holding the composer busy.
- Runtime Load reports tail-read metrics only, which protects the UI read path.

Remaining gap:

- Metrics and stream debug files are append-only without a shared rotation policy.
- The GUI does not yet expose retention health as a first-class diagnostic.

### 2. Session and trajectory plane

Main surfaces:

- `sessions.json`;
- session `.jsonl` transcripts;
- session checkpoint `.jsonl` files;
- `.trajectory.jsonl` files;
- Continuity DB session metadata.

Current state:

- `main.js` tracks `currentSessionJsonlFile` to avoid reloading stale history after restarts.
- Session listing is capped in SQL queries for the GUI.
- Loading historical sessions still reads transcript files from disk.

Remaining gap:

- Session index, transcript, checkpoint, and trajectory files do not share a lifecycle.
- There is no canonical rule for when a trajectory remains hot, moves to research warm storage, or becomes cold archive.

### 3. Spine, evolution, and authority plane

Main surfaces:

- `<workspace>/spine/ledger.json`;
- `<workspace>/spine/ledger.archive.jsonl`;
- evolution ledger receipts;
- action gate and protected authority receipts.

Current state:

- `lib/spine-ledger.js` now compacts hot collections before writing.
- Archived packets keep collection identity and packet payload.
- Evolution receipts support proposal/review/rollback lanes.

Remaining gap:

- The archive is append-only but has no retention manifest, compaction summary, restore index, or cold-storage policy.
- There is no unified retention health signal saying "the hot ledger is healthy but the archive is now X MB."

### 4. Metabolism and cognitive plane

Main surfaces:

- Metabolism pending and processed candidate files;
- growth vector candidate storage;
- cognitive state and entropy/surprise signals;
- research entropy or cognitive diagnostic JSONL files.

Current state:

- Pending metabolism candidates are capped by `maxPendingCandidates`.
- Processed candidates are cleaned at session end.
- Cognitive-layer signals are useful as diagnostic inputs, not memory themselves.

Remaining gap:

- Cognitive observations need a declared retention class. They should feed Stability, Metabolism, and Refiner scoring, but should not silently become trusted memory.
- Research-significant events should be exportable with provenance and source labels.

### 5. Harness Refiner and research platform plane

Main surfaces:

- `openclaw-plugin-harness-refiner/data/windows.jsonl`;
- `analysis/windows.jsonl`;
- `analysis/proposals.jsonl`;
- `analysis/scores.jsonl`;
- `analysis/relabel-candidates.jsonl`;
- `analysis/teacher-relabels.jsonl`;
- `research/research-ledger.jsonl`;
- `research-bundles/<id>/manifest.json`.

Current state:

- Harness Refiner is correctly proposal-only for protected state.
- Teacher relabel receipts explicitly disable training launch and adapter promotion.
- Bundle export redacts risky fields and writes a manifest with `trainingApproval: false`.

Remaining gap:

- Analysis and research JSONLs are append-only.
- Bundle manifests do not yet reference a global retention registry or artifact lifecycle state.
- There is no one-screen digest of "what data is suitable for post-training dataset generation."

### 6. Imported archive and live telemetry separation

Main surfaces:

- imported memory archives;
- offline cognitive analysis outputs;
- live runtime telemetry;
- trusted prompt context.

Current state:

- Prior archive-import work established the right boundary: imported historical material must preserve provenance and remain separate from live firsthand telemetry.

Remaining gap:

- A retention layer must encode this as policy, not just convention. Cold archive data can be searchable and research-useful without becoming live memory or prompt context.

## Findings

### Finding 1 - Immediate UI hang was fixed, but lifecycle work still needs governance

The Stop-button issue was a hot-path coupling bug. It was appropriate to fix that with a bounded visible-finalization wait.

That fix is not a band-aid for storage. It removes the user-facing stall. The storage layer still needs an intentional retention design so future diagnostics, research data, and archives do not accumulate in surprising places.

### Finding 2 - The system already has the primitives for a research platform

COTW now has:

- source-addressed sessions;
- trajectory windows;
- cognitive/surprise signals;
- runtime load metrics;
- harness proposals;
- PRM-style scores;
- teacher relabel receipts;
- redacted bundle exports;
- evolution receipts and rollback posture.

The missing product layer is a digestible control plane that tells a developer what is hot, what is archival, what is research-grade, what is training-eligible, and what is never eligible for prompt injection.

### Finding 3 - Retention must be source-aware, not just size-aware

A pure "delete old logs" job would be brittle. Some old windows are valuable training data; some recent logs are noisy; some imported archive rows are searchable but must remain provenance-labeled; some cognitive observations should expire quickly unless selected as research-significant.

The correct unit is an artifact class with owner, source type, sensitivity, lifecycle, retention budget, compaction strategy, export policy, and restore policy.

### Finding 4 - The live runtime should never do heavy retention work mid-turn

Retention tasks should run:

- manually;
- during Nightshift;
- after session end;
- or in a low-priority worker.

They should not run before visible response finalization, while the Stop state is active, or inside an unbounded hook path.

## Recommended Direction

Build a Runtime Retention and Research Archive layer with three jobs:

1. **Audit**: enumerate known artifact classes, sizes, ages, counts, source labels, and lifecycle state.
2. **Apply**: rotate, summarize, archive, or prune only through artifact-specific policies.
3. **Export**: produce research and post-training bundles with manifest, hashes, redaction, source separation, and explicit approval state.

The first shippable slice should be read-only audit plus a registry. The second slice can apply low-risk rotations for logs and derived artifacts. Research and training export should remain manifest-only until the diagnostics are boring.

