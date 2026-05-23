const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(repoRoot, 'main.js'), 'utf8');
const guiPath = fs.existsSync(path.join(repoRoot, 'cotw-trail-guide-gui.html'))
  ? path.join(repoRoot, 'cotw-trail-guide-gui.html')
  : path.join(repoRoot, 'cotw-scout-gui.html');
const guiSource = fs.readFileSync(guiPath, 'utf8');
const preloadSource = fs.readFileSync(path.join(repoRoot, 'preload.js'), 'utf8');

test('runtime creates an honest visible fallback when foreground tool work has no post-tool handoff', () => {
  assert.match(mainSource, /function buildForegroundCompletionFallback\(toolEvents = \[\], recoveryAttempt = null\)/);
  assert.match(mainSource, /renderRecoveryFallbackDetails\(recoveryAttempt\)/);
  assert.match(mainSource, /I used tools, but the turn ended before I gave you a final answer/);
  assert.match(mainSource, /I’m not going to pretend that’s complete/);
  assert.match(mainSource, /let contentLengthAtLastToolActivity = null/);
  assert.match(mainSource, /contentLengthAtLastToolActivity = fullContent\.length/);
  assert.match(mainSource, /const postToolContent = contentLengthAtLastToolActivity === null/);
  assert.match(mainSource, /if \(sawToolCall && !postToolContent\.trim\(\) && options\.disableEvidenceRecovery\) \{/);
  assert.match(mainSource, /runRecoveryStep\(\{/);
  assert.match(mainSource, /observedToolEvents\.map\(observationFromToolEvent\)/);
  assert.match(mainSource, /continueAfterEvidenceRecovery\(\{/);
  assert.match(mainSource, /phase: 'evidence_gate_blocked_final'/);
  assert.match(mainSource, /completionObligationFallback = true/);
  assert.match(mainSource, /emitChatActivity\(\{ phase: 'completion-obligation-fallback'/);
});

test('runtime executes a bounded evidence recovery continuation before using fallback', () => {
  assert.match(mainSource, /function buildEvidenceRecoveryContinuationPrompt/);
  assert.match(mainSource, /function continueAfterEvidenceRecovery/);
  assert.match(mainSource, /internalOnly: true/);
  assert.match(mainSource, /disableEvidenceRecovery: true/);
  assert.match(mainSource, /workScope: packet\.workScope/);
  assert.match(mainSource, /principleBinding: packet\.principleBinding/);
  assert.match(mainSource, /resume the original scoped user task/);
  assert.match(mainSource, /do not run arbitrary shell commands from recovery/);
  assert.match(mainSource, /I used tools, but the turn ended before I gave you a final answer/);
  assert.match(mainSource, /source: 'evidence_recovery_gate'/);
  assert.match(mainSource, /phase: 'evidence_recovery_action'/);
  assert.match(mainSource, /if \(recoveredContent && recoveredContent\.trim\(\)\) \{/);
  assert.match(mainSource, /completionObligationFallback = false/);
});

test('runtime starts a visible continuation after a tool fallback reaches the GUI', () => {
  assert.match(mainSource, /function isForegroundCompletionFallbackText\(text\)/);
  assert.match(mainSource, /function buildVisibleToolFallbackContinuationPrompt/);
  assert.match(mainSource, /VISIBLE TOOL FALLBACK CONTINUATION/);
  assert.match(mainSource, /chat:auto-continuation-start/);
  assert.match(mainSource, /synthetic_source: 'visible_tool_fallback_continuation'/);
  assert.match(mainSource, /if \(continued && !isForegroundCompletionFallbackText\(continued\)\) \{/);
  assert.match(preloadSource, /onAutoContinuationStart/);
  assert.match(preloadSource, /chat:auto-continuation-start/);
  assert.match(guiSource, /onAutoContinuationStart/);
  assert.match(guiSource, /Continuing from tool work/);
});

test('runtime sends and records completion obligation metadata for toolful turns', () => {
  assert.match(mainSource, /function buildCompletionObligationPacket/);
  assert.match(mainSource, /reasonCodes: sawToolCall \? \['foreground_tool_use'\] : \[\]/);
  assert.match(mainSource, /resolution: sawToolCall\s*\? \(completionObligationFallback \? 'blocked_response' : 'visible_final_response'\)/);
  assert.match(mainSource, /completionObligation,/);
  assert.match(mainSource, /chat:stream-done', \{ content: fullContent, requestId, exchangeId: exchangeContext\.exchangeId, turnId: exchangeContext\.turnId, reconciled: streamReconciled, completionObligation \}/);
  assert.match(mainSource, /completionObligation: obligation/);
});

test('GUI tail-anchors final closure when tool cards would bury streamed text', () => {
  assert.match(guiSource, /let currentTurnHadToolActivity = false/);
  assert.match(guiSource, /let currentTurnFinalizedDraftBeforeTool = false/);
  assert.match(guiSource, /let currentTurnFinalizedDraftText = ''/);
  assert.match(guiSource, /function finalTailAfterVisibleDraft\(finalText, visibleDraftText\)/);
  assert.match(guiSource, /currentTurnFinalizedDraftText = prepareAssistantDisplayText\(streamingRawText\)/);
  assert.match(guiSource, /currentTurnFinalizedDraftBeforeTool = true/);
  assert.match(guiSource, /else if \(displayText && currentTurnHadToolActivity && currentTurnFinalizedDraftBeforeTool\) \{/);
  assert.match(guiSource, /const tailText = finalTailAfterVisibleDraft\(displayText, currentTurnFinalizedDraftText\)/);
  assert.match(guiSource, /const tailEl = addTrailGuideMessage\(tailText\)/);
  assert.match(guiSource, /attachProcessTrail\(tailEl, 'done'\)/);
  assert.match(guiSource, /resetTurnCompletionState\(\)/);
});
