const assert = require('node:assert/strict');
const test = require('node:test');

const {
  analyzeSessionsForScaffoldProposals
} = require('../bundled-plugins/openclaw-plugin-code-evolution/lib/scaffoldProposalAnalyzer');

const config = {
  analysis: {
    minSessionsForPattern: 2,
    patternConfidenceThreshold: 0.6,
    maxPatternsPerCycle: 5,
    minToolFailuresForProposal: 2,
    highToolCallThreshold: 4,
    minCorrectionSignalsForProposal: 2
  }
};

function session(id, overrides = {}) {
  return {
    sessionId: id,
    agentId: 'trail-guide',
    startedAt: `2026-05-21T10:0${id}:00.000Z`,
    toolCalls: [],
    satisfactionSignals: [],
    scaffoldVersion: 'abc123',
    outcome: 'completed',
    ...overrides
  };
}

test('code evolution analyzer emits tool-hint proposals for repeated tool failures', () => {
  const result = analyzeSessionsForScaffoldProposals({
    sessions: [
      session('1', { toolCalls: [{ toolName: 'exec', success: false, resultSummary: 'command failed' }] }),
      session('2', { toolCalls: [{ toolName: 'exec', success: false, resultSummary: 'enoent' }] })
    ],
    config,
    now: '2026-05-21T10:00:00.000Z'
  });

  assert.equal(result.skipped, false);
  const proposal = result.proposals.find((entry) => entry.metadata.proposalKind === 'repeated_tool_failure');
  assert.ok(proposal);
  assert.equal(proposal.action, 'scaffold_proposal');
  assert.equal(proposal.status, 'preview');
  assert.equal(proposal.metadata.changeType, 'tool_hint');
  assert.equal(proposal.metadata.mutationAttempted, 'false');
  assert.match(proposal.allowedBy, /proposal-only/);
});

test('code evolution analyzer emits long-tool-loop workflow proposals', () => {
  const result = analyzeSessionsForScaffoldProposals({
    sessions: [
      session('1', { toolCalls: Array.from({ length: 4 }, (_, idx) => ({ toolName: `tool-${idx}`, success: true })) }),
      session('2', { toolCalls: [{ toolName: 'read', success: true }] })
    ],
    config,
    now: '2026-05-21T10:00:00.000Z'
  });

  const proposal = result.proposals.find((entry) => entry.metadata.proposalKind === 'high_tool_call_loop');
  assert.ok(proposal);
  assert.equal(proposal.metadata.changeType, 'workflow_sequence');
  assert.match(proposal.summary, /crossed 4 tool calls/);
});

test('code evolution analyzer emits correction repair checkpoint proposals', () => {
  const result = analyzeSessionsForScaffoldProposals({
    sessions: [
      session('1', { satisfactionSignals: [{ type: 'correction', context: 'actually I meant the other file' }] }),
      session('2', { satisfactionSignals: [{ type: 'explicit_negative', context: 'that is not right' }] })
    ],
    config,
    now: '2026-05-21T10:00:00.000Z'
  });

  const proposal = result.proposals.find((entry) => entry.metadata.proposalKind === 'correction_repair_checkpoint');
  assert.ok(proposal);
  assert.equal(proposal.class, 'operational_lesson');
  assert.equal(proposal.metadata.changeType, 'prompt_rule');
  assert.match(proposal.rollback, /No runtime or scaffold mutation/);
});

test('code evolution analyzer skips when session evidence is below threshold', () => {
  const result = analyzeSessionsForScaffoldProposals({
    sessions: [session('1')],
    config,
    now: '2026-05-21T10:00:00.000Z'
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'insufficient_data');
  assert.equal(result.proposals.length, 0);
});
