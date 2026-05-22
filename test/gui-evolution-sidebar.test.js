const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const guiPath = path.join(repoRoot, 'cotw-scout-gui.html');
const html = fs.readFileSync(guiPath, 'utf8');

function extractEvolutionBlock() {
  const start = html.indexOf('// ---- Evolution ----');
  const end = html.indexOf('// ---- Projects ----', start);
  assert.ok(start > 0, 'expected Evolution block to exist');
  assert.ok(end > start, 'expected Projects block after Evolution block');
  return html.slice(start, end);
}

function createHarness() {
  const elements = new Map();
  const messages = { children: [], scrollTop: 0, scrollHeight: 0, appendChild(el) { this.children.push(el); this.scrollHeight += 1; } };
  const input = { value: '', focused: false, focus() { this.focused = true; } };
  elements.set('chatMessages', messages);
  elements.set('chatInput', input);
  elements.set('evolveTab', { innerHTML: '' });

  const context = {
    window: {},
    isElectron: false,
    document: {
      createElement(tag) { return { tag, className: '', innerHTML: '' }; },
      getElementById(id) { return elements.get(id) || null; }
    },
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    },
    autoResize(el) { el.autoResized = true; },
    closeSidebarDetail() { context.closedDetail = true; },
    openSidebarDetail(title, body) { context.detail = { title, body }; },
    addSystemMessage(message) { context.systemMessages.push(message); },
    systemMessages: []
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${extractEvolutionBlock()}; this.api = { EVOLUTION_CLASS_LABELS, getEvolutionPreviewEntries, loadEvolution, renderEvolutionSurface, updateEvolutionFilter, clearEvolutionFilters, filterEvolutionItems, renderSpineSnapshot, showSpineSnapshotDetail, renderEvolutionCard, showEvolutionDetail, openEvolutionInChat, handleEvolutionAction, buildEvolutionChatPrompt, mergeEvolutionEntriesWithSpineBlockedReceipts, getSpineBlockedOutcomeEntries, collapseEvolutionCandidateCards, showEvolutionCandidateGroupDetail, buildEvolutionCandidateActivityCopy, openEvolutionCandidateGroupInChat, renderEvolutionActionButtons, getEvolutionOutcome, renderEvolutionOutcomeBanner, isEvolutionApprovalCard, evolutionCanApplyCandidate, evolutionCanApproveAndApplyIfStillSafe, evolutionCanReviewCandidate, evolutionCanRollback, evolutionCanApproveHighRiskPacket, evolutionCanRecheckHighRiskApproval, evolutionCanApplyHighRiskClaimMaturation, evolutionCanPromoteScaffoldProposal, evolutionCanRollbackScaffoldPromotion, evolutionCanManageReceipt };`, context);
  return { context, elements, messages, input };
}

test('GUI exposes Evolve and Workbench beside Stand Turn Log', () => {
  assert.match(html, /switchTab\(this, 'evolve'\)/);
  assert.match(html, /switchTab\(this, 'workbench'\)/);
  assert.match(html, /id="evolveTab"/);
  assert.match(html, /id="workbenchTab"/);
  assert.match(html, /const tabs = \['standing', 'turning', 'journal', 'evolve', 'workbench'\]/);
  assert.match(html, /else if \(tab === 'evolve'\) loadEvolution\(\)/);
  assert.match(html, /else if \(tab === 'workbench'\) loadWorkbench\(\)/);
  assert.match(html, /else if \(tabName === 'evolve'\) loadEvolution\(\)/);
  assert.match(html, /else if \(tabName === 'work'\) loadWorkbench\(\)/);
});

test('evolution preview entries cover the planned change classes', () => {
  const { context } = createHarness();
  const entries = context.api.getEvolutionPreviewEntries();
  const classes = new Set(entries.map(e => e.class));
  assert.ok(classes.has('operational_lesson'));
  assert.ok(classes.has('hypothesis_held'));
  assert.ok(classes.has('process_ui_friction'));
  assert.equal(context.api.EVOLUTION_CLASS_LABELS.memory_hygiene, 'Memory hygiene');
  assert.equal(context.api.EVOLUTION_CLASS_LABELS.emergence_artifact, 'Emergence artifact');
});

test('loadEvolution renders grouped preview cards with status and risk metadata', async () => {
  const { context, elements } = createHarness();
  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Operational lesson/);
  assert.match(htmlOut, /Hypothesis held/);
  assert.match(htmlOut, /Process\/UI friction/);
  assert.match(htmlOut, /low risk/);
  assert.match(htmlOut, /Preview data shown outside the live Electron ledger/);
});

test('loadEvolution renders live ledger cards from preload API', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'evo-live-claim',
      class: 'claim_review',
      title: 'Applied claim review decision for claim-1',
      summary: 'Autonomously applied low-risk archive.',
      status: 'applied',
      risk: 'low',
      sourceCategory: 'source-addressable memory claim review',
      allowedBy: 'autonomous_low_risk',
      expectedEffect: 'Keeps uncertain material out of active truth.',
      verification: 'Receipt recorded.',
      rollback: 'Use rollback_review_decision.',
      rollbackAction: { tool: 'continuity_claims', action: 'rollback_review_decision', claim_id: 'claim-1', apply: true },
      metadata: {
        spineOutcomeLabels: {
          packetType: 'outcome_event',
          lifecycle: 'observed',
          consumers: 'allowed: ui_review, recall_search, outcome_ledger, maturation_router; blocked: context_injection, tool_action_execution, memory_promotion',
          promptInjection: 'blocked',
          mutation: 'append_only'
        }
      }
    }] })
  };
  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Claim review/);
  assert.match(htmlOut, /Applied claim review decision/);
  assert.match(htmlOut, /Live autonomy lane · 1 receipt · 0 candidates/);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Outcome packet/);
  assert.match(context.detail.body, /outcome_event/);
  assert.match(context.detail.body, /Outcome prompt injection/);
  assert.doesNotMatch(htmlOut, /Preview data/);
});

test('loadEvolution renders evolution ledger health warnings from preload API', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({
      live: true,
      entries: [{
        id: 'evo-live-claim',
        class: 'claim_review',
        title: 'Applied claim review decision for claim-1',
        summary: 'Autonomously applied low-risk archive.',
        status: 'applied',
        risk: 'low',
        sourceCategory: 'source-addressable memory claim review',
        action: 'apply_review_decision'
      }],
      health: {
        status: 'warning',
        warnings: [{
          code: 'orphan_cwd_evolution_ledger',
          message: '1 evolution receipt exists in a legacy cwd fallback ledger that the live sidebar does not read.'
        }]
      }
    })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Evolution ledger health: warning/);
  assert.match(htmlOut, /orphan_cwd_evolution_ledger/);
  assert.match(htmlOut, /legacy cwd fallback ledger/);
});

test('scaffold proposal cards lead with proposed change and expose promotion control', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  const entry = {
    id: 'code-evolution-proposal-exec',
    class: 'process_ui_friction',
    title: 'Scaffold proposal: add guardrails for exec',
    summary: '2 failed exec calls appeared across 2 Code mode sessions.',
    status: 'preview',
    risk: 'low',
    sourceCategory: 'code-evolution scaffold proposal',
    action: 'scaffold_proposal',
    expectedEffect: 'Reduce repeated exec failure loops.',
    verification: 'Run fixture.',
    rollback: 'Dismiss proposal.',
    metadata: {
      proposalKind: 'repeated_tool_failure',
      changeType: 'tool_hint',
      target: 'exec',
      proposedChange: 'Before using exec, verify required inputs and use the smallest observable step.',
      confidence: 0.75,
      mutationAttempted: 'false',
      promptInjectionChanged: 'false',
      testPlan: 'Run a failing exec fixture.',
      rollbackPlan: 'Dismiss proposal.',
      evidence: { failureCount: 2, sessionCount: 2, examples: ['command failed'] }
    }
  };
  context.window.cotw = { getEvolution: async () => ({ live: true, entries: [entry] }) };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Proposal:/);
  assert.match(htmlOut, /Before using exec/);
  assert.match(htmlOut, /Target:/);
  assert.match(htmlOut, /2 failures/);
  assert.equal(context.api.evolutionCanPromoteScaffoldProposal(entry), true);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /High-level proposal/);
  assert.match(context.detail.body, /Promote scaffold/);
  assert.match(context.detail.body, /Run a failing exec fixture/);

  context.api.openEvolutionInChat(0);
  assert.match(messages.children[0].innerHTML, /Promote scaffold/);
  assert.match(input.value, /Available controls: promote scaffold, keep receipt, disable, strip, mark harmful/);
});

test('applied scaffold promotions expose rollback scaffold control', async () => {
  const { context } = createHarness();
  const entry = {
    id: 'scaffold-promotion-code-evolution-proposal-exec',
    class: 'process_ui_friction',
    title: 'Promoted scaffold proposal: add guardrails for exec',
    summary: 'Applied tool hint to exec.',
    status: 'applied',
    risk: 'low',
    sourceCategory: 'code-evolution scaffold promotion',
    action: 'apply_scaffold_proposal',
    rollbackAction: { action: 'rollback_scaffold_promotion', promotion_id: 'scaffold-promotion-code-evolution-proposal-exec', snapshot_id: 'snapshot-1' },
    metadata: {
      changeType: 'tool_hint',
      target: 'exec',
      proposedChange: 'Before using exec, verify required inputs.',
      beforeHash: 'aaa',
      afterHash: 'bbb',
      snapshotId: 'snapshot-1'
    }
  };
  context.window.__evolutionData = [entry];
  assert.equal(context.api.evolutionCanRollbackScaffoldPromotion(entry), true);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Rollback scaffold/);
  assert.match(context.detail.body, /Before hash/);
  assert.match(context.detail.body, /Rollback snapshot/);
});

test('loadEvolution renders filter controls and filters by status risk class source date and rollback availability', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'evo-applied-1',
      class: 'claim_review',
      title: 'Applied claim review decision',
      summary: 'Autonomously applied low-risk archive.',
      status: 'applied',
      risk: 'low',
      sourceCategory: 'source-addressable memory claim review',
      action: 'apply_review_decision',
      createdAt: '2026-05-09T10:00:00.000Z',
      rollbackAction: { action: 'rollback_review_decision', claim_id: 'claim-1', receipt_id: 'before-1' }
    }, {
      id: 'evo-blocked-1',
      class: 'process_ui_friction',
      title: 'Blocked prompt injection request',
      summary: 'Protected lane blocked before execution.',
      status: 'blocked',
      risk: 'high',
      sourceCategory: 'prompt_injection',
      action: 'spine_blocked_action_receipt',
      createdAt: '2026-05-08T10:00:00.000Z'
    }] })
  };

  await context.api.loadEvolution();
  let htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Autonomy ledger filters/);
  assert.match(htmlOut, /Applied claim review decision/);
  assert.match(htmlOut, /Blocked prompt injection request/);

  context.api.updateEvolutionFilter('status', 'applied');
  htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Applied claim review decision/);
  assert.doesNotMatch(htmlOut, /Blocked prompt injection request/);

  context.api.updateEvolutionFilter('risk', 'low');
  context.api.updateEvolutionFilter('class', 'claim_review');
  context.api.updateEvolutionFilter('source', 'memory claim');
  context.api.updateEvolutionFilter('date', '2026-05-09');
  context.api.updateEvolutionFilter('rollback', 'available');
  htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /showing 1 filtered/);
  assert.match(htmlOut, /Clear filters/);
  assert.match(htmlOut, /Applied claim review decision/);

  context.api.clearEvolutionFilters();
  htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Blocked prompt injection request/);
});

test('loadEvolution renders read-only spine ledger snapshot when available', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'candidate-claim-1',
      class: 'hypothesis_held',
      title: 'Review candidate: useful model',
      summary: 'Dry-run recommends hold as hypothesis.',
      status: 'candidate',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'Build 7 read-only autonomy review; no mutation and no prompt injection.',
      expectedEffect: 'Keep useful synthesis available without treating it as verified belief.',
      verification: '1 source handle present; dry-run only.',
      rollback: 'No rollback needed. This is an unapplied dry-run candidate.',
      action: 'autonomy_review_dry_run'
    }] }),
    getSpineLedger: async () => ({
      live: true,
      readOnly: true,
      counts: {
        outcomeEvents: 2,
        governorDecisions: 3,
        contextEligibilityReviews: 4,
        maturationCandidates: 6,
        dryRunMaturationPreviews: 7,
        shadowEnforcementReceipts: 5,
        responsibilityLeases: 5,
        activeResponsibilityLeases: 1
      },
      policy: {
        reviewOnly: true,
        toolExecutionAuthorized: false,
        mutationAuthorized: false,
        promptInjectionAuthorized: false,
        schedulerAuthorized: false
      }
    })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Agent integration spine/);
  assert.match(htmlOut, /Read-only spine ledger/);
  assert.match(htmlOut, /2 outcomes/);
  assert.match(htmlOut, /3 governors/);
  assert.match(htmlOut, /4 context reviews/);
  assert.match(htmlOut, /6 candidates/);
  assert.match(htmlOut, /7 previews/);
  assert.match(htmlOut, /5 shadow checks/);
  assert.doesNotMatch(htmlOut, /5 enforcement receipts/);
  assert.match(htmlOut, /1 active leases/);
  context.api.showSpineSnapshotDetail();
  assert.match(context.detail.body, /Tool execution authorized/);
  assert.match(context.detail.body, /Prompt injection authorized/);
  assert.match(context.detail.body, /Scheduler authorized/);
  assert.match(context.detail.body, /Maturation candidates/);
  assert.match(context.detail.body, /Dry-run maturation previews/);
  assert.match(context.detail.body, /Shadow enforcement receipts/);
  assert.doesNotMatch(context.detail.body, /button/);
});

test('loadEvolution renders blocked spine action receipts as human-readable activity cards', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [] }),
    getSpineLedger: async () => ({
      live: true,
      readOnly: true,
      counts: { outcomeEvents: 1, governorDecisions: 1, shadowEnforcementReceipts: 1 },
      policy: { reviewOnly: true, toolExecutionAuthorized: false, mutationAuthorized: false, promptInjectionAuthorized: false, schedulerAuthorized: false },
      latest: { outcomeEvents: [{
        packetType: 'outcome_event',
        eventId: 'outcome:evolve-enable-prompt-injection',
        eventType: 'shadow_enforcement_observed',
        status: 'blocked',
        source: { sourceType: 'evolve_action_gate', sourceHandle: 'candidate-1', evidenceClass: 'direct' },
        intent: {
          title: 'Evolve action preflight: enable_prompt_injection',
          summary: 'Pre-action gate refused enable_prompt_injection before handler execution.',
          expectedEffect: 'No handler execution or protected authority mutation.'
        },
        authority: { authorizationMode: 'refused', governorDecisionId: 'gov:evolve-enable-prompt-injection' },
        action: { action: 'enable_prompt_injection', effect: 'prompt_injection' },
        observed: { status: 'blocked_before_handler', risk: 'high', authorized: false, wouldBlock: true },
        verification: { status: 'verified', method: 'evolve_pre_action_gate' },
        rollback: { available: false },
        policy: { promptInjectionRisk: 'blocked', mutationPolicy: 'append_only' }
      }, {
        packetType: 'outcome_event',
        eventId: 'outcome:live-shadow-prompt-injection',
        eventType: 'shadow_enforcement_observed',
        status: 'blocked',
        source: { sourceType: 'runtime_enforcement_shadow', sourceHandle: 'sidebar:spine', evidenceClass: 'direct' },
        intent: { title: 'Authority lane request: prompt_injection' },
        action: { action: 'evaluate_authority_lane', lane: 'prompt_injection' },
        observed: { status: 'blocked', risk: 'high' }
      }] }
    })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Evolve action preflight: enable_prompt_injection/);
  assert.match(htmlOut, /Addressing:/);
  assert.match(htmlOut, /Decision: blocked before execution/);
  assert.match(htmlOut, /Action taken:/);
  assert.match(htmlOut, /Rollback\/reopen:/);
  assert.doesNotMatch(htmlOut, /Authority lane request: prompt_injection/);
  assert.match(htmlOut, /Live autonomy lane · 1 receipt · 0 candidates/);
});

test('risk-boundary crossings render as approval cards without granting authority', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [] }),
    getSpineLedger: async () => ({
      live: true,
      readOnly: true,
      counts: { outcomeEvents: 1, governorDecisions: 1, shadowEnforcementReceipts: 1 },
      policy: { reviewOnly: true, toolExecutionAuthorized: false, mutationAuthorized: false, promptInjectionAuthorized: false, schedulerAuthorized: false },
      latest: { outcomeEvents: [{
        packetType: 'outcome_event',
        eventId: 'outcome:evolve-scheduler-linkage',
        eventType: 'shadow_enforcement_observed',
        status: 'review_requested',
        source: { sourceType: 'evolve_action_gate', sourceHandle: 'candidate-lease-1', evidenceClass: 'direct' },
        intent: {
          title: 'Authority lane request: scheduler_linkage',
          summary: 'A durable background responsibility would need active lease approval.',
          expectedEffect: 'Allow one bounded scheduler linkage after explicit approval.'
        },
        authority: { authorizationMode: 'approval_required', governorDecisionId: 'gov:evolve-scheduler-linkage' },
        action: { action: 'enable_scheduler_linkage', lane: 'scheduler_linkage', effect: 'background responsibility' },
        observed: { status: 'would_require_approval', risk: 'medium', authorized: false, wouldBlock: true },
        verification: { status: 'verified', method: 'authority_lane_policy' },
        rollback: { available: false, plan: 'No runtime effect was applied; deny keeps lane closed.' },
        policy: { promptInjectionRisk: 'blocked', mutationPolicy: 'append_only' }
      }] }
    })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Approval required: Authority lane request: scheduler_linkage/);
  assert.match(htmlOut, /What Evolve wants to do:/);
  assert.match(htmlOut, /Target:/);
  assert.match(htmlOut, /Details \/ audit trail/);
  assert.match(htmlOut, /Before:/);
  assert.match(htmlOut, /If approved:/);
  assert.match(htmlOut, /Risk:/);
  assert.match(htmlOut, /Reversibility:/);
  assert.match(htmlOut, /Audit:/);
  assert.match(htmlOut, />Approve<\/button>/);
  assert.match(htmlOut, />Deny<\/button>/);

  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Approval summary/);
  assert.match(context.detail.body, /Audit expectations/);
  assert.match(context.detail.body, />Approve<\/button>/);
  assert.match(context.detail.body, />Deny<\/button>/);
  assert.doesNotMatch(context.detail.body, /Disable/);

  context.api.openEvolutionInChat(0, 'Approval requested: inspect this risk-boundary crossing.');
  assert.match(messages.children[0].innerHTML, /Approve/);
  assert.match(messages.children[0].innerHTML, /Deny/);
  assert.match(input.value, /Approval target: scheduler_linkage · enable_scheduler_linkage/);
  assert.match(input.value, /Available controls: approve, deny, details/);
});

test('evolution card can open a chat interrogation packet without auto-sending', async () => {
  const { context, messages, input } = createHarness();
  await context.api.loadEvolution();
  context.api.openEvolutionInChat(0);
  assert.equal(messages.children.length, 1);
  assert.match(messages.children[0].innerHTML, /Evolution context opened/);
  assert.match(input.value, /I want to interrogate this autonomous evolution change/);
  assert.match(input.value, /Artifact: evo-preview-bounded-restart/);
  assert.match(input.value, /Rollback path:/);
  assert.equal(input.focused, true);
  assert.equal(input.autoResized, true);
  assert.equal(context.closedDetail, true);
});

test('loadEvolution renders live dry-run candidates without receipt rollback controls', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'candidate-claim-1',
      class: 'hypothesis_held',
      title: 'Review candidate: useful model',
      summary: 'Dry-run recommends hold as hypothesis.',
      status: 'candidate',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'Build 7 read-only autonomy review; no mutation and no prompt injection.',
      expectedEffect: 'Keep useful synthesis available without treating it as verified belief.',
      verification: '1 source handle present; dry-run only.',
      rollback: 'No rollback needed. This is an unapplied dry-run candidate.',
      action: 'autonomy_review_dry_run',
      claimId: 'claim-1',
      metadata: {
        policyDecision: 'hold_as_hypothesis',
        lane: 'hypothesis_synthesis',
        spineLabels: {
          packetType: 'maturation_candidate',
          lifecycle: 'candidate',
          freshness: 'durable',
          consumers: 'allowed: ui_review, recall_search, maturation_router; blocked: context_injection, tool_action_execution, memory_promotion',
          promptInjection: 'blocked',
          mutation: 'none'
        }
      }
    }] })
  };
  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Hypothesis held/);
  assert.match(htmlOut, /candidate/);
  assert.match(htmlOut, /Live autonomy lane · 0 receipts · 1 candidate/);
  context.api.showEvolutionDetail(0);
  assert.doesNotMatch(context.detail.body, /Rollback<\/button>/);
  assert.doesNotMatch(context.detail.body, /Mark harmful/);
  assert.match(context.detail.body, /Policy decision/);
  assert.match(context.detail.body, /Spine packet/);
  assert.match(context.detail.body, /maturation_candidate/);
  assert.match(context.detail.body, /Prompt injection/);
  assert.match(context.detail.body, /blocked/);
});

test('high-risk dry-run approval cards expose and persist packet controls without apply', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'candidate-claim-sensitive',
      class: 'hypothesis_held',
      title: 'Review candidate: sensitive synthesis',
      summary: 'Dry-run recommends hold as hypothesis. Decision: explicit approval required before any behavior-changing action.',
      status: 'held',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'Build 7 read-only autonomy review; no mutation and no prompt injection.',
      expectedEffect: 'Keep useful synthesis available without treating it as verified belief.',
      verification: '1 source handle present; dry-run only.',
      rollback: 'No rollback needed. This is an unapplied dry-run candidate.',
      action: 'autonomy_review_dry_run',
      claimId: 'claim-sensitive',
      metadata: {
        policyDecision: 'hold_as_hypothesis',
        lane: 'hypothesis_synthesis',
        approvalCard: {
          required: true,
          protocol: 'high_risk_candidate',
          summary: 'High-risk candidate held for explicit approval.',
          target: 'claim claim-sensitive · hypothesis synthesis',
          before: 'Dry-run candidate only; no mutation has occurred.',
          after: 'Only after explicit approval: keep as hypothesis.',
          riskCategory: 'high risk · risk_boundary_requires_approval',
          reversibility: 'Apply requires a domain-specific rollback receipt.',
          audit: 'Approval must bind candidate id, action id, target refs, effect class, expiry, verification, and rollback.'
        }
      }
    }] }),
    updateEvolutionEvent: async ({ id, action }) => ({ ok: true, entry: {
      id: 'evo-approval-packet-1',
      class: 'hypothesis_held',
      title: 'Prepared high-risk approval packet: Review candidate: sensitive synthesis',
      summary: 'Prepared an explicit approval packet. This is review evidence only; no claim mutation occurred.',
      status: 'held',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'operator_packet_preparation_only_no_apply_authority',
      expectedEffect: 'Binds the exact terms without granting apply authority.',
      verification: 'Approval packet persisted; apply still requires explicit approval and reclassification.',
      rollback: 'Dismiss or mark reviewed to retire this approval packet.',
      action: 'high_risk_approval_packet',
      claimId: 'claim-sensitive',
      metadata: {
        approvalStatus: 'pending_explicit_operator_approval',
        approvalPacket: { candidateId: id, actionId: 'high_risk_review_apply', applyAuthorityGranted: false, applyGate: 'closed_explicit_recheck' }
      }
    }, contextPacket: `Evolution action requested: ${action}` })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Pending proposal/);
  assert.match(htmlOut, /Needs review — no change made/);
  assert.match(htmlOut, /No change made; Details only opens the audit trail/);
  assert.match(htmlOut, />Deny<\/button>/);
  assert.match(htmlOut, />Details<\/button>/);
  assert.match(htmlOut, /Details \/ audit trail/);
  assert.doesNotMatch(htmlOut, /Prepare review packet/);
  assert.doesNotMatch(htmlOut, /run_high_risk_preflight/);
  assert.doesNotMatch(htmlOut, /Keep for later/);
  assert.doesNotMatch(htmlOut, /Dismiss/);
  assert.doesNotMatch(htmlOut, /Apply safely/);
  assert.doesNotMatch(htmlOut, />Approve<\/button>/);

  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Approval summary/);
  assert.match(context.detail.body, /No change made/);
  assert.match(context.detail.body, /Prepare review packet/);
  assert.doesNotMatch(context.detail.body, /Apply safely/);

  context.api.openEvolutionInChat(0);
  assert.match(input.value, /Available controls: deny, details, prepare review packet, dry-run \/ preflight/);
  assert.match(input.value, /Approval target: claim claim-sensitive/);

  await context.api.handleEvolutionAction(0, 'prepare_high_risk_approval_packet');
  assert.equal(messages.children.length, 2);
  assert.match(context.systemMessages[0], /held/);
  assert.match(input.value, /Evolution action requested: prepare_high_risk_approval_packet/);
  assert.match(input.value, /Status: held/);
  assert.match(input.value, /operator_packet_preparation_only_no_apply_authority/);
  assert.doesNotMatch(input.value, /Apply safely/);
});


test('eligible high-risk claim candidates expose approve deny details proposal controls', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  const candidate = {
    id: 'candidate-claim-ready',
    class: 'hypothesis_held',
    title: 'Review candidate: ready synthesis',
    summary: 'Dry-run recommends hold as hypothesis. Decision: explicit approval required before any behavior-changing action.',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    allowedBy: 'Build 7 read-only autonomy review; no mutation and no prompt injection.',
    expectedEffect: 'Keep useful synthesis available without treating it as verified belief.',
    verification: '1 source handle present; dry-run only.',
    rollback: 'No rollback needed. This is an unapplied dry-run candidate.',
    action: 'autonomy_review_dry_run',
    claimId: 'claim-ready',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-claim-ready',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-ready', internal: 'claim-ready' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      },
      approvalCard: {
        required: true,
        protocol: 'high_risk_candidate',
        summary: 'High-risk candidate held for explicit approval.',
        target: 'claim claim-ready · hypothesis synthesis',
        before: 'Dry-run candidate only; no mutation has occurred.',
        after: 'Only after explicit approval: keep as hypothesis.',
        riskCategory: 'high risk · risk_boundary_requires_approval',
        reversibility: 'Apply requires a domain-specific rollback receipt.',
        audit: 'Approval must bind candidate id, action id, target refs, effect class, expiry, verification, and rollback.'
      }
    }
  };
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [candidate] }),
    updateEvolutionEvent: async ({ action }) => ({ ok: true, entry: {
      id: 'evo-high-risk-apply-1',
      class: 'hypothesis_held',
      title: 'Applied approved high-risk claim maturation for claim-ready',
      summary: 'Applied one approved high-risk claim maturation after packet, explicit approval, pre-action recheck, and before/after receipts.',
      status: 'applied',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      action: 'high_risk_claim_apply',
      rollbackAction: { action: 'rollback_review_decision', claim_id: 'claim-ready', receipt_id: 'before-1' }
    }, contextPacket: `Evolution action requested: ${action}` })
  };

  await context.api.loadEvolution();
  assert.equal(context.api.evolutionCanApproveAndApplyIfStillSafe(candidate), true);
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, />Approve<\/button>/);
  assert.match(htmlOut, />Deny<\/button>/);
  assert.match(htmlOut, />Details<\/button>/);
  assert.doesNotMatch(htmlOut, /Approve and apply if still safe/);
  assert.doesNotMatch(htmlOut, /Preview details/);
  assert.doesNotMatch(htmlOut, /Record approval/);
  assert.doesNotMatch(htmlOut, /Apply approved claim change/);

  context.api.openEvolutionInChat(0);
  assert.match(input.value, /Available controls: approve, deny, details, prepare review packet, dry-run \/ preflight/);

  await context.api.handleEvolutionAction(0, 'approve_and_apply_if_still_safe');
  assert.equal(messages.children.length, 2);
  assert.match(input.value, /Evolution action requested: approve_and_apply_if_still_safe/);
});


test('deny on a proposal records denied no-change outcome', async () => {
  const { context, elements } = createHarness();
  context.isElectron = true;
  const candidate = {
    id: 'candidate-deny-ready',
    class: 'hypothesis_held',
    title: 'Review candidate: denyable synthesis',
    summary: 'Dry-run recommends hold as hypothesis.',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    action: 'autonomy_review_dry_run',
    claimId: 'claim-deny-ready',
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      highRiskProtocol: {
        protocol: 'high_risk_candidate',
        posture: 'approval_required',
        candidateId: 'candidate-deny-ready',
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation',
        targetRefs: { display: 'claim claim-deny-ready', internal: 'claim-deny-ready' },
        expiry: 'recheck required immediately before apply',
        requiredVerification: ['before_receipt', 'after_receipt'],
        rollbackPlan: 'domain-specific rollback receipt required before apply'
      },
      approvalCard: {
        required: true,
        protocol: 'high_risk_candidate',
        summary: 'High-risk candidate held for explicit approval.',
        target: 'claim claim-deny-ready',
        after: 'Only after explicit approval: keep as hypothesis.'
      }
    }
  };
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [candidate] }),
    updateEvolutionEvent: async ({ action }) => ({ ok: true, entry: {
      ...candidate,
      id: 'evo-denied-proposal-1',
      title: 'Denied proposal: denyable synthesis',
      summary: 'User/operator denied this proposal. No claim mutation occurred.',
      status: 'denied',
      action: 'candidate_review_receipt',
      operatorActions: [{ action, status: 'denied' }]
    }, contextPacket: `Evolution action requested: ${action}` })
  };

  await context.api.loadEvolution();
  assert.match(elements.get('evolveTab').innerHTML, />Deny<\/button>/);
  await context.api.handleEvolutionAction(0, 'deny_proposal');
  assert.match(context.detail.body, /Denied — no change made/);
  assert.match(context.detail.body, /no underlying claim or runtime change was applied/);
});

test('high-risk approval packet receipts can capture explicit approval without apply controls', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'evo-packet-approval-1',
      class: 'hypothesis_held',
      title: 'Prepared high-risk approval packet: sensitive synthesis',
      summary: 'Prepared an explicit approval packet. This is review evidence only; no claim mutation occurred.',
      status: 'held',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'operator_packet_preparation_only_no_apply_authority',
      expectedEffect: 'Binds exact terms without granting apply authority.',
      verification: 'Apply still requires explicit approval and reclassification.',
      rollback: 'Dismiss or mark reviewed to retire this approval packet.',
      action: 'high_risk_approval_packet',
      claimId: 'claim-sensitive',
      metadata: {
        approvalStatus: 'pending_explicit_approval',
        approvalPacket: {
          packetId: 'packet-sensitive-1',
          protocol: 'high_risk_candidate',
          approvalStatus: 'pending_explicit_approval',
          candidateId: 'candidate-claim-sensitive',
          actionId: 'high_risk_review_apply',
          effectClass: 'claim_maturation',
          targetRefs: { display: 'claim claim-sensitive', internal: 'claim-sensitive' },
          expiry: 'recheck required immediately before apply',
          requiredVerification: ['before_receipt', 'after_receipt'],
          rollbackPlan: 'domain-specific rollback receipt required before apply',
          applyAuthorityGranted: false
        }
      }
    }] }),
    updateEvolutionEvent: async ({ id, action }) => ({ ok: true, entry: {
      id: 'evo-explicit-approval-1',
      class: 'hypothesis_held',
      title: 'Explicit approval captured: sensitive synthesis',
      summary: 'Captured explicit approval for one bound high-risk packet. This records approval intent only; no claim mutation occurred.',
      status: 'held',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'explicit_packet_approval_capture_only_no_apply_authority',
      expectedEffect: 'Binds approval without granting apply authority.',
      verification: 'Future apply must re-run risk classification.',
      rollback: 'Revoke or supersede before future apply.',
      action: 'high_risk_explicit_approval',
      claimId: 'claim-sensitive',
      metadata: {
        approvalStatus: 'explicitly_approved_no_apply',
        applyAuthorityGranted: false,
        approvalBinding: { candidateId: id, actionId: 'high_risk_review_apply' }
      }
    }, contextPacket: `Evolution action requested: ${action}` })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.doesNotMatch(htmlOut, /Apply safely/);

  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /No change made; this does not grant apply authority/);
  assert.match(context.detail.body, /Record explicit approval/);
  assert.doesNotMatch(context.detail.body, /Apply safely/);

  context.api.openEvolutionInChat(0);
  assert.match(input.value, /Available controls: record explicit approval/);
  assert.doesNotMatch(input.value, /apply safely/);

  await context.api.handleEvolutionAction(0, 'record_high_risk_explicit_approval');
  assert.equal(messages.children.length, 2);
  assert.match(input.value, /Evolution action requested: record_high_risk_explicit_approval/);
  assert.match(input.value, /explicit_packet_approval_capture_only_no_apply_authority/);
  assert.doesNotMatch(input.value, /Apply safely/);
});


test('explicit high-risk approval receipts expose pre-action recheck without apply controls', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'evo-explicit-approval-recheck-1',
      class: 'hypothesis_held',
      title: 'Explicit approval captured: sensitive synthesis',
      summary: 'Captured explicit approval for one bound high-risk packet. This records approval intent only; no claim mutation occurred.',
      status: 'held',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'explicit_packet_approval_capture_only_no_apply_authority',
      expectedEffect: 'Binds approval without granting apply authority.',
      verification: 'Future apply must re-run risk classification.',
      rollback: 'Revoke or supersede before future apply.',
      action: 'high_risk_explicit_approval',
      claimId: 'claim-sensitive',
      metadata: {
        approvalStatus: 'explicitly_approved_no_apply',
        applyAuthorityGranted: false,
        approvalBinding: {
          packetId: 'packet-sensitive-1',
          candidateId: 'candidate-claim-sensitive',
          actionId: 'high_risk_review_apply',
          effectClass: 'claim_maturation',
          targetRefs: { display: 'claim claim-sensitive', internal: 'claim-sensitive' },
          expiry: 'recheck required immediately before apply',
          requiredVerification: ['before_receipt', 'after_receipt'],
          rollbackPlan: 'domain-specific rollback receipt required before apply'
        }
      }
    }] }),
    updateEvolutionEvent: async ({ action }) => ({ ok: true, entry: {
      id: 'evo-recheck-1',
      class: 'hypothesis_held',
      title: 'Pre-action recheck: sensitive synthesis',
      summary: 'Re-ran the high-risk approval binding check against the current candidate. No apply handler executed.',
      status: 'held',
      risk: 'high',
      sourceCategory: 'hypothesis_synthesis',
      allowedBy: 'pre_action_reclassification_receipt_only_no_apply_authority',
      expectedEffect: 'Records whether one explicit high-risk approval still matches the current candidate; does not authorize or execute apply.',
      verification: 'Apply authority remains false.',
      rollback: 'No domain rollback is needed because no mutation occurred.',
      action: 'high_risk_pre_action_recheck',
      claimId: 'claim-sensitive',
      metadata: { approvalStatus: 'rechecked_no_apply', applyAuthorityGranted: false, approvedForApply: false }
    }, contextPacket: `Evolution action requested: ${action}` })
  };

  await context.api.loadEvolution();
  assert.doesNotMatch(elements.get('evolveTab').innerHTML, /Apply safely/);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Approval was recorded for these exact terms only/);
  assert.match(context.detail.body, /Run pre-action recheck/);
  assert.doesNotMatch(context.detail.body, /Apply safely/);

  context.api.openEvolutionInChat(0);
  assert.match(input.value, /Available controls: run pre-action recheck/);
  assert.doesNotMatch(input.value, /apply safely/);

  await context.api.handleEvolutionAction(0, 'run_high_risk_pre_action_recheck');
  assert.equal(messages.children.length, 2);
  assert.match(input.value, /Evolution action requested: run_high_risk_pre_action_recheck/);
  assert.match(input.value, /pre_action_reclassification_receipt_only_no_apply_authority/);
  assert.match(context.detail.body, /Not applied — no change made/);
  assert.match(context.detail.body, /Apply authority stayed closed/);
  assert.doesNotMatch(input.value, /Apply safely/);
});

test('blocked high-risk recheck receipts report not-applied instead of protected-boundary generic copy', async () => {
  const { context, elements } = createHarness();
  const entry = {
    id: 'evo-recheck-blocked-1',
    class: 'hypothesis_held',
    title: 'Pre-action recheck blocked: sensitive synthesis',
    summary: 'Re-ran the high-risk approval binding check against the current candidate. No apply handler executed.',
    status: 'blocked',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    allowedBy: 'pre_action_reclassification_receipt_only_no_apply_authority',
    expectedEffect: 'Records whether one explicit high-risk approval still matches the current candidate; does not authorize or execute apply.',
    verification: 'Current candidate missing.',
    rollback: 'No domain rollback is needed because no mutation occurred.',
    action: 'high_risk_pre_action_recheck',
    claimId: 'claim-sensitive',
    metadata: {
      approvalStatus: 'rechecked_no_apply',
      recheckOutcome: 'approval expired candidate missing',
      applyAuthorityGranted: false,
      approvedForApply: false
    }
  };
  context.isElectron = true;
  context.window.cotw = { getEvolution: async () => ({ live: true, entries: [entry] }) };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Not applied — no change made/);
  assert.match(htmlOut, /approved packet did not match a current live candidate/);
  assert.doesNotMatch(htmlOut, /crossed a protected boundary/);
});

test('successful high-risk recheck receipts expose approved claim apply control only for claim maturation', async () => {
  const { context, elements, messages, input } = createHarness();
  context.isElectron = true;
  const recheckEntry = {
    id: 'evo-recheck-apply-1',
    class: 'hypothesis_held',
    title: 'Pre-action recheck: sensitive synthesis',
    summary: 'Re-ran the high-risk approval binding check against the current candidate.',
    status: 'held',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    allowedBy: 'pre_action_reclassification_receipt_only_no_apply_authority',
    expectedEffect: 'Records whether one explicit high-risk approval still matches the current candidate.',
    verification: 'Current candidate matched approved binding. Apply authority remains false.',
    rollback: 'No domain rollback is needed because no mutation occurred.',
    action: 'high_risk_pre_action_recheck',
    claimId: 'claim-sensitive',
    metadata: {
      approvalStatus: 'rechecked_no_apply',
      recheckOutcome: 'current approval still gated',
      applyAuthorityGranted: false,
      mutationAttempted: false,
      approvedBinding: {
        actionId: 'high_risk_review_apply',
        effectClass: 'claim_maturation'
      }
    }
  };
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [recheckEntry] }),
    updateEvolutionEvent: async ({ action }) => ({ ok: true, entry: {
      ...recheckEntry,
      id: 'evo-high-risk-apply-1',
      title: 'Applied approved high-risk claim maturation for claim-sensitive',
      status: 'applied',
      action: 'high_risk_claim_apply',
      rollbackAction: { action: 'rollback_review_decision', claim_id: 'claim-sensitive', receipt_id: 'before-1' }
    }, contextPacket: `Evolution action requested: ${action}` })
  };

  await context.api.loadEvolution();
  assert.equal(context.api.evolutionCanApplyHighRiskClaimMaturation(recheckEntry), true);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Final safety check passed, but no change has been made yet/);
  assert.match(context.detail.body, /Apply approved claim change/);

  context.api.openEvolutionInChat(0);
  assert.match(input.value, /Available controls: apply approved claim change/);
  assert.doesNotMatch(input.value, /apply safely/);

  await context.api.handleEvolutionAction(0, 'apply_high_risk_claim_maturation');
  assert.equal(messages.children.length, 2);
  assert.match(input.value, /Evolution action requested: apply_high_risk_claim_maturation/);
});

test('loadEvolution groups redundant live dry-run candidates by shared policy posture', async () => {
  const { context, elements, input } = createHarness();
  const makeCandidate = (id, title) => ({
    id,
    class: 'hypothesis_held',
    title,
    summary: 'Dry-run recommends hold as hypothesis in hypothesis synthesis. Reasons: sensitive_user_claim, source_not_resolved, auto_accept_blocked_by_weak_support.',
    status: 'candidate',
    risk: 'high',
    sourceCategory: 'hypothesis_synthesis',
    allowedBy: 'Build 7 read-only autonomy review; no mutation and no prompt injection.',
    expectedEffect: 'Keep useful synthesis available without treating it as verified belief.',
    verification: '1 source handle present; dry-run only.',
    rollback: 'No rollback needed. This is an unapplied dry-run candidate.',
    action: 'autonomy_review_dry_run',
    claimId: id,
    metadata: {
      policyDecision: 'hold_as_hypothesis',
      lane: 'hypothesis_synthesis',
      spineLabels: {
        packetType: 'maturation_candidate',
        lifecycle: 'candidate',
        freshness: 'durable',
        consumers: 'allowed: ui_review, recall_search, maturation_router; blocked: context_injection, tool_action_execution, memory_promotion',
        promptInjection: 'blocked',
        mutation: 'none'
      }
    }
  });
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [
      makeCandidate('claim-1', 'Review candidate: Archived summary one'),
      makeCandidate('claim-2', 'Review candidate: Archived summary two'),
      makeCandidate('claim-3', 'Review candidate: Archived summary three')
    ] })
  };

  await context.api.loadEvolution();
  const htmlOut = elements.get('evolveTab').innerHTML;
  assert.match(htmlOut, /Archived summaries need evidence before becoming memory/);
  assert.match(htmlOut, /Observed:/);
  assert.match(htmlOut, /3 summary-derived claims from continuity backfill/);
  assert.match(htmlOut, /Action taken:/);
  assert.match(htmlOut, /Held them as hypotheses only/);
  assert.match(htmlOut, /sources are unresolved or summary-only/);
  assert.match(htmlOut, /Verify sources/);
  assert.match(htmlOut, /Live autonomy lane · 0 receipts · 3 candidates/);
  assert.equal((htmlOut.match(/Dry-run recommends hold as hypothesis/g) || []).length, 0);
  context.api.showEvolutionCandidateGroupDetail(0);
  assert.match(context.detail.title, /Archived summaries need evidence before becoming memory/);
  assert.match(context.detail.body, /Addressing/);
  assert.match(context.detail.body, /Shared reasons/);
  assert.match(context.detail.body, /source_not_resolved/);
  assert.match(context.detail.body, /Review candidate: Archived summary one/);
  assert.doesNotMatch(context.detail.body, /Rollback<\/button>/);
  assert.doesNotMatch(context.detail.body, /Mark harmful/);
  context.api.openEvolutionCandidateGroupInChat(0, 'verify_sources');
  assert.match(input.value, /Grouped activity: Archived summaries need evidence before becoming memory/);
  assert.match(input.value, /verify the source handles/);
});

test('dry-run candidates expose review and dismiss without requiring apply eligibility', async () => {
  const { context } = createHarness();
  const entry = {
    id: 'candidate-high-1',
    class: 'claim_review',
    title: 'Review candidate: needs manual review',
    summary: 'Dry-run recommends manual review.',
    status: 'candidate',
    risk: 'high',
    sourceCategory: 'sensitive_claim_review',
    action: 'autonomy_review_dry_run',
    metadata: {
      policyDecision: 'requires_manual_review',
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false
    }
  };
  context.window.__evolutionData = [entry];
  assert.equal(context.api.evolutionCanApplyCandidate(entry), false);
  assert.equal(context.api.evolutionCanReviewCandidate(entry), true);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Mark reviewed/);
  assert.match(context.detail.body, /Dismiss/);
  assert.doesNotMatch(context.detail.body, /Apply safely/);
});

test('low-risk dry-run candidates expose apply safely and no rollback', async () => {
  const { context } = createHarness();
  const entry = {
    id: 'candidate-low-1',
    class: 'memory_hygiene',
    title: 'Review candidate: stale open question',
    summary: 'Dry-run recommends archive open question.',
    status: 'candidate',
    risk: 'low',
    sourceCategory: 'reject_or_archive',
    action: 'autonomy_review_dry_run',
    metadata: {
      policyDecision: 'archive_open_question',
      mutationAttempted: false,
      promptInjectionEligibilityChanged: false
    }
  };
  context.window.__evolutionData = [entry];
  assert.equal(context.api.evolutionCanApplyCandidate(entry), true);
  assert.equal(context.api.evolutionCanRollback(entry), false);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Apply safely/);
  assert.match(context.detail.body, /Mark reviewed/);
  assert.match(context.detail.body, /Dismiss/);
  assert.doesNotMatch(context.detail.body, /Rollback<\/button>/);
});

test('applied claim receipts expose rollback disable strip and receipt management controls', async () => {
  const { context, messages, input } = createHarness();
  const entry = {
    id: 'receipt-1',
    class: 'claim_review',
    title: 'Applied claim review decision',
    summary: 'Autonomously applied low-risk archive.',
    status: 'applied',
    risk: 'low',
    sourceCategory: 'source-addressable memory claim review',
    allowedBy: 'autonomous_low_risk',
    expectedEffect: 'Safer memory',
    verification: 'Receipt recorded',
    rollback: 'Use rollback_review_decision',
    action: 'apply_review_decision',
    rollbackAction: { action: 'rollback_review_decision', claim_id: 'claim-1', receipt_id: 'before-1', apply: true }
  };
  context.window.__evolutionData = [entry];
  assert.equal(context.api.evolutionCanRollback(entry), true);
  assert.equal(context.api.evolutionCanManageReceipt(entry), true);
  context.api.showEvolutionDetail(0);
  assert.match(context.detail.body, /Rollback/);
  assert.match(context.detail.body, /Keep receipt/);
  assert.match(context.detail.body, /Disable/);
  assert.match(context.detail.body, /Strip/);
  assert.match(context.detail.body, /Mark harmful/);

  context.api.openEvolutionInChat(0);
  assert.match(messages.children[0].innerHTML, /Disable/);
  assert.match(messages.children[0].innerHTML, /Strip/);
  assert.match(input.value, /Available controls: rollback, keep receipt, disable, strip, mark harmful/);
});

test('rollback action updates live receipt and brings rollback packet into chat', async () => {
  const { context, messages, input } = createHarness();
  context.isElectron = true;
  context.window.cotw = {
    getEvolution: async () => ({ live: true, entries: [{
      id: 'evo-live-claim', class: 'claim_review', title: 'Applied claim review decision', summary: 'Safe change',
      status: 'applied', risk: 'low', sourceCategory: 'claim review', allowedBy: 'autonomous_low_risk',
      expectedEffect: 'Safer memory', verification: 'Receipt recorded', rollback: 'Use rollback_review_decision',
      rollbackAction: { tool: 'continuity_claims', action: 'rollback_review_decision', claim_id: 'claim-1', apply: true }
    }] }),
    updateEvolutionEvent: async ({ id, action }) => ({ ok: true, entry: {
      id, class: 'claim_review', title: 'Applied claim review decision', summary: 'Safe change', status: 'rollback_requested',
      risk: 'low', sourceCategory: 'claim review', allowedBy: 'autonomous_low_risk', expectedEffect: 'Safer memory',
      verification: 'Receipt recorded', rollback: 'Use rollback_review_decision'
    }, contextPacket: `Evolution action requested: ${action}` })
  };
  await context.api.loadEvolution();
  await context.api.handleEvolutionAction(0, 'rollback_requested');
  assert.equal(messages.children.length, 1);
  assert.match(input.value, /Evolution action requested: rollback_requested/);
  assert.match(input.value, /Status: rollback_requested/);
  assert.match(context.systemMessages[0], /rollback_requested/);
});
