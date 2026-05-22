const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const preload = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');

test('preload exposes read-only spine ledger IPC method', () => {
  assert.match(preload, /getSpineLedger: \(\) => ipcRenderer\.invoke\('sidebar:spine'\)/);
});

test('main registers read-only spine sidebar handler', () => {
  assert.match(main, /candidateSpineLedgerPaths/);
  assert.match(main, /getSpineLedgerSnapshot/);
  assert.match(main, /loadEvolutionCandidateEntries/);
  assert.match(main, /spineOutcomePacket/);
  assert.match(main, /spinePacket/);
  assert.match(main, /ipcMain\.handle\('sidebar:spine'/);
  assert.match(main, /readOnly: true/);
  assert.doesNotMatch(main, /ipcMain\.handle\('sidebar:spine-action'/);
});

test('main wires bounded evolution apply and rollback through receipts', () => {
  assert.match(main, /apply_low_risk_candidate/);
  assert.match(main, /apply_high_risk_claim_maturation/);
  assert.match(main, /rollback_claim_review/);
  assert.match(main, /createAutonomyReviewDecisionApply/);
  assert.match(main, /createAutonomyReviewDecisionRollback/);
  assert.match(main, /recordClaimReviewEvolution/);
  assert.match(main, /Candidate is not low risk; autonomous apply refused/);
});

test('main feeds live shadow enforcement receipts into read-only spine snapshot', () => {
  assert.match(main, /createLiveShadowAuthorityEnforcementReceipts/);
  assert.match(main, /createAuthorityLaneEnforcementReceipt/);
  assert.match(main, /live-shadow-/);
  assert.match(main, /authority_lane_enablement_shadow_check/);
});

test('main records runtime tool shadow preflights from live tool events', () => {
  assert.match(main, /recordRuntimeActionShadowPreflight/);
  assert.match(main, /recordObservedRuntimeToolPreflight/);
  assert.match(main, /runtimePreflightToolIds/);
  assert.match(main, /gateway_tool_event/);
  assert.match(main, /inferRuntimeToolTarget/);
});

test('main records candidate review receipts and suppresses handled dry-run candidates', () => {
  assert.match(main, /recordCandidateReviewEvolution/);
  assert.match(main, /reviewDryRunEvolutionCandidate/);
  assert.match(main, /candidate_review_receipt/);
  assert.match(main, /filterHandledEvolutionCandidates/);
  assert.match(main, /activeCandidates\.map\(\(entry\) => entry\.metadata\?\.spinePacket\)/);
});

test('main gates Evolve actions before mutation handlers', () => {
  assert.match(main, /createEvolutionActionGateReceipt/);
  assert.match(main, /recordEvolutionActionGateReceipt/);
  assert.match(main, /PROTECTED_EVOLUTION_ACTION_LANES/);
  assert.match(main, /refuseEvolutionActionFromGate/);
  assert.match(main, /function applyLowRiskEvolutionCandidate[\s\S]*?createEvolutionActionGateReceipt/);
  assert.match(main, /function rollbackClaimReviewEvolution[\s\S]*?createEvolutionActionGateReceipt/);
  assert.match(main, /function runHighRiskEvolutionPreflight[\s\S]*?createEvolutionActionGateReceipt/);
  assert.match(main, /function recordHighRiskEvolutionExplicitApproval[\s\S]*?createEvolutionActionGateReceipt/);
  assert.match(main, /function runHighRiskEvolutionPreActionRecheck[\s\S]*?createEvolutionActionGateReceipt/);
  assert.match(main, /function applyHighRiskEvolutionClaimMaturation[\s\S]*?createEvolutionActionGateReceipt/);
  assert.match(main, /function approveAndApplyHighRiskEvolutionIfStillSafe[\s\S]*?action: 'approve_and_apply_if_still_safe'[\s\S]*?action: 'prepare_high_risk_approval_packet'[\s\S]*?recordHighRiskApprovalPacket[\s\S]*?action: 'record_high_risk_explicit_approval'[\s\S]*?recordHighRiskExplicitApproval[\s\S]*?action: 'run_high_risk_pre_action_recheck'[\s\S]*?recordHighRiskPreActionRecheck[\s\S]*?applyHighRiskEvolutionClaimMaturation/);
  assert.match(main, /approve_and_apply_if_still_safe stopped: not applied — no change made/);
  assert.match(main, /No handler execution or protected authority mutation occurred/);
});
