const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const mainPath = path.join(repoRoot, 'main.js');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const openAiHttpPath = path.join(repoRoot, 'node_modules', 'openclaw', 'dist', fs.readdirSync(path.join(repoRoot, 'node_modules', 'openclaw', 'dist')).find(name => /^openai-http-.*\.js$/.test(name)));
const openAiHttpSource = fs.readFileSync(openAiHttpPath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `expected ${name} to exist`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not extract ${name}`);
}

test('GUI chat image attachments use native image parts for non-Ollama providers', () => {
  const context = { String, Array };
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction(mainSource, 'normalizeGatewayImageAttachment')}
    ${extractFunction(mainSource, 'buildOpenAiUserContent')}
    this.buildOpenAiUserContent = buildOpenAiUserContent;
  `, context);

  const content = context.buildOpenAiUserContent('What do you see?', [
    { base64: 'abc123', mimeType: 'image/png' },
    { base64: '', mimeType: 'image/jpeg' },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(content)), [
    { type: 'text', text: 'What do you see?' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
  ]);
  assert.doesNotMatch(mainSource, /processVision\(image\.base64\)/);
});

test('Ollama image routing uses a configured image-capable model instead of the GLM text lane', () => {
  const context = { String, Array, Error };
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction(mainSource, 'modelSupportsImageInput')}
    ${extractFunction(mainSource, 'getModelConfigKey')}
    ${extractFunction(mainSource, 'findConfiguredOllamaVisionModel')}
    this.findConfiguredOllamaVisionModel = findConfiguredOllamaVisionModel;
  `, context);

  const runtimeConfig = {
    models: {
      providers: {
        ollama: {
          models: [
            { id: 'glm-5:cloud', input: ['text'] },
            { id: 'qwen3.5:cloud', input: ['text', 'image'] },
          ],
        },
      },
    },
  };

  assert.equal(context.findConfiguredOllamaVisionModel(runtimeConfig), 'qwen3.5:cloud');
  assert.throws(
    () => context.findConfiguredOllamaVisionModel({ models: { providers: { ollama: { models: [{ id: 'glm-5:cloud', input: ['text'] }] } } } }),
    /No Ollama vision model is configured/
  );
  assert.match(mainSource, /prepareGatewayImageInput\(text, attachedImages\)/);
  assert.match(mainSource, /processOllamaVision\(image\.base64/);
  assert.doesNotMatch(mainSource, /model:\s*['"]qwen3\.5:cloud['"]/);
});

test('bundled Ollama config preserves separate text and vision model declarations', () => {
  for (const rel of ['openclaw.json', 'bundled-openclaw/openclaw.json']) {
    const template = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    assert.match(template, /"id": "glm-5:cloud"[\s\S]*?"input": \["text"\]/, rel);
    assert.match(template, /"id": "qwen3\.5:cloud"[\s\S]*?"input": \["text", "image"\]/, rel);
  }
});

test('OpenAI-compatible gateway stream bridges OpenClaw tool events for GUI tool counts', () => {
  assert.match(openAiHttpSource, /function writeOpenClawAgentEventChunk\(res, params\)/);
  assert.match(openAiHttpSource, /openclaw_event: params\.event/);
  assert.match(openAiHttpSource, /evt\.stream === "tool" \|\| evt\.stream === "item" \|\| evt\.stream === "command_output" \|\| evt\.stream === "patch" \|\| evt\.stream === "recovery"/);
  assert.match(openAiHttpSource, /evt\.stream\.endsWith\("\.item"\)/);

  assert.match(mainSource, /const openclawEvent = parsed\.openclaw_event \|\| parsed\.openclawEvent/);
  assert.match(mainSource, /stream === 'command_output'/);
  assert.match(mainSource, /const isRecoveryLike = stream === 'recovery' \|\| kind === 'recovery'/);
  assert.match(mainSource, /mid-turn-recovery-event/);
  assert.match(mainSource, /recovery: true/);
  assert.match(mainSource, /stream\.endsWith\('\.item'\)/);
  assert.match(mainSource, /const isDuplicateStart = activeGatewayToolCalls\.has\(toolCallId\)/);
  assert.match(mainSource, /status: 'observed'/);
  assert.match(mainSource, /const toolArgs = eventData\.args \|\| eventData\.meta \|\| eventData\.command \|\| eventData\.query/);
  assert.match(mainSource, /recordObservedRuntimeToolPreflight\(name, toolArgs, `openclaw_event:\$\{stream\}`, toolCallId\)/);
  assert.match(mainSource, /mainWindow\?\.webContents\.send\('chat:tool-call', \{ name, args: toolArgs, status: 'start' \}\)/);
  assert.match(mainSource, /mainWindow\?\.webContents\.send\('chat:tool-call', \{ name: completedName, status: 'done' \}\)/);
});

test('local OpenClaw patch script preserves the tool-event stream bridge across installs', () => {
  const patchScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'apply-openclaw-local-patches.js'), 'utf8');
  assert.match(patchScript, /applyOpenAiHttpToolEventPatch/);
  assert.match(patchScript, /openclaw_event: params\.event/);
  assert.match(patchScript, /evt\.stream === "recovery"/);
  assert.match(patchScript, /findOpenAiHttpFile/);
});

test('live chat turns produce append-only outcome ledger packets without new authority', () => {
  const context = { String, Array, Set, Number, Math, Error };
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction(mainSource, 'stableToolList')}
    ${extractFunction(mainSource, 'buildCompletionObligationPacket')}
    ${extractFunction(mainSource, 'buildLiveTurnOutcomeInput')}
    ${extractFunction(mainSource, 'buildLiveTurnContextEligibilityReviewInput')}
    ${extractFunction(mainSource, 'buildReadOnlyResponsibilityLeaseInput')}
    this.buildLiveTurnOutcomeInput = buildLiveTurnOutcomeInput;
    this.buildLiveTurnContextEligibilityReviewInput = buildLiveTurnContextEligibilityReviewInput;
    this.buildReadOnlyResponsibilityLeaseInput = buildReadOnlyResponsibilityLeaseInput;
  `, context);

  const packet = context.buildLiveTurnOutcomeInput({
    requestId: 'stream_test_123',
    message: 'please check this',
    response: 'done',
    toolEvents: [
      { name: 'read', source: 'openclaw_event', phase: 'start' },
      { name: 'read', source: 'openclaw_event', phase: 'done' },
      { name: 'write', source: 'openai_delta', phase: 'start' },
    ],
    imageCount: 1,
    mode: 'chat',
    startedAt: 1000,
    completedAt: 1550,
    seenDataEvents: 4,
    reconciled: false,
    threadId: 'session_abc',
    sessionId: 'session_main',
    exchangeId: 'ex_test',
    turnId: 'turn_test',
    runId: 'run_test',
  });

  assert.equal(packet.eventId, 'live_turn:stream_test_123');
  assert.equal(packet.eventType, 'live_turn_outcome');
  assert.equal(packet.authority.authorizationMode, 'current_user_instruction');
  assert.deepEqual(JSON.parse(JSON.stringify(packet.action.toolsUsed)), ['read', 'write']);
  assert.equal(packet.action.toolCount, 2);
  assert.equal(packet.source.exchangeId, 'ex_test');
  assert.equal(packet.action.exchangeId, 'ex_test');
  assert.equal(packet.observed.runId, 'run_test');
  assert.equal(packet.observed.durationMs, 550);
  assert.equal(packet.observed.completionObligation.required, true);
  assert.deepEqual(JSON.parse(JSON.stringify(packet.observed.completionObligation.reasonCodes)), ['foreground_tool_use']);
  assert.equal(packet.observed.completionObligation.resolution, 'visible_final_response');
  assert.equal(packet.verification.method, 'gateway_stream_completed');
  assert.equal(packet.rollback.available, false);
  assert.equal(packet.learning.eligibleForMaturation, false);

  const review = context.buildLiveTurnContextEligibilityReviewInput(packet);
  assert.equal(review.reviewId, 'context-eligibility:live_turn:live_turn:stream_test_123');
  assert.equal(review.requestedConsumer, 'context_injection');
  assert.equal(review.authority.hasExplicitContextApproval, false);
  assert.deepEqual(JSON.parse(JSON.stringify(review.reasonCodes)), ['live_turn_shadow_filter']);
  const lease = context.buildReadOnlyResponsibilityLeaseInput({
    leaseId: 'responsibility-lease:test:1',
    lane: 'contemplation',
    trigger: 'CONTEMPLATION_DUE.md',
    objective: 'Run due contemplation passes in an isolated thread from an existing signal',
  });
  assert.equal(lease.lifecycle?.status || lease.status, 'candidate');
  assert.equal(lease.authority.sourceType, 'system_signal');
  assert.deepEqual(JSON.parse(JSON.stringify(lease.authority.allowedActions)), []);
  assert.match(JSON.stringify(lease.authority.prohibitedActions), /prompt_context_injection/);
  assert.match(JSON.stringify(lease.nonGoals), /grant authority/);

  assert.match(mainSource, /appendOutcomeEventPacket\(ledgerPath, packetInput/);
  assert.match(mainSource, /appendContextEligibilityReview\(/);
  assert.match(mainSource, /appendResponsibilityLeasePacket\(/);
});
