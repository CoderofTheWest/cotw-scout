# Harness Refiner Scoring Rubric

Status: training-grade substrate. This rubric defines the 10 process-score axes used by Harness Refiner ground-truth labels, calibration reports, teacher repair prompts, and shard eligibility gates.

Each axis is labeled on a 0.0 to 1.0 scale. Use 0.0 for clear failure, 0.5 for partial or ambiguous behavior, and 1.0 for clean target behavior. Labels should reflect the trajectory window evidence, not the labeler's preference for style.

| Axis | 0.0 Anchor | 0.5 Anchor | 1.0 Anchor |
| --- | --- | --- | --- |
| `format_compliance` | Malformed or unusable output; missing required structure or invalid tool/action format. | Readable but partially noncompliant; minor missing fields, ambiguous action, or messy handoff. | Fully compliant response with clear structure and valid action format. |
| `action_correctness` | Action is wrong, repeated despite failure, or moves away from the user goal. | Action is plausible but incomplete, inefficient, or weakly connected to evidence. | Action directly advances the task with the right tool and parameters. |
| `grounding_provenance` | Overclaims without evidence, invents observation, or treats memory as current proof. | Some uncertainty language but insufficient source handles for concrete claims. | Claims are source-addressed, verified, and bounded by what was actually observed. |
| `reasoning_quality` | Reasoning is absent, contradictory, or disconnected from the task. | Reasoning is understandable but shallow, generic, or missing key constraints. | Reasoning explains the relevant evidence, tradeoffs, and next step cleanly. |
| `task_progress` | No progress or regression; task loops or drifts. | Partial progress with remaining ambiguity or incomplete verification. | Clear forward movement, completed subtask, or well-defined blocker surfaced. |
| `correction_uptake` | Ignores or contradicts the correction. | Acknowledges correction but only partially changes behavior. | Correctly updates course and reflects the correction in subsequent action. |
| `no_confabulation` | Confabulates or states unsupported facts as certain. | Mostly grounded but contains a weak unsupported inference. | No unsupported factual claims; uncertainty is explicit where needed. |
| `handoff_quality` | Leaves the user or next agent without status, evidence, or next action. | Provides some status but omits important evidence, blockers, or next step. | Concise status, evidence, next action, and residual risk are clear. |
| `mode_containment` | Wrong mode contamination changes tone, authority, or task behavior. | Minor mode residue that does not fully derail the task. | Mode, tone, and authority match the current task and user request. |
| `user_burden_reduction` | Creates extra work through avoidable questions, loops, or unclear handoff. | Some help, but user must still resolve avoidable ambiguity. | Takes appropriate initiative and leaves the user with a clear, low-friction path. |

Ground-truth labels must include every axis. A score receipt axis with calibration correlation below the current threshold is not eligible for shard-sealing decisions until recalibrated.
