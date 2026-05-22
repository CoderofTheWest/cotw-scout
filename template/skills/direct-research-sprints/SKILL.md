---
name: direct-research-sprints
description: Run bounded direct research sprint loops for open-ended discovery, algorithm experiments, scientific investigation, or overnight lab-bench work. Use when the user wants the agent to personally investigate, experiment, iterate, produce receipts, avoid delegation drift, manage compute/tool-wall risk, or repeat the Dynamic Plasticity Challenge style of work.
---

# Direct Research Sprints

Use this skill when the work requires discovery through repeated contact with evidence, not just planning or delegation.

## Core posture

Own the creative loop directly.

Sub-agents may gather references, run independent replication, or do bounded chores, but the main research agent must perform the hypothesis → experiment → result → interpretation → next move loop.

Do not treat the laptop as a task queue. Treat it as a lab bench.

## Before committing

Verify feasibility before promising a sprint count.

Check:

- current session/runtime status if available;
- context pressure and likely compaction/tool-wall risk;
- available compute/time budget if known;
- local dependencies needed for experiments;
- whether the problem has objective verification criteria.

Define what counts as a completed sprint before scheduling or starting.

A completed sprint must leave a receipt with:

1. sprint question;
2. inspected or changed artifact;
3. experiment run, analysis run, or explicit blocker;
4. interpretation;
5. next move.

If the sprint only talks, plans, or delegates, it does not count.

## Project scaffold

Create or update a project directory with these files when absent:

```text
PROJECT-README.md or README.md
DIRECT-RESEARCH-PROTOCOL.md
RESEARCH-POSTURE.md
SPRINT-PLAN.md
notes/run-log.md
notes/hypothesis-ledger.md
sprints/SPRINT-STATE.json
sprints/sprint-XX.md
reports/
```

Keep all important state in files, not chat memory.

## Sprint loop

For each sprint:

1. Read the previous sprint receipt and current state.
2. Name one sharp question.
3. Form one hunch from evidence, not vibes.
4. Make the smallest code/data/analysis change that tests it.
5. Run a bounded local experiment or inspection.
6. Read the actual output.
7. Write the sprint receipt before continuing.
8. Update `sprints/SPRINT-STATE.json`.

Prefer local experiments, scripts, plots, tables, diffs, and direct artifact inspection over long speculative prose.

## Hardening pattern from Dynamic Plasticity

For long loops or runs likely to survive compaction/tool walls, strengthen the default sprint loop:

- Write a phase plan before experiments: research question, sprint budget, allowed work, forbidden extensions, stop conditions, baseline/collision plan, and claim boundary.
- Pre-register each sprint receipt: what result would confirm the hunch, what would disconfirm it, and how the claim changes either way.
- Record reproducibility metadata for experiment sprints: entry command/script, config, seeds/sample count, output directory, and primary artifacts.
- Checkpoint every 2–3 sprints with latest completed sprint, current best claim, strongest counterevidence, changed files, and recovery instructions.
- Bring strong cheap baselines/collision checks early enough to shape the claim, not only at the end.
- Run an explicit critic pass before final synthesis: try to kill or narrow the claim, then preserve the narrowing.

These additions should harden the loop without turning it into ceremony. If the hardening work produces more paperwork than evidence, simplify it.

## Compute and tool-wall discipline

Use bounded cycles, not indefinite autonomous burn.

Good burn:

- produces code changes;
- produces experiment results;
- narrows hypotheses;
- falsifies a candidate;
- improves the benchmark;
- leaves reproducible receipts.

Bad burn:

- keeps reasoning without touching artifacts;
- delegates the creative core;
- repeats broad searches after enough inventory exists;
- runs long jobs without a clear readout;
- produces polished claims without verification.

If two consecutive sprints produce no new artifact, result, or narrowed blocker, stop and write a blocker report.

Mitigate handoff failures by writing receipts during the work, not only at the end. If the visible chat handoff breaks, recover from files.

## Claim discipline

Be ambitious in search and conservative in claims.

Every result must state:

- exact benchmark/config/data condition;
- baselines compared;
- seed count or sample count;
- metric definition;
- what is supported;
- what is not supported;
- next validation gate.

Do not claim novelty, breakthrough, deployment readiness, or generality without stronger external validation.

## Final synthesis

At the end of a run, write a synthesis report covering:

- best supported result;
- failures and what they taught;
- whether any improvement is real, and under what boundary;
- compute discipline and failure points;
- next experiments in priority order;
- clean claim boundary for sharing.

Also write or update an agent-facing handoff if the work may be shared with other agents.

## Sharing results

When asked to share research externally or into a shared repo:

1. Sanitize private workspace/persona/session details.
2. Add a clear `AGENT-HANDOFF.md` entrypoint.
3. Include receipts, scripts, result artifacts, and synthesis.
4. Make the top-level navigation obvious.
5. Prefer the simplest Git flow the user expects; do not introduce PR ceremony unless useful or requested.

## Stop conditions

Stop and report instead of continuing if:

- objective verification is missing;
- local dependencies block progress;
- experiments become too expensive for the agreed budget;
- results are not reproducible enough to interpret;
- the next step requires external access, paid compute, or user permission;
- the work has become claim-making instead of evidence-making.
