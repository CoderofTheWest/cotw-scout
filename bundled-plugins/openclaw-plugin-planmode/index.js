/**
 * openclaw-plugin-planmode — Lightweight plan mode for OpenClaw
 *
 * Detects <plan_complete> blocks in agent responses, persists plans to disk,
 * handles approval/rejection/feedback from Chris, and injects active plan
 * context into agent turns.
 *
 * Does NOT restrict tools — trusts Clint to follow AGENTS.md planning discipline.
 *
 * Hooks:
 *   before_agent_start (priority 12) — inject plan context, handle approval
 *   agent_end (priority 10) — detect plan completion in response
 *
 * Tools:
 *   plan_status — check current plan state
 *
 * Created: Mar 31, 2026
 */

const fs = require('fs');
const path = require('path');
const { PlanStore } = require('./lib/planStore');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source || {})) {
        const next = source[key];
        if (next && typeof next === 'object' && !Array.isArray(next)) {
            result[key] = deepMerge(result[key] || {}, next);
        } else {
            result[key] = next;
        }
    }
    return result;
}

function loadConfig(userConfig) {
    const defaults = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8')
    );
    return deepMerge(defaults, userConfig || {});
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
}

module.exports = {
    id: 'planmode',
    name: 'Plan Mode',

    configSchema: {
        jsonSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' }
            }
        }
    },

    register(api) {
        api = instrumentApiHooks(api, 'planmode');
        const config = loadConfig(api.pluginConfig || {});
        if (!config.enabled) return;

        // ── Per-agent state ──────────────────────────────────────────────
        const agentStores = new Map();
        const baseDataDir = ensureDir(path.join(__dirname, 'data'));
        const processStartTime = Date.now();
        const recoveryChecked = new Set(); // track which agents have been checked for recovery

        function getStore(agentId) {
            const id = agentId || 'main';
            if (!agentStores.has(id)) {
                const dataDir = (!agentId || agentId === 'main')
                    ? ensureDir(path.join(baseDataDir, 'plans'))
                    : ensureDir(path.join(baseDataDir, 'agents', id, 'plans'));
                agentStores.set(id, new PlanStore(dataDir));
            }
            return agentStores.get(id);
        }

        /**
         * Extract the last user message text from the event messages array.
         * Messages may be strings or objects with .content.
         */
        function extractUserMessage(event) {
            if (!event?.messages) return null;
            for (let i = event.messages.length - 1; i >= 0; i--) {
                const msg = event.messages[i];
                if (msg.role === 'user') {
                    return typeof msg.content === 'string' ? msg.content
                        : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ')
                        : null;
                }
            }
            return null;
        }

        /**
         * Extract the last assistant message text from the event messages array.
         */
        function extractAssistantResponse(event) {
            if (!event?.messages) return null;
            for (let i = event.messages.length - 1; i >= 0; i--) {
                const msg = event.messages[i];
                if (msg.role === 'assistant') {
                    return typeof msg.content === 'string' ? msg.content
                        : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join(' ')
                        : null;
                }
            }
            return null;
        }

        // Approval/rejection phrase lists
        const approvalPhrases = ['approved', 'approve', 'looks good', 'go ahead', 'lgtm', 'do it', 'ship it'];
        const rejectionPhrases = ['cancel', 'never mind', 'reject', 'forget it'];

        // ── Hook: before_agent_start ─────────────────────────────────────
        // Priority 12: after stability (5) and continuity (10)
        api.on('before_agent_start', async (event, ctx) => {
            try {
                const store = getStore(ctx.agentId);
                const userMsg = extractUserMessage(event);
                const lines = [];

                // Check for pending plan approval
                const pending = await store.getPendingApproval();
                if (pending && userMsg) {
                    const lower = userMsg.toLowerCase().trim();

                    if (approvalPhrases.some(p => lower.includes(p))) {
                        // Approve and start execution
                        await store.approve();
                        await store.startExecution();
                        const active = await store.getActive();
                        lines.push(store.formatForPrompt(active));
                        lines.push('\nThe plan has been approved. Execute it now, starting with step 1.');
                        api.logger.info(`[planmode:${ctx.agentId}] Plan approved: ${pending.slug}`);

                    } else if (rejectionPhrases.some(p => lower === p || lower.startsWith(p + ' '))) {
                        // Reject
                        await store.reject();
                        lines.push('[PLAN MODE] Plan cancelled.');
                        api.logger.info(`[planmode:${ctx.agentId}] Plan rejected: ${pending.slug}`);

                    } else {
                        // Feedback — keep pending, inject for revision
                        lines.push(store.formatForPrompt(pending));
                        lines.push(`\nChris has feedback on the plan: ${userMsg}`);
                        lines.push('Revise the plan based on this feedback and emit an updated <plan_complete> block.');
                        // Reject old plan so new one can be created
                        await store.reject();
                        api.logger.info(`[planmode:${ctx.agentId}] Plan feedback received — revision requested`);
                    }
                } else {
                    // No pending plan — inject active plan context if executing
                    const active = await store.getActive();
                    if (active) {
                        lines.push(store.formatForPrompt(active));

                        // Plan recovery: if this is the first message after a restart
                        // and there's an executing plan, inject recovery context
                        const agentKey = ctx.agentId || 'main';
                        if (!recoveryChecked.has(agentKey)) {
                            recoveryChecked.add(agentKey);
                            // If the plan was approved before this process started, it's orphaned
                            const approvedTime = active.approved_at ? new Date(active.approved_at).getTime() : 0;
                            if (approvedTime > 0 && approvedTime < processStartTime) {
                                const done = active.steps.filter(s => s.status === 'completed').length;
                                lines.push(`\n[PLAN RECOVERY] This plan was being executed when the app was interrupted. ` +
                                    `${done}/${active.steps.length} steps were completed. ` +
                                    `Review the plan state above and continue from where you left off. ` +
                                    `If you're unsure what was completed, use the plan_status tool and ask the user to confirm.`);
                                api.logger.info(`[planmode:${agentKey}] Plan recovery triggered for: ${active.slug}`);
                            }
                        }
                    }
                }

                if (lines.length > 0) {
                    return { prependContext: lines.join('\n') };
                }
            } catch (err) {
                api.logger.warn(`[planmode:${ctx.agentId}] before_agent_start error: ${err.message}`);
            }
        }, { priority: 12 });

        // ── Hook: agent_end ──────────────────────────────────────────────
        // Detect <plan_complete> blocks in response
        api.on('agent_end', async (event, ctx) => {
            try {
                const store = getStore(ctx.agentId);
                const response = extractAssistantResponse(event);
                if (!response) return;

                const match = response.match(/<plan_complete>([\s\S]*?)<\/plan_complete>/i);
                if (!match) return;

                const planContent = match[1].trim();

                // Extract numbered steps from plan content
                const stepsSection = planContent.match(/##\s*Steps\s*\n([\s\S]*?)(?=\n##|\n$|$)/i);
                const stepsText = stepsSection ? stepsSection[1] : planContent;
                const steps = stepsText
                    .split('\n')
                    .filter(line => /^\s*\d+[\.\)]/.test(line))
                    .map(line => line.replace(/^\s*\d+[\.\)]\s*/, '').trim())
                    .filter(line => line.length > 5);

                // Extract goal from user message or plan content
                const userMsg = extractUserMessage(event);
                const goalMatch = planContent.match(/##\s*Goal\s*\n([\s\S]*?)(?=\n##|$)/i);
                const goal = goalMatch ? goalMatch[1].trim().split('\n')[0] : (userMsg || 'Unnamed plan');

                await store.create(goal, steps, planContent);
                api.logger.info(`[planmode:${ctx.agentId}] Plan created: ${steps.length} steps — "${goal.substring(0, 60)}"`);
            } catch (err) {
                api.logger.warn(`[planmode:${ctx.agentId}] agent_end error: ${err.message}`);
            }
        }, { priority: 10 });

        // ── Tool: plan_status ────────────────────────────────────────────
        api.registerTool({
            name: 'plan_status',
            description: 'Check the status of the current plan (pending_approval, approved, executing, or none)',
            parameters: {
                type: 'object',
                properties: {},
                required: []
            },
            execute: async (_toolCallId, _args, ctx) => {
                try {
                    const store = getStore(ctx?.agentId);
                    const plan = (await store.getActive()) || (await store.getPendingApproval());
                    if (!plan) {
                        return { content: [{ type: 'text', text: 'No active plan.' }] };
                    }
                    return { content: [{ type: 'text', text: store.formatForPrompt(plan) }] };
                } catch (err) {
                    return { content: [{ type: 'text', text: `Error checking plan: ${err.message}` }] };
                }
            }
        }, { name: 'plan_status' });

        // ── Gateway method: planmode.getState ─────────────────────────────
        api.registerGatewayMethod('planmode.getState', async ({ params, respond }) => {
            try {
                const store = getStore(params?.agentId);
                const active = await store.getActive();
                const pending = await store.getPendingApproval();
                respond(true, {
                    agentId: params?.agentId || 'main',
                    activePlan: active ? { slug: active.slug, status: active.status, steps: active.steps.length } : null,
                    pendingPlan: pending ? { slug: pending.slug, goal: pending.goal } : null
                });
            } catch (err) {
                respond(false, { error: err.message });
            }
        });

        api.logger.info('[planmode] Plugin registered');
    }
};
