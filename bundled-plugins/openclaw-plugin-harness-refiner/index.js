'use strict';

const fs = require('fs');
const path = require('path');
const { instrumentApiHooks } = require('../lib/runtime-metrics');
const { buildCognitiveSnapshot } = require('./lib/cognitive-snapshot');
const { analyzeTrajectoryWindows } = require('./lib/analyzer');
const { exportResearchBundle } = require('./lib/research-bundle-export');
const { appendResearchArtifact, createResearchLedger, readResearchArtifacts } = require('./lib/research-ledger');
const { buildTeacherRelabelReceipt } = require('./lib/relabel-packets');
const { runScenarioReplay } = require('./lib/scenario-replay');
const { buildHoldoutManifest } = require('./lib/holdout-split');
const { buildShardManifest, writeSealedShardManifest } = require('./lib/shard-integrity');
const { readJsonl, resolveBaseDataDir, writeAnalysisArtifacts, writeJsonl } = require('./lib/storage');
const { buildTeacherRepairQualityReceipt } = require('./lib/teacher-repair-quality');

let evolutionLedger = null;
try {
  evolutionLedger = require('../../lib/evolution-ledger');
} catch {
  evolutionLedger = null;
}

function loadConfig(userConfig = {}) {
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  return deepMerge(defaultConfig, userConfig);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function resolveWorkspacePath(ctx) {
  return ctx?.workspaceDir || ctx?.workspacePath || process.env.OPENCLAW_WORKSPACE || null;
}

function resolveContinuityEvolutionDataDir() {
  return path.resolve(__dirname, '..', 'openclaw-plugin-continuity', 'data');
}

function normalizeGatewayParams(input) {
  return input?.params || input || {};
}

function isErrorResult(result) {
  const lower = String(typeof result === 'string' ? result : JSON.stringify(result || '')).toLowerCase();
  return !lower || lower.includes('error') || lower.includes('failed') || lower.includes('enoent') || lower.includes('permission denied') || lower.includes('syntaxerror') || lower.includes('typeerror');
}

module.exports = {
  id: 'harness-refiner',
  name: 'Harness Refiner',

  configSchema: {
    jsonSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        recording: { type: 'object' },
        analysis: { type: 'object' },
        detectors: { type: 'object' },
        cognitive: { type: 'object' },
        training: { type: 'object' },
        teacher: { type: 'object' },
        nightshift: { type: 'object' },
        research: { type: 'object' },
        storage: { type: 'object' }
      }
    }
  },

  register(api) {
    api = instrumentApiHooks(api, 'harness-refiner');
    const config = loadConfig(api.pluginConfig || {});
    if (!config.enabled) {
      api.logger.info('[HarnessRefiner] Plugin disabled via config');
      return;
    }

    const baseDataDir = resolveBaseDataDir(__dirname, config);
    const windowsPath = path.join(baseDataDir, 'windows.jsonl');
    const activeToolCalls = new Map();
    let lastAnalysis = null;

    function appendWindow(window) {
      writeJsonl(windowsPath, [window]);
      pruneWindows();
    }

    function getRecentWindows(limit = 30) {
      const windows = readJsonl(windowsPath);
      return windows.slice(-Math.max(1, Number(limit) || 30));
    }

    function pruneWindows() {
      const max = Number(config.recording?.maxWindows || 200);
      const windows = readJsonl(windowsPath);
      if (windows.length <= max) return;
      fs.writeFileSync(windowsPath, windows.slice(-max).map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    }

    function runAnalysis({ agentId = 'trail-guide', windows = null, ctx = null, experimentId = null, now = new Date().toISOString(), modelOrAdapterHash = '' } = {}) {
      const selectedWindows = Array.isArray(windows) ? windows : getRecentWindows(config.recording?.maxWindows || 200);
      const result = analyzeTrajectoryWindows({
        windows: selectedWindows,
        config,
        agentId,
        scaffoldVersion: global.__ocCodeEvolution?.getScaffoldVersion?.() || '',
        experimentId: experimentId || `${config.research?.defaultExperimentPrefix || 'harness-refiner'}-${now.slice(0, 10)}`,
        modelOrAdapterHash,
        now
      });

      const analysisDir = writeAnalysisArtifacts(baseDataDir, result);
      const researchLedger = createResearchLedger({
        dataDir: baseDataDir,
        experimentId: experimentId || `${config.research?.defaultExperimentPrefix || 'harness-refiner'}-${now.slice(0, 10)}`,
        now
      });
      for (const digest of result.digests) appendResearchArtifact(researchLedger, digest);

      let recorded = 0;
      let ledger = 'unavailable';
      if (evolutionLedger && result.proposals.length > 0) {
        const workspacePath = resolveWorkspacePath(ctx);
        const ledgerPath = workspacePath
          ? evolutionLedger.resolveEvolutionLedgerPath({ workspacePath })
          : evolutionLedger.resolveEvolutionLedgerPath({ pluginDataDir: resolveContinuityEvolutionDataDir(), agentId });
        for (const proposal of result.proposals) {
          evolutionLedger.appendEvolutionEvent(ledgerPath, proposal, { now });
          recorded += 1;
        }
        ledger = workspacePath ? 'workspace' : 'continuity-plugin-data';
      }

      lastAnalysis = {
        ...summarizeAnalysis(result),
        recorded,
        ledger,
        analysisDir,
        experimentId: researchLedger.experimentId,
        generatedAt: now
      };
      return { ...result, recorded, ledger, analysisDir, experimentId: researchLedger.experimentId };
    }

    function getDigest(params = {}) {
      const ledger = createResearchLedger({
        dataDir: baseDataDir,
        experimentId: params.experimentId || `${config.research?.defaultExperimentPrefix || 'harness-refiner'}-${new Date().toISOString().slice(0, 10)}`
      });
      const artifacts = readResearchArtifacts(ledger.ledgerPath, {
        experimentId: params.experimentId,
        clusterId: params.clusterId,
        type: 'research_digest'
      });
      return {
        experimentId: params.experimentId || ledger.experimentId,
        digests: artifacts.slice(-(params.limit || 20))
      };
    }

    function createTeacherRelabel(params = {}) {
      const teacherRepair = String(params.teacherRepair || '').trim();
      if (!teacherRepair) {
        return {
          ok: false,
          error: 'teacherRepair is required',
          trainingLaunchAuthorized: false,
          adapterPromotionAuthorized: false
        };
      }

      const candidatePacket = resolveRelabelCandidate(params);
      if (!candidatePacket) {
        return {
          ok: false,
          error: 'relabel candidate not found',
          trainingLaunchAuthorized: false,
          adapterPromotionAuthorized: false
        };
      }

      const now = new Date().toISOString();
      const sourceWindow = resolveWindowForCandidate(candidatePacket);
      const qualityGate = sourceWindow
        ? buildTeacherRepairQualityReceipt({
            window: sourceWindow,
            candidatePacket,
            teacherRepair,
            scorerVersion: config.training?.scorerVersion || candidatePacket.scorerVersion || 'harness-refiner-prm-heuristic-v1',
            now
          })
        : {
            accepted: false,
            status: 'rejected',
            exclusionReason: 'source_window_not_found',
            originalAggregate: candidatePacket.aggregate ?? null,
            teacherAggregate: null,
            perAxisDelta: {},
            repairLengthDelta: null
          };
      const receipt = {
        ...buildTeacherRelabelReceipt({
          candidatePacket,
          teacherRepair,
          teacherModel: params.teacherModel || 'teacher-model-unset',
          includeInShard: params.includeInShard === true,
          qualityGate,
          now
        }),
        experimentId: params.experimentId || lastAnalysis?.experimentId || `${config.research?.defaultExperimentPrefix || 'harness-refiner'}-${now.slice(0, 10)}`
      };

      const relabelPath = path.join(baseDataDir, 'analysis', 'teacher-relabels.jsonl');
      const qualityPath = path.join(baseDataDir, 'analysis', 'teacher-repair-quality.jsonl');
      writeJsonl(qualityPath, [qualityGate]);
      writeJsonl(relabelPath, [receipt]);
      const researchLedger = createResearchLedger({ dataDir: baseDataDir, experimentId: receipt.experimentId, now });
      appendResearchArtifact(researchLedger, qualityGate);
      appendResearchArtifact(researchLedger, receipt);
      return {
        ok: true,
        receipt,
        qualityGate,
        relabelPath,
        qualityPath,
        trainingLaunchAuthorized: false,
        adapterPromotionAuthorized: false
      };
    }

    function resolveRelabelCandidate(params = {}) {
      if (params.candidatePacket && typeof params.candidatePacket === 'object') return params.candidatePacket;
      const candidateId = params.candidatePacketId || params.packetId || params.id;
      if (!candidateId) return null;
      const candidates = readJsonl(path.join(baseDataDir, 'analysis', 'relabel-candidates.jsonl'));
      return candidates.find((candidate) => candidate.id === candidateId || candidate.packetId === candidateId) || null;
    }

    function resolveWindowForCandidate(candidatePacket = {}) {
      if (candidatePacket.window && typeof candidatePacket.window === 'object') return candidatePacket.window;
      const windows = readJsonl(path.join(baseDataDir, 'analysis', 'windows.jsonl'));
      return windows.find((window) => window.id === candidatePacket.windowId) || null;
    }

    function sealShard(params = {}) {
      const now = new Date().toISOString();
      const windows = readJsonl(path.join(baseDataDir, 'analysis', 'windows.jsonl'));
      const scoreReceipts = readJsonl(path.join(baseDataDir, 'analysis', 'scores.jsonl'));
      const candidatePackets = readJsonl(path.join(baseDataDir, 'analysis', 'relabel-candidates.jsonl'));
      const relabelReceipts = readJsonl(path.join(baseDataDir, 'analysis', 'teacher-relabels.jsonl'));
      const holdoutManifest = params.holdoutManifest || buildHoldoutManifest({
        windows,
        candidatePackets,
        relabelReceipts,
        seed: params.holdoutSeed || 'cotw-holdout-v1',
        ratios: params.holdoutRatios,
        now
      });
      const manifest = buildShardManifest({
        shardId: params.shardId,
        relabelReceipts,
        candidatePackets,
        windows,
        scoreReceipts,
        holdoutManifest,
        qualityGate: {
          ...(config.training?.shardQualityGate || {}),
          ...(params.qualityGate || {})
        },
        now
      });
      if (!manifest.qualityGate.passed) {
        return {
          ok: false,
          readOnly: true,
          reason: 'shard_quality_gate_failed',
          manifest,
          trainingApproval: false,
          adapterPromotionAuthorized: false
        };
      }
      const shardDir = path.join(baseDataDir, 'shards');
      const shardFile = path.join(shardDir, `${safeShardFileName(manifest.shardId)}.manifest.json`);
      writeSealedShardManifest(shardFile, manifest);
      const researchLedger = createResearchLedger({
        dataDir: baseDataDir,
        experimentId: params.experimentId || lastAnalysis?.experimentId || `${config.research?.defaultExperimentPrefix || 'harness-refiner'}-${now.slice(0, 10)}`,
        now
      });
      appendResearchArtifact(researchLedger, manifest);
      return {
        ok: true,
        manifest,
        manifestPath: shardFile,
        trainingApproval: false,
        adapterPromotionAuthorized: false
      };
    }

    api.on('after_tool_call', (event, ctx) => {
      const agentId = ctx?.agentId || 'main';
      const calls = activeToolCalls.get(agentId) || [];
      if (calls.length < Number(config.recording?.maxToolCallsPerWindow || 200)) {
        const result = event.result || event.toolResult || '';
        calls.push({
          toolName: event.toolName || event.name || 'unknown_tool',
          params: event.params || event.toolParams || {},
          result,
          success: !isErrorResult(result),
          timestamp: new Date().toISOString()
        });
      }
      activeToolCalls.set(agentId, calls);
      return {};
    }, { priority: 30 });

    api.on('agent_end', async (event, ctx) => {
      const agentId = ctx?.agentId || 'main';
      const metadata = event.metadata || {};
      const exchangeId = metadata.exchangeId || metadata.exchange_id || '';
      const turnId = metadata.turnId || metadata.turn_id || '';
      const runId = metadata.runId || metadata.run_id || '';
      const cognitiveSnapshot = buildCognitiveSnapshot({
        api,
        agentId,
        includeRawLatent: config.cognitive?.includeRawLatents === true
      });
      appendWindow({
        agentId,
        scope: 'current_task',
        triggerEvent: 'agent_end',
        messages: event.messages || [],
        toolCalls: activeToolCalls.get(agentId) || [],
        cognitiveSnapshot,
        mode: metadata.mode || (metadata.codeMode ? 'code' : ''),
        sessionId: metadata.sessionId || metadata.session_id || '',
        threadId: metadata.threadId || metadata.thread_id || '',
        exchangeIds: exchangeId ? [exchangeId] : [],
        traceRefs: metadata.traceRefs || metadata.trace_refs || [],
        sourceHandles: metadata.sourceHandles || metadata.receiptHandles || metadata.source_handles || metadata.receipt_handles || [],
        metadata: {
          scaffoldHash: global.__ocCodeEvolution?.getScaffoldVersion?.() || '',
          modelOrAdapterHash: metadata.model || metadata.modelOrAdapterHash || metadata.model_or_adapter_hash || '',
          codeMode: metadata.codeMode === true,
          exchangeId,
          turnId,
          runId
        },
        createdAt: new Date().toISOString()
      });
      activeToolCalls.delete(agentId);
    });

    const harnessRefinerApi = {
      analyzeTrajectoryWindows: runAnalysis,
      getRecentWindows,
      getState: () => ({
        enabled: true,
        baseDataDir,
        windowCount: readJsonl(windowsPath).length,
        relabelCandidateCount: readJsonl(path.join(baseDataDir, 'analysis', 'relabel-candidates.jsonl')).length,
        teacherRelabelCount: readJsonl(path.join(baseDataDir, 'analysis', 'teacher-relabels.jsonl')).length,
        lastAnalysis
      }),
      getResearchDigest: getDigest,
      createTeacherRelabel
    };

    api.harnessRefiner = harnessRefinerApi;
    global.__ocHarnessRefiner = harnessRefinerApi;

    if (api.registerGatewayMethod) {
      api.registerGatewayMethod('harness-refiner.getState', async () => harnessRefinerApi.getState());

      api.registerGatewayMethod('harness-refiner.trigger', async (input) => {
        const params = normalizeGatewayParams(input);
        const result = runAnalysis({
          agentId: params.agentId || 'trail-guide',
          windows: params.windows || null,
          ctx: params.ctx || null,
          experimentId: params.experimentId || null,
          modelOrAdapterHash: params.modelOrAdapterHash || ''
        });
        return {
          message: result.skipped
            ? `Harness Refiner skipped: ${result.reason}.`
            : `Harness Refiner analyzed ${result.windowCount} window(s), recorded ${result.recorded} proposal receipt(s), and wrote ${result.digests.length} research digest(s).`,
          ...summarizeAnalysis(result),
          recorded: result.recorded,
          ledger: result.ledger,
          experimentId: result.experimentId
        };
      });

      api.registerGatewayMethod('harness-refiner.getResearchDigest', async (input) => {
        return getDigest(normalizeGatewayParams(input));
      });

      api.registerGatewayMethod('harness-refiner.exportResearchBundle', async (input) => {
        const params = normalizeGatewayParams(input);
        if (config.research?.bundleExportEnabled === false) throw new Error('research bundle export is disabled');
        const digestResult = getDigest(params);
        return exportResearchBundle({
          dataDir: baseDataDir,
          experimentId: params.experimentId || digestResult.experimentId,
          reviewerNotes: params.reviewerNotes || '',
          artifacts: {
            digests: digestResult.digests,
            windows: readJsonl(path.join(baseDataDir, 'analysis', 'windows.jsonl')),
            proposals: readJsonl(path.join(baseDataDir, 'analysis', 'proposals.jsonl')),
            scores: readJsonl(path.join(baseDataDir, 'analysis', 'scores.jsonl')),
            relabelCandidates: readJsonl(path.join(baseDataDir, 'analysis', 'relabel-candidates.jsonl')),
            teacherRelabels: readJsonl(path.join(baseDataDir, 'analysis', 'teacher-relabels.jsonl')),
            healthReceipts: [],
            replays: []
          }
        });
      });

      api.registerGatewayMethod('harness-refiner.createTeacherRelabel', async (input) => {
        return createTeacherRelabel(normalizeGatewayParams(input));
      });

      api.registerGatewayMethod('harness-refiner.sealShard', async (input) => {
        return sealShard(normalizeGatewayParams(input));
      });

      api.registerGatewayMethod('harness-refiner.runScenarioReplay', async () => {
        return {
          readOnly: true,
          trainingLaunchAuthorized: false,
          results: runScenarioReplay({ config })
        };
      });
    }

    if (global.__ocNightshift?.registerTaskRunner) {
      global.__ocNightshift.registerTaskRunner(config.nightshift?.taskType || 'harness-refiner', async (task, ctx) => {
        const agentId = task.agentId || ctx?.agentId || 'main';
        const windows = getRecentWindows(config.recording?.maxWindows || 200);
        if (windows.length < Number(config.analysis?.minWindowsForNightshift || 1)) {
          return { skipped: true, reason: 'insufficient_windows', windowCount: windows.length };
        }
        const result = runAnalysis({
          agentId,
          windows,
          ctx,
          experimentId: task.experimentId || null
        });
        return {
          ...summarizeAnalysis(result),
          recorded: result.recorded,
          ledger: result.ledger,
          experimentId: result.experimentId
        };
      });
      api.logger.info('[HarnessRefiner] Nightshift task runner registered');
    }

    api.logger.info(`[HarnessRefiner] Plugin ready: dataDir=${baseDataDir}`);
  }
};

function summarizeAnalysis(result = {}) {
  return {
    skipped: result.skipped === true,
    reason: result.reason || null,
    windowCount: result.windowCount || 0,
    signatureCount: (result.signatures || []).length,
    proposalCount: (result.proposals || []).length,
    scoreCount: (result.scoreReceipts || []).length,
    relabelCandidateCount: (result.relabelCandidates || []).length,
    digestCount: (result.digests || []).length,
    skippedWindowCount: (result.skippedWindows || []).length
  };
}

function safeShardFileName(value) {
  return String(value || 'shard').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 180);
}
