const {
    CLAIM_KINDS,
    FRESHNESS_POLICIES,
    createClaimRecord,
    createDigestClaims,
    validateClaimRecord
} = require('./claim-records');
const { SOURCE_ROLES } = require('./source-handles');

const CANDIDATE_SOURCES = Object.freeze({
    HANDOFF: 'handoff',
    SUMMARY: 'summary',
    DIGEST: 'digest'
});

/**
 * Build 2 claim candidate generation.
 *
 * Runtime-inert: this module creates in-memory candidate envelopes only. It
 * does not persist to ClaimStore, resolve sources, or inject prompt context.
 */
function createClaimCandidates(input = {}, options = {}) {
    const config = options.config || {};
    const candidates = [];
    if (input.handoff && candidateGenerationAllowed(config, CANDIDATE_SOURCES.HANDOFF)) {
        candidates.push(...createHandoffClaimCandidates(input.handoff, options));
    }
    if (input.summary && candidateGenerationAllowed(config, CANDIDATE_SOURCES.SUMMARY)) {
        candidates.push(...createSummaryClaimCandidates(input.summary, options));
    }
    if (input.digest && candidateGenerationAllowed(config, CANDIDATE_SOURCES.DIGEST)) {
        candidates.push(...createDigestClaimCandidates(input.digest, options));
    }
    return summarizeCandidates(candidates, config);
}

function candidateGenerationAllowed(config = {}, source) {
    const sourceConfig = config.sourceAddressableMemory || {};
    const mode = sourceConfig.mode || 'observe';
    if (sourceConfig.enabled === false || mode === 'off') return false;
    if (source === CANDIDATE_SOURCES.HANDOFF) return sourceConfig.createClaimsFromHandoffs === true;
    if (source === CANDIDATE_SOURCES.SUMMARY) return sourceConfig.createClaimsFromSummaries === true;
    if (source === CANDIDATE_SOURCES.DIGEST) return sourceConfig.createClaimsFromDigests === true;
    return false;
}

function shouldPersistClaimCandidates(config = {}) {
    const sourceConfig = config.sourceAddressableMemory || {};
    return sourceConfig.enabled !== false && sourceConfig.mode === 'record' && sourceConfig.persistClaimCandidates === true;
}

function createHandoffClaimCandidates(handoff, options = {}) {
    const content = typeof handoff === 'string' ? handoff : handoff.content;
    if (!content) return [];
    const date = handoff.date || options.date || new Date().toISOString().substring(0, 10);
    const threadId = handoff.threadId || options.threadId || 'main';
    const agentId = handoff.agentId || options.agentId || 'trail-guide';
    const sessionId = handoff.sessionId || options.sessionId || null;
    const now = options.now;
    const sections = parseMarkdownSections(content);
    const candidates = [];

    for (const item of sectionItems(sections, ['Key Points', 'Decisions', 'Completed', 'Current State'])) {
        candidates.push(createCandidate({
            agentId,
            threadId,
            sessionId,
            kind: CLAIM_KINDS.SUMMARY,
            claim: `Handoff note: ${item.text}`,
            source: handoffSource(date, threadId, item.startLine, item.endLine, item.text),
            stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
            metadata: { candidateSource: CANDIDATE_SOURCES.HANDOFF, section: item.section }
        }, { now }));
    }

    for (const item of sectionItems(sections, ['Open Threads', 'Next Steps', 'Next Build Step', 'Blocked'])) {
        candidates.push(createCandidate({
            agentId,
            threadId,
            sessionId,
            kind: CLAIM_KINDS.COMMITMENT,
            claim: `Open thread: ${item.text}`,
            source: handoffSource(date, threadId, item.startLine, item.endLine, item.text),
            stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
            metadata: { candidateSource: CANDIDATE_SOURCES.HANDOFF, section: item.section }
        }, { now }));
    }

    return candidates;
}

function createSummaryClaimCandidates(summary, options = {}) {
    if (!summary) return [];
    const summaryText = summary.summaryText || summary.summary_text || summary.text || summary.content;
    if (!summaryText) return [];
    const agentId = summary.agentId || summary.agent_id || options.agentId || 'trail-guide';
    const threadId = summary.threadId || summary.thread_id || options.threadId || null;
    const sources = summary.sourceHandles || summary.source_handles || summary.metadata?.sourceHandles || [];
    const claim = createCandidate({
        agentId,
        threadId,
        kind: CLAIM_KINDS.SUMMARY,
        claim: `Summary node: ${truncate(summaryText, options.maxSummaryClaimChars || 500)}`,
        sources,
        stalenessPolicy: FRESHNESS_POLICIES.VERIFY_BEFORE_ASSERTING,
        confidence: sources.length ? 0.74 : 0.42,
        metadata: {
            candidateSource: CANDIDATE_SOURCES.SUMMARY,
            summaryId: summary.id || null,
            level: summary.level ?? null,
            dateRangeStart: summary.dateRangeStart || summary.date_range_start || null,
            dateRangeEnd: summary.dateRangeEnd || summary.date_range_end || null,
            candidateOnly: true
        }
    }, { now: options.now });
    return [claim];
}

function createDigestClaimCandidates(digest, options = {}) {
    return createDigestClaims(digest, options).map((claim) => ({
        ...claim,
        metadata: {
            ...(claim.metadata || {}),
            candidateSource: CANDIDATE_SOURCES.DIGEST,
            candidateOnly: true
        }
    }));
}

function summarizeCandidates(candidates, config = {}) {
    const valid = [];
    const invalid = [];
    for (const candidate of candidates) {
        const validation = validateClaimRecord(candidate);
        if (validation.ok) valid.push(candidate);
        else invalid.push({ candidate, errors: validation.errors });
    }
    return {
        candidates: valid,
        invalid,
        candidateCount: valid.length,
        invalidCount: invalid.length,
        persist: shouldPersistClaimCandidates(config),
        action: shouldPersistClaimCandidates(config) ? 'persist_allowed_by_record_mode' : 'observe_only_no_persistence'
    };
}

function createCandidate(input, options = {}) {
    const sources = input.sources || (input.source ? [input.source] : []);
    return createClaimRecord({
        agentId: input.agentId,
        threadId: input.threadId,
        kind: input.kind,
        claim: input.claim,
        sources,
        stalenessPolicy: input.stalenessPolicy,
        confidence: input.confidence,
        metadata: {
            ...(input.metadata || {}),
            sessionId: input.sessionId || undefined,
            candidateOnly: true
        },
        speechGuidance: input.speechGuidance || 'Candidate claim only; do not assert or persist unless later policy explicitly allows it.'
    }, options);
}

function handoffSource(date, threadId, startLine, endLine, excerpt) {
    return {
        handle: `handoff:${date}:${threadId}#L${startLine}-L${endLine}`,
        role: SOURCE_ROLES.ORIGIN,
        excerpt
    };
}

function parseMarkdownSections(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    const sections = [];
    let current = { title: 'Preamble', startLine: 1, lines: [] };
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (heading) {
            current.endLine = index;
            sections.push(current);
            current = { title: heading[2].trim(), startLine: index + 1, lines: [] };
        } else {
            current.lines.push({ text: line, line: index + 1 });
        }
    }
    current.endLine = lines.length;
    sections.push(current);
    return sections.filter((section) => section.title || section.lines.length);
}

function sectionItems(sections, titles) {
    const wanted = new Set(titles.map(normalizeTitle));
    const items = [];
    for (const section of sections) {
        if (!wanted.has(normalizeTitle(section.title))) continue;
        for (const line of section.lines) {
            const text = cleanListItem(line.text);
            if (!text || isWrapperNoiseItem(text)) continue;
            items.push({ section: section.title, text, startLine: line.line, endLine: line.line });
        }
    }
    return items;
}

function cleanListItem(value) {
    return String(value || '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .trim();
}

function isWrapperNoiseItem(value) {
    const text = String(value || '').toLowerCase();
    return [
        '[queued user message that arrived while the previous turn was still active]',
        '[your working memory]',
        '[relationship context]',
        '[declared]',
        '[praxis.md',
        '[active contemplations',
        '[your coherence]',
        '[patterns you\'re developing]',
        '[guide posture',
        '[tool provenance]',
        '[where they stand',
        '[report due]',
        '[chat messages since',
        'your process:',
        'you remember these exchanges',
        'current time:',
        'session:',
        'lifetime:',
        'first conversation:',
        'recent:'
    ].some((marker) => text.includes(marker));
}

function normalizeTitle(value) {
    return String(value || '').trim().toLowerCase();
}

function truncate(text, maxChars) {
    const value = String(text || '').trim();
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

module.exports = {
    CANDIDATE_SOURCES,
    createClaimCandidates,
    candidateGenerationAllowed,
    shouldPersistClaimCandidates,
    createHandoffClaimCandidates,
    createSummaryClaimCandidates,
    createDigestClaimCandidates,
    parseMarkdownSections
};
