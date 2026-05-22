'use strict';

const path = require('path');

const PLUGIN_ID = 'epistemic-proof-loop';
const { instrumentApiHooks } = require('../lib/runtime-metrics');

function resolveWorkspaceDir(ctx) {
  return ctx?.workspaceDir || process.env.OPENCLAW_WORKSPACE || process.cwd();
}

function loadGate(ctx) {
  const workspaceDir = resolveWorkspaceDir(ctx);
  const gatePath = path.join(workspaceDir, 'projects', 'cotw-claw', 'src', 'epistemic-gate.js');
  // Keep this dynamic so Gateway restarts pick up harness fixes without bundling a stale copy.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(gatePath);
}

function inferRouteType(prompt) {
  const text = String(prompt || '').toLowerCase();
  if (!text.trim()) return 'empty';
  if (/\b(memory|cpu|rss|gateway|electron|runtime|process|config|schema|test|build|lint|deploy|commit|repo|file|path|hook|plugin|diagnostic|wired|installed|active)\b/.test(text)) {
    return 'technical';
  }
  if (/\b(identity|substrate|epistemic|proof|logic|invention|inventive|conscious|self)\b/.test(text)) {
    return 'identity_substrate';
  }
  if (text.length < 120 && /\b(hey|hi|morning|thanks|okay|yep|yeah|sounds good)\b/.test(text)) {
    return 'simple_relational';
  }
  return 'ordinary_practical';
}

function renderPromptContext(decision) {
  const lines = [
    '[EPISTEMIC PROOF LOOP — active for this turn]',
    `Mode: ${decision.mode}`,
    `Reason: ${decision.reason}`,
    '',
    'This is a proof gate, not a personality change. Answer normally, but obey these claim constraints:',
  ];

  if (decision.targetClaims?.length) {
    lines.push('', 'Target claims:');
    for (const claim of decision.targetClaims) {
      lines.push(`- ${claim.id} (${claim.kind}): ${claim.text}`);
    }
  }

  if (decision.obligations?.length) {
    lines.push('', 'Obligations before final answer:');
    for (const obligation of decision.obligations) {
      lines.push(`- ${obligation.id}: ${obligation.text}`);
    }
  }

  lines.push(
    '',
    `Allowed conclusion policy: ${decision.allowedConclusionPolicy}`,
    'If mutable runtime/file/process/config state matters and you have not verified it this turn, say the missing gate plainly instead of presenting it as known.',
    'If the evidence supports only a hypothesis, label it as a hypothesis and name the smallest honest verifier.'
  );

  return lines.join('\n');
}

function decideForPrompt(prompt, ctx) {
  const { routeEpistemic } = loadGate(ctx);
  return routeEpistemic(prompt, { routeType: inferRouteType(prompt) });
}

module.exports = {
  id: PLUGIN_ID,
  name: 'Epistemic Proof Loop',

  register(api) {
    api = instrumentApiHooks(api, PLUGIN_ID);
    const config = api.pluginConfig || {};

    api.on('before_prompt_build', async (event, ctx) => {
      if (config.enabled === false) return;

      let decision;
      try {
        decision = decideForPrompt(event?.prompt, ctx);
      } catch (error) {
        api.logger?.warn?.(`epistemic-proof-loop: gate load/decision failed: ${error?.message || String(error)}`);
        return;
      }

      if (!decision?.enabled) return;

      if (config.logDecisions) {
        api.logger?.info?.(`epistemic-proof-loop: ${decision.mode} for ${ctx?.sessionKey || 'unknown-session'} (${decision.reason})`);
      }

      return { prependContext: renderPromptContext(decision) };
    }, { priority: 80, timeoutMs: 1000 });

    api.registerTool({
      name: 'epistemic_proof_loop_status',
      description: 'Inspect the Epistemic Proof Loop plugin and route a sample prompt through the active gate.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'Optional prompt to classify through the live EPL gate.'
          }
        }
      },
      async handler(params, ctx) {
        const prompt = params?.prompt || '';
        const gate = loadGate(ctx);
        const decision = gate.routeEpistemic(prompt, { routeType: inferRouteType(prompt) });
        return {
          pluginId: PLUGIN_ID,
          enabled: config.enabled !== false,
          workspaceGateLoaded: true,
          routeType: inferRouteType(prompt),
          decision
        };
      }
    });
  }
};
