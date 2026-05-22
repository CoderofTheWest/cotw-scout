'use strict';

const fs = require('fs');
const path = require('path');
const { readLastJsonlEntry } = require('../lib/jsonl');
const { instrumentApiHooks } = require('../lib/runtime-metrics');
const { forward, concat, l2Squared } = require('./lib/mlp');
const Normalizer = require('./lib/normalizer');
const StateCollector = require('./lib/state-collector');
const LearnablePredictor = require('./lib/learnable-predictor');

const MODELS_DIR = path.join(__dirname, 'models');
const DATA_DIR = path.join(__dirname, 'data');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function loadJSON(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

module.exports = {
    id: 'cognitive-dynamics',
    name: 'Cognitive Dynamics (JEPA)',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: {
                    type: 'boolean',
                    default: true,
                    description: 'Enable cognitive dynamics tracking'
                },
                surpriseThreshold: {
                    type: 'number',
                    default: 2.0,
                    description: 'Surprise value above which to flag a turn (in latent MSE units)'
                },
                logLatentVectors: {
                    type: 'boolean',
                    default: false,
                    description: 'Include full 64-dim latent vectors in log (verbose)'
                },
                agentFilter: {
                    type: 'string',
                    default: '',
                    description: 'Only track this agent ID (empty = track all)'
                }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'cognitive-dynamics');
        const pluginConfig = api.pluginConfig || {};
        const config = {
            enabled: pluginConfig.enabled !== false,
            surpriseThreshold: pluginConfig.surpriseThreshold || 2.0,
            logLatentVectors: pluginConfig.logLatentVectors || false,
            agentFilter: pluginConfig.agentFilter || '',
        };

        if (!config.enabled) {
            api.logger.info('[cognitive-dynamics] Disabled by config');
            return;
        }

        // --- Load model weights ---
        let encoderWeights, predictorWeights, normalizer;
        try {
            encoderWeights = loadJSON(path.join(MODELS_DIR, 'encoder_weights.json'));
            predictorWeights = loadJSON(path.join(MODELS_DIR, 'predictor_weights.json'));
            const normData = loadJSON(path.join(MODELS_DIR, 'normalization.json'));
            normalizer = new Normalizer(normData);
            api.logger.info(`[cognitive-dynamics] Models loaded: encoder (${encoderWeights.layers.length} layers), predictor (${predictorWeights.layers.length} layers), ${normData.feature_names.length} features`);
        } catch (err) {
            api.logger.error(`[cognitive-dynamics] Failed to load models: ${err.message}`);
            return;
        }

        // --- Per-agent state (module-level to survive across register() calls) ---
        if (!module._cogDynStates) {
            module._cogDynStates = new Map();
        }
        const agentStates = module._cogDynStates;

        function getState(agentId) {
            const id = agentId || 'main';
            if (!agentStates.has(id)) {
                // Create learning predictor for this agent
                const agentDataDir = ensureDir(path.join(DATA_DIR, 'agents', id));
                const learner = new LearnablePredictor(predictorWeights, {
                    learningRate: 0.001,
                    lrDecay: 0.9999,
                    minLr: 0.00001,
                    momentumCoeff: 0.9,
                    savePath: path.join(agentDataDir, 'learned-predictor-weights.json'),
                    saveEvery: 10,
                });

                agentStates.set(id, {
                    collector: new StateCollector(normalizer.featureNames),
                    learner,
                    predictedLatentFrozen: null,   // frozen predictor's prediction
                    predictedLatentLearned: null,   // learning predictor's prediction
                    previousLatent: null,           // actual latent from previous turn (for backprop)
                    previousInputCond: null,        // previous input conditioning (for backprop)
                    turnIndex: 0,
                    sessionStartTime: null,
                    surpriseHistoryFrozen: [],
                    surpriseHistoryLearned: [],
                    lastSurpriseFrozen: null,
                    lastSurpriseLearned: null,
                });

                api.logger.info(`[cognitive-dynamics] Agent state created for ${id} (learner: ${learner.updateCount} prior updates)`);
            }
            return agentStates.get(id);
        }

        // --- Resolve entropy log path for an agent ---
        function entropyLogPath(agentId) {
            const candidates = [
                path.join(__dirname, '..', 'openclaw-plugin-stability', 'data', 'agents', agentId || 'main', 'entropy-monitor.jsonl'),
                path.join(__dirname, '..', 'openclaw-plugin-stability', 'data', 'entropy-monitor.jsonl'),
            ];
            for (const p of candidates) {
                if (fs.existsSync(p)) return p;
            }
            return null;
        }

        // --- Before agent start: required for lifecycle participation ---
        api.on('before_agent_start', async (event, ctx) => {
            return {};
        }, { priority: 20 });

        // --- Agent end hook: dual-predictor surprise loop ---
        api.on('agent_end', async (event, ctx) => {
            try {
                const agentId = ctx.agentId || 'main';
                if (config.agentFilter && agentId !== config.agentFilter) return;

                const state = getState(agentId);
                const messages = event.messages || [];

                // Extract text
                const lastUser = [...messages].reverse().find(m => m?.role === 'user');
                const lastAssistant = [...messages].reverse().find(m => m?.role === 'assistant');

                function extractText(msg) {
                    if (!msg?.content) return '';
                    if (typeof msg.content === 'string') return msg.content;
                    if (Array.isArray(msg.content)) {
                        return msg.content
                            .filter(b => b.type === 'text')
                            .map(b => b.text || '')
                            .join('\n');
                    }
                    return String(msg.content);
                }

                const userText = extractText(lastUser);
                const responseText = extractText(lastAssistant);

                if (!userText && !responseText) return;

                // Session tracking
                if (!state.sessionStartTime) {
                    state.sessionStartTime = Date.now();
                }
                const sessionMinutes = (Date.now() - state.sessionStartTime) / 60000;

                // Read entropy
                const entropyState = api.stability?.getEntropyState?.(agentId) || null;
                const logPath = entropyLogPath(agentId);
                const entropyLogEntry = logPath ? readLastJsonlEntry(logPath) : null;

                // Assemble and normalize state vector
                const { vector: rawState, available } = state.collector.collect({
                    entropyState,
                    entropyLogEntry,
                    userText,
                    responseText,
                    turnIndex: state.turnIndex,
                    sessionLengthMinutes: sessionMinutes,
                });

                const normalizedState = normalizer.normalizeState(rawState);
                const inputCond = normalizer.normalizeInputCond(rawState);

                // Encode current state
                const latent = forward(normalizedState, encoderWeights.layers);

                // === DUAL PREDICTOR SURPRISE ===
                let surpriseFrozen = null;
                let surpriseLearned = null;
                let learnerLoss = null;

                if (state.predictedLatentFrozen) {
                    // Frozen predictor surprise
                    surpriseFrozen = l2Squared(state.predictedLatentFrozen, latent);
                    state.surpriseHistoryFrozen.push(surpriseFrozen);
                    if (state.surpriseHistoryFrozen.length > 200) state.surpriseHistoryFrozen.shift();

                    // Learning predictor surprise
                    surpriseLearned = l2Squared(state.predictedLatentLearned, latent);
                    state.surpriseHistoryLearned.push(surpriseLearned);
                    if (state.surpriseHistoryLearned.length > 200) state.surpriseHistoryLearned.shift();

                    // === ONLINE LEARNING: backprop the learner ===
                    // The learner predicted state.predictedLatentLearned from the PREVIOUS turn.
                    // The actual latent for this turn is `latent`.
                    // Re-run the learner's forward pass with previous input to get cached activations,
                    // then backprop against the actual latent.
                    if (state.previousLatent && state.previousInputCond) {
                        const learnerInput = new Float32Array(state.previousLatent.length + state.previousInputCond.length);
                        learnerInput.set(state.previousLatent, 0);
                        learnerInput.set(state.previousInputCond, state.previousLatent.length);
                        const learnerPred = state.learner.forward(learnerInput);
                        learnerLoss = state.learner.backward(learnerPred, latent);
                    }
                }

                // Predict next state with BOTH predictors
                const frozenInput = concat(latent, inputCond);
                const frozenPrediction = forward(frozenInput, predictorWeights.layers);

                const learnerInput = new Float32Array(latent.length + inputCond.length);
                learnerInput.set(latent, 0);
                learnerInput.set(inputCond, latent.length);
                const learnedPrediction = state.learner.forward(learnerInput);

                // Store for next turn
                state.predictedLatentFrozen = frozenPrediction;
                state.predictedLatentLearned = new Float32Array(learnedPrediction);
                state.previousLatent = new Float32Array(latent);
                state.previousInputCond = new Float32Array(inputCond);
                state.lastSurpriseFrozen = surpriseFrozen;
                state.lastSurpriseLearned = surpriseLearned;
                state.turnIndex++;

                // Compute percentiles
                function percentile(history, value) {
                    if (!history.length || value === null) return null;
                    const sorted = [...history].sort((a, b) => a - b);
                    return sorted.filter(v => v <= value).length / sorted.length;
                }

                // Log
                const logEntry = {
                    timestamp: new Date().toISOString(),
                    turn_index: state.turnIndex - 1,
                    surprise_frozen: surpriseFrozen !== null ? Math.round(surpriseFrozen * 100000) / 100000 : null,
                    surprise_learned: surpriseLearned !== null ? Math.round(surpriseLearned * 100000) / 100000 : null,
                    learner_loss: learnerLoss !== null ? Math.round(learnerLoss * 100000) / 100000 : null,
                    learner_updates: state.learner.updateCount,
                    learner_lr: Math.round(state.learner.lr * 1000000) / 1000000,
                    features_available: available,
                    features_total: FEATURE_COUNT,
                    entropy_score: rawState[0],
                    user_length: rawState[16],
                    response_length: rawState[17],
                };

                // Backward compatibility: keep 'surprise' as the frozen value
                logEntry.surprise = logEntry.surprise_frozen;
                logEntry.surprise_percentile = percentile(state.surpriseHistoryFrozen, surpriseFrozen);

                logEntry.state_vector = Array.from(rawState);
                logEntry.latent = Array.from(latent);
                logEntry.predicted_frozen = Array.from(frozenPrediction);
                logEntry.predicted_learned = Array.from(learnedPrediction);

                // High surprise flag (frozen predictor)
                if (surpriseFrozen !== null && surpriseFrozen > config.surpriseThreshold) {
                    logEntry.high_surprise = true;
                }

                // Write log
                const agentDataDir = ensureDir(path.join(DATA_DIR, 'agents', agentId));
                const logFile = path.join(agentDataDir, 'cognitive-dynamics.jsonl');
                fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

            } catch (err) {
                api.logger.error(`[cognitive-dynamics] Error in agent_end: ${err.message}\n${err.stack}`);
            }
        });

        // --- Gateway method for real-time inspection ---
        api.registerGatewayMethod('cognitive-dynamics.getState', async ({ params, respond }) => {
            const agentId = params?.agentId || 'main';
            const state = agentStates.get(agentId);
            if (!state) {
                return respond(true, { active: false });
            }

            const frozenMean = state.surpriseHistoryFrozen.length > 0
                ? state.surpriseHistoryFrozen.reduce((a, b) => a + b, 0) / state.surpriseHistoryFrozen.length
                : null;
            const learnedMean = state.surpriseHistoryLearned.length > 0
                ? state.surpriseHistoryLearned.reduce((a, b) => a + b, 0) / state.surpriseHistoryLearned.length
                : null;

            respond(true, {
                active: true,
                turnIndex: state.turnIndex,
                lastSurpriseFrozen: state.lastSurpriseFrozen,
                lastSurpriseLearned: state.lastSurpriseLearned,
                surpriseMeanFrozen: frozenMean,
                surpriseMeanLearned: learnedMean,
                learnerUpdates: state.learner.updateCount,
                learnerLR: state.learner.lr,
                substrateDelta: frozenMean && learnedMean ? frozenMean - learnedMean : null,
            });
        });

        // --- Inter-plugin API ---
        api.cognitiveDynamics = {
            getSurprise: (agentId) => {
                const state = agentStates.get(agentId || 'main');
                return state ? {
                    frozen: state.lastSurpriseFrozen,
                    learned: state.lastSurpriseLearned,
                } : null;
            },
            getLatent: (agentId) => {
                const state = agentStates.get(agentId || 'main');
                return state?.previousLatent ? Array.from(state.previousLatent) : null;
            },
        };

        api.logger.info('[cognitive-dynamics] Plugin registered (dual predictor: frozen + learning)');
    }
};

const FEATURE_COUNT = 25;
