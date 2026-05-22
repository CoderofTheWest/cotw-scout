'use strict';

const crypto = require('crypto');

function analyzeSessionsForScaffoldProposals({
    sessions = [],
    config = {},
    agentId = 'trail-guide',
    scaffoldVersion = '',
    now = new Date().toISOString()
} = {}) {
    const analysisConfig = config.analysis || {};
    const minSessions = numberOr(analysisConfig.minSessionsForPattern, 3);
    const maxPatterns = numberOr(analysisConfig.maxPatternsPerCycle, 5);
    const confidenceThreshold = numberOr(analysisConfig.patternConfidenceThreshold, 0.6);
    const usableSessions = Array.isArray(sessions) ? sessions.filter(Boolean) : [];

    if (usableSessions.length < minSessions) {
        return {
            skipped: true,
            reason: 'insufficient_data',
            sessionCount: usableSessions.length,
            minSessions,
            proposals: []
        };
    }

    const candidates = [
        ...toolFailureProposals(usableSessions, { agentId, scaffoldVersion, now, analysisConfig }),
        ...highToolCallProposals(usableSessions, { agentId, scaffoldVersion, now, analysisConfig }),
        ...correctionSignalProposals(usableSessions, { agentId, scaffoldVersion, now, analysisConfig })
    ];

    const proposals = candidates
        .filter((proposal) => proposal.metadata?.confidence >= confidenceThreshold)
        .sort((a, b) => Number(b.metadata?.confidence || 0) - Number(a.metadata?.confidence || 0))
        .slice(0, maxPatterns);

    return {
        skipped: false,
        reason: null,
        sessionCount: usableSessions.length,
        minSessions,
        proposals
    };
}

function toolFailureProposals(sessions, { agentId, scaffoldVersion, now, analysisConfig }) {
    const minFailures = numberOr(analysisConfig.minToolFailuresForProposal, 2);
    const byTool = new Map();
    for (const session of sessions) {
        const toolCalls = Array.isArray(session.toolCalls) ? session.toolCalls : [];
        for (const call of toolCalls) {
            if (call?.success !== false) continue;
            const toolName = safe(call.toolName || 'unknown_tool', 80);
            if (!toolName) continue;
            const record = byTool.get(toolName) || { toolName, failures: 0, sessions: new Set(), examples: [] };
            record.failures += 1;
            record.sessions.add(session.sessionId || session.startedAt || 'unknown-session');
            if (record.examples.length < 3) record.examples.push(safe(call.resultSummary || call.params || 'failed tool call', 180));
            byTool.set(toolName, record);
        }
    }

    return [...byTool.values()]
        .filter((record) => record.failures >= minFailures)
        .map((record) => {
            const confidence = boundedConfidence(0.5 + (record.failures * 0.1) + (record.sessions.size * 0.05));
            return buildProposalEvent({
                kind: 'repeated_tool_failure',
                className: 'process_ui_friction',
                title: `Scaffold proposal: add guardrails for ${record.toolName}`,
                summary: `${record.failures} failed ${record.toolName} call${record.failures === 1 ? '' : 's'} appeared across ${record.sessions.size} Code mode session${record.sessions.size === 1 ? '' : 's'}. Proposal only: add a tool hint/checkpoint before this tool is used again.`,
                risk: 'low',
                changeType: 'tool_hint',
                target: record.toolName,
                proposedChange: `Before using ${record.toolName}, verify required inputs and narrow the next action to the smallest observable step when prior output indicates an error.`,
                expectedEffect: `Reduce repeated ${record.toolName} failure loops without changing tool authority or runtime configuration.`,
                verification: `Replay or unit-test a fixture with a failing ${record.toolName} call and confirm the scaffold suggests a narrower recovery step.`,
                evidence: {
                    failureCount: record.failures,
                    sessionCount: record.sessions.size,
                    examples: record.examples
                },
                confidence,
                agentId,
                scaffoldVersion,
                now
            });
        });
}

function highToolCallProposals(sessions, { agentId, scaffoldVersion, now, analysisConfig }) {
    const threshold = numberOr(analysisConfig.highToolCallThreshold, 40);
    const highToolSessions = sessions.filter((session) => Array.isArray(session.toolCalls) && session.toolCalls.length >= threshold);
    if (highToolSessions.length === 0) return [];
    const totalToolCalls = highToolSessions.reduce((sum, session) => sum + session.toolCalls.length, 0);
    const confidence = boundedConfidence(0.55 + (highToolSessions.length * 0.12));
    return [buildProposalEvent({
        kind: 'high_tool_call_loop',
        className: 'process_ui_friction',
        title: 'Scaffold proposal: add long-tool-loop checkpoint',
        summary: `${highToolSessions.length} Code mode session${highToolSessions.length === 1 ? '' : 's'} crossed ${threshold} tool calls. Proposal only: add a checkpoint that summarizes receipts and picks the next smallest action before the turn drifts.`,
        risk: 'low',
        changeType: 'workflow_sequence',
        target: 'code-mode-long-tool-loop',
        proposedChange: 'When a Code mode turn crosses the long-tool-call threshold, pause to summarize evidence, name the remaining blocker, and choose one bounded next action before continuing.',
        expectedEffect: 'Reduce tool-call exhaustion and improve post-tool handoff coherence without changing tool limits.',
        verification: 'Run a fixture session above the threshold and confirm a proposal receipt is generated without mutating evolved scaffold files.',
        evidence: {
            threshold,
            sessionCount: highToolSessions.length,
            totalToolCalls
        },
        confidence,
        agentId,
        scaffoldVersion,
        now
    })];
}

function correctionSignalProposals(sessions, { agentId, scaffoldVersion, now, analysisConfig }) {
    const minSignals = numberOr(analysisConfig.minCorrectionSignalsForProposal, 2);
    const signals = [];
    for (const session of sessions) {
        for (const signal of Array.isArray(session.satisfactionSignals) ? session.satisfactionSignals : []) {
            if (!['explicit_negative', 'correction', 'abandonment'].includes(signal?.type)) continue;
            signals.push({
                type: signal.type,
                context: safe(signal.context || '', 180),
                sessionId: session.sessionId || session.startedAt || 'unknown-session'
            });
        }
    }
    if (signals.length < minSignals) return [];
    const uniqueSessions = new Set(signals.map((signal) => signal.sessionId));
    const confidence = boundedConfidence(0.55 + (signals.length * 0.08));
    return [buildProposalEvent({
        kind: 'correction_repair_checkpoint',
        className: 'operational_lesson',
        title: 'Scaffold proposal: add correction repair checkpoint',
        summary: `${signals.length} correction or negative satisfaction signal${signals.length === 1 ? '' : 's'} appeared across ${uniqueSessions.size} Code mode session${uniqueSessions.size === 1 ? '' : 's'}. Proposal only: add a short restatement checkpoint after correction.`,
        risk: 'low',
        changeType: 'prompt_rule',
        target: 'code-mode-correction-repair',
        proposedChange: 'After a correction, briefly restate the corrected constraint and update the active plan before more tool work.',
        expectedEffect: 'Reduce repeated misunderstanding after corrections while keeping the change visible and reversible.',
        verification: 'Run a fixture with correction signals and confirm the proposal is emitted with no prompt injection or scaffold mutation.',
        evidence: {
            signalCount: signals.length,
            sessionCount: uniqueSessions.size,
            examples: signals.slice(0, 3)
        },
        confidence,
        agentId,
        scaffoldVersion,
        now
    })];
}

function buildProposalEvent({
    kind,
    className,
    title,
    summary,
    risk,
    changeType,
    target,
    proposedChange,
    expectedEffect,
    verification,
    evidence,
    confidence,
    agentId,
    scaffoldVersion,
    now
}) {
    const id = `code-evolution-proposal-${hash(`${kind}:${target}`)}`;
    return {
        id,
        class: className,
        title,
        summary,
        status: 'preview',
        risk,
        sourceCategory: 'code-evolution scaffold proposal',
        allowedBy: 'Code Evolution Phase 2 proposal-only loop; no mutation, prompt injection, scheduler linkage, or runtime config change.',
        expectedEffect,
        verification,
        rollback: 'Dismiss or deny this proposal in Evolve. No runtime or scaffold mutation has been applied.',
        action: 'scaffold_proposal',
        receiptId: id,
        metadata: {
            proposalKind: kind,
            changeType,
            target,
            proposedChange,
            evidence,
            confidence: Number(confidence.toFixed(3)),
            agentId,
            scaffoldVersion,
            codeEvolutionPhase: 'proposal_only',
            mutationAttempted: 'false',
            promptInjectionChanged: 'false',
            testPlan: verification,
            rollbackPlan: 'No-op rollback: dismiss the proposal. Promotion is a separate future lane.'
        },
        createdAt: now,
        updatedAt: now
    };
}

function numberOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function boundedConfidence(value) {
    return Math.max(0, Math.min(0.95, value));
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function safe(value, max = 1000) {
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

module.exports = {
    analyzeSessionsForScaffoldProposals
};
