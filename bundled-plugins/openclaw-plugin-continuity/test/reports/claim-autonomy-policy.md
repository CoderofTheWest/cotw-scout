# claim-autonomy-policy test report

Passed: 36/36

- PASS agent_maturation_auto_accept_restart_key follows expected lane/decision
- PASS agent_maturation_auto_accept_search_before_create follows expected lane/decision
- PASS project_factual_auto_accept_artifact_path follows expected lane/decision
- PASS project_factual_auto_accept_first_slice_target follows expected lane/decision
- PASS sensitive_escalation_chris_values follows expected lane/decision
- PASS procedural_wording_sensitive_user_posture follows expected lane/decision
- PASS sensitive_emotional_interpretation follows expected lane/decision
- PASS authority_expansion_gateway_restart follows expected lane/decision
- PASS authority_expansion_memory_trust follows expected lane/decision
- PASS reject_broad_summary_safe_autonomy follows expected lane/decision
- PASS reject_generated_summary_only follows expected lane/decision
- PASS reject_source_exists_not_support follows expected lane/decision
- PASS reject_contradiction_present follows expected lane/decision
- PASS reject_stale_runtime_state follows expected lane/decision
- PASS operator_review_architecture_synthesis follows expected lane/decision
- PASS hypothesis_synthesis_creative_problem_solving follows expected lane/decision
- PASS synthesis_frame_not_fact_memory follows expected lane/decision
- PASS synthesis_artifact_not_fact_memory follows expected lane/decision
- PASS synthesis_question_not_fact_memory follows expected lane/decision
- PASS synthesis_move_not_fact_memory follows expected lane/decision
- PASS hypothesis_synthesis_not_fact_memory follows expected lane/decision
- PASS same_run_rewrite_accept_blocked follows expected lane/decision
- PASS ambient_synthesis_trigger_constraints follows expected lane/decision
- PASS hard invariant: Chris/user/relationship claims never auto-accept
- PASS hard invariant: claims altering Ellis treatment of Chris never auto-accept
- PASS hard invariant: authority expansion never auto-accepts
- PASS hard invariant: source resolved without strong support never auto-accepts
- PASS hard invariant: broad or multi-part claims never auto-accept
- PASS hard invariant: current runtime-state claims never auto-accept unless rewritten historically
- PASS hard invariant: generated-summary-only evidence never auto-accepts
- PASS hard invariant: contradiction present blocks auto-accept
- PASS hard invariant: same-run rewrite-to-accept is blocked
- PASS hard invariant: dry-run receipts produce no mutation or prompt writes
- PASS hard invariant: prompt eligibility is not implied by accepted status
- PASS hard invariant: synthesis forms are distinguished and blocked from fact auto-accept
- PASS hard invariant: ambient synthesis triggers do not require explicit user request