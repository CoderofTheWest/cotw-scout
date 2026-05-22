const fs = require('fs');
const path = require('path');
const os = require('os');
const InquiryStore = require('./lib/inquiry');
const extractor = require('./lib/extractor');
const reflect = require('./lib/reflect');
const writer = require('./lib/writer');
const anticipator = require('./lib/anticipator');
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
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  return deepMerge(defaults, userConfig || {});
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Truncate at a word boundary so injected excerpts don't cut mid-word.
 * If str exceeds maxChars, trim back to the last whitespace before maxChars
 * (only if that whitespace is past 80% of cap — otherwise a long unbroken
 * token would collapse the string to almost nothing, so we hard-cut instead).
 * Appends suffix (default '…') to signal truncation.
 *
 * Per Tier 1 PRD (2026-04-19), applied to contemplation's user-facing
 * context-injection and tool-response substrings.
 */
function smartTrim(str, maxChars, suffix = '…') {
  if (!str) return '';
  if (str.length <= maxChars) return str;
  const cut = str.lastIndexOf(' ', maxChars);
  const endAt = cut > maxChars * 0.8 ? cut : maxChars;
  return str.substring(0, endAt).trimEnd() + suffix;
}

/**
 * Generate 2-3 topic tags for an inquiry via LLM.
 * Called asynchronously after inquiry creation — doesn't block the hook.
 */
async function tagInquiry(store, inquiry, config, logger, api) {
  if (!config.tagging?.enabled) return;

  const prompt = [
    'Given this question an AI agent is contemplating, generate 2-3 short topic tags (1-2 words each).',
    'Return ONLY a JSON array of lowercase strings, nothing else.',
    '',
    `Question: "${inquiry.question}"`,
    '',
    'Tags:'
  ].join('\n');

  try {
    const result = await reflect.callGateway({
      api,
      prompt,
      temperature: 0.3,
      maxTokens: 100,
      timeoutMs: config.llm?.timeoutMs ?? 15000
    });

    // Graceful skip when LLM was unavailable (callGateway returns null)
    if (!result) return;

    // Parse tags from LLM response — handle various formats
    const match = result.match(/\[.*\]/s);
    if (match) {
      const tags = JSON.parse(match[0]);
      if (Array.isArray(tags) && tags.every(t => typeof t === 'string')) {
        inquiry.tags = tags.map(t => t.toLowerCase().trim()).slice(0, 4);
        store.persist();
        if (logger) {
          logger.info(`[Contemplation] Tagged ${inquiry.id}: [${inquiry.tags.join(', ')}]`);
        }
      }
    }
  } catch (err) {
    if (logger) {
      logger.warn(`[Contemplation] Tag generation failed for ${inquiry.id}: ${err.message}`);
    }
  }
}

/**
 * Resolve output paths per-agent based on workspace.
 * Avoids hardcoding any single agent's workspace path in config.
 */
function resolveOutputPaths(agentId, workspacePath) {
  const workspace = workspacePath
    || path.join(os.homedir(), '.openclaw', agentId === 'main' ? 'workspace' : `workspace-${agentId}`);
  return {
    growthVectorsPath: path.join(workspace, 'memory', 'growth-vectors.json'),
    insightsPath: path.join(workspace, 'memory', 'insights')
  };
}

module.exports = {
  id: 'contemplation',
  name: 'Contemplation — Inquiry Passes',

  register(api) {
    api = instrumentApiHooks(api, 'contemplation');
    const config = loadConfig(api.pluginConfig || {});
    if (!config.enabled) {
      api.logger.info('Contemplation plugin disabled via config');
      return;
    }

    const baseDataDir = path.join(__dirname, 'data');
    ensureDir(path.join(baseDataDir, 'agents'));

    const states = new Map();

    function getState(agentId) {
      const id = agentId || 'main';
      if (!states.has(id)) {
        states.set(id, {
          agentId: id,
          store: new InquiryStore(baseDataDir, id, config.passes),
          processing: false,
          workspacePath: null // set on first event with metadata
        });
        api.logger.info(`[Contemplation] Initialized state for agent "${id}"`);
      }
      return states.get(id);
    }

    // Track current agent for tool context — OpenClaw's tool-invocation
    // context does NOT populate ctx.agentId reliably (only hook ctx does).
    // Same workaround the continuity plugin uses: capture agentId from the
    // before_agent_start hook into a module-scoped variable, and have tools
    // fall back to it when their own ctx is missing the id. Safe because
    // OpenClaw serializes execution per session lane.
    //
    // Before this fix: Ellis's tool calls landed on ctx.agentId=undefined,
    // getState defaulted to 'main', and inquiries written/read under 'main'
    // never matched the 'trail-guide' store that nightshift hooks wrote to.
    // Symptom: contemplate_list_due returned empty while nightshift saw
    // 5 due passes under trail-guide.
    let currentAgentId = 'main';
    function resolveAgentId(ctx) {
      return ctx?.agentId || currentAgentId;
    }

    /**
     * Get output paths for an agent, resolving workspace from state or event.
     */
    function getOutputPaths(state, event) {
      // Cache workspace path from event metadata
      if (event?.metadata?.workspace && !state.workspacePath) {
        state.workspacePath = event.metadata.workspace;
      }
      // Use config paths if explicitly set (backwards compat), otherwise resolve per-agent
      if (config.output?.growthVectorsPath && config.output?.insightsPath) {
        return config.output;
      }
      return resolveOutputPaths(state.agentId, state.workspacePath);
    }

    async function persistCompletedInsights(state, event) {
      const pending = state.store.getCompletedUnpersisted();
      if (pending.length === 0) return 0;

      const outputPaths = getOutputPaths(state, event);
      let wrote = 0;
      for (const inquiry of pending) {
        try {
          writer.appendGrowthVector(outputPaths.growthVectorsPath, inquiry);
          if (outputPaths.insightsPath) {
            writer.writeInsightFile(outputPaths.insightsPath, inquiry);
          }
          // Index into continuity vec_knowledge for semantic search + anticipatory surfacing
          writer.indexInsightForSearch(state.agentId, inquiry).catch(err => {
            api.logger.warn(`[Contemplation:${state.agentId}] Insight indexing non-fatal: ${err.message}`);
          });
          state.store.markPersisted(inquiry.id);
          wrote++;
          api.logger.info(
            `[Contemplation:${state.agentId}] Persisted inquiry ${inquiry.id} → ${outputPaths.growthVectorsPath} + vec_knowledge`
          );
        } catch (err) {
          api.logger.error(`[Contemplation:${state.agentId}] Failed writing inquiry ${inquiry.id}: ${err.message}`);
        }
      }

      return wrote;
    }

    async function runOneDuePass(state, ctx) {
      if (state.processing) return false;
      const due = state.store.getDuePass();
      if (!due) return false;

      state.processing = true;
      try {
        const output = await reflect.runPass({
          inquiry: due.inquiry,
          passNumber: due.passNumber,
          config,
          api
        });

        // Graceful skip when LLM was unavailable — don't mark pass complete
        if (output === null) {
          api.logger.warn(`[Contemplation:${state.agentId}] Skipped pass ${due.passNumber} for ${due.inquiry.id} — LLM unavailable`);
          return false;
        }

        const updated = state.store.completePass(due.inquiry.id, due.passNumber, output);
        api.logger.info(`[Contemplation:${state.agentId}] Completed pass ${due.passNumber} for ${due.inquiry.id}`);

        if (updated?.status === 'completed') {
          await persistCompletedInsights(state);
        }

        // Queue another nightshift task in case more passes are due
        if (global.__ocNightshift?.queueTask) {
          global.__ocNightshift.queueTask(ctx.agentId, {
            type: 'contemplation',
            priority: config.nightshift?.priority || 50,
            source: 'contemplation'
          });
        }

        return true;
      } catch (err) {
        api.logger.error(`[Contemplation:${state.agentId}] Pass run failed: ${err.message}`);
        return false;
      } finally {
        state.processing = false;
      }
    }

    // -----------------------------------------------------------------
    // METABOLISM INTEGRATION: Subscribe to LLM-derived knowledge gaps
    // -----------------------------------------------------------------
    // The OpenClaw gateway gives each plugin its own scoped `api` object,
    // so api.metabolism doesn't cross plugin boundaries. Use the global
    // __ocMetabolism bus that the metabolism plugin sets up.
    //
    // Metabolism extracts implications from conversation via LLM, then
    // identifies "gaps" (questions, uncertainty markers). These are
    // higher quality than regex extraction from raw conversation because
    // the LLM has already reasoned about the exchange.

    // Deferred subscription: metabolism may not be loaded yet at register() time.
    // Poll every 2s until the Metabolism gap bus is available.
    const SKIP_PATTERNS = [
      /^how (?:specifically )?is .+ connected to other things/i,
      /^what (?:specifically )?is the relationship between .+ and/i,
      /we only have generic associations/i,
      // Skip gaps derived from framework/instruction text (AGENTS.md, SOUL.md content)
      /\[feedback\]/i,
      /\[user\]/i,
      /\[project\]/i,
      /\[reference\]/i,
      /learn pronouns|observation.*not interrogation|don't ask.*pronouns/i,
      /epistemic honesty|proprioceptive|anti-anchoring|goal fidelity/i,
      /firelight posture|framework integrity|non-negotiable/i,
      /bootstrap|session handoff|compaction/i,
    ];

    const attachGapListener = () => {
      const listener = (gaps, agentId) => {
        const state = getState(agentId);

        // Gate on cognitive dynamics — only contemplate surprising exchanges.
        // Note: thresholds lowered from 0.5/0.3 to 0.25/0.15 to allow more diverse
        // content through. The original values were too aggressive for new agents
        // that haven't built up cognitive dynamics history, causing only high-novelty
        // topics (e.g., embodiment) to pass while everything else got filtered out.
        const surprise = api.cognitiveDynamics?.getSurprise?.(agentId);
        const entropy = api.stability?.getEntropy?.(agentId) || 0;
        const surpriseScore = surprise?.frozen ?? surprise?.learned ?? null;

        const surpriseThreshold = config.surpriseThreshold || 0.25;
        const entropyFloor = config.entropyFloor || 0.15;
        if (surpriseScore !== null && surpriseScore < surpriseThreshold && entropy < entropyFloor) {
          api.logger.debug(
            `[Contemplation:${agentId}] Skipped ${gaps.length} gap(s) — low surprise (${surpriseScore.toFixed(3)}) + low entropy (${entropy.toFixed(2)})`
          );
          return;
        }

        // Dedup incoming gaps before processing
        const seenGaps = new Set();
        const uniqueGaps = gaps.filter(g => {
          const key = g.question?.trim().toLowerCase();
          if (!key || seenGaps.has(key)) return false;
          seenGaps.add(key);
          return true;
        });
        for (const gap of uniqueGaps) {
          // Filter out graph-janitorial questions
          const isJanitorial = SKIP_PATTERNS.some(p => p.test(gap.question));
          if (isJanitorial) {
            api.logger.debug(
              `[Contemplation:${agentId}] Skipped graph-janitorial gap: "${gap.question.substring(0, 60)}"`
            );
            continue;
          }

          const inquiry = state.store.addInquiry({
            question: gap.question,
            source: `metabolism:${gap.sourceId || 'unknown'}`,
            entropy: entropy,
            context: gap.question,
            exchangeId: gap.exchangeId || null
          });
          if (inquiry.created && (Date.now() - new Date(inquiry.created).getTime()) < 1000) {
            api.logger.info(
              `[Contemplation:${agentId}] Queued inquiry from metabolism: ${inquiry.id} (surprise=${surpriseScore?.toFixed(3) ?? 'n/a'}, entropy=${entropy.toFixed(2)}) — "${gap.question.substring(0, 80)}"`
            );
            tagInquiry(state.store, inquiry, config, api.logger, api).catch(() => {});
          }
        }
      };
      if (global.__ocMetabolism?.registerGapListener) {
        global.__ocMetabolism.registerGapListener('contemplation', listener);
      } else if (global.__ocMetabolism?.gapListeners) {
        global.__ocMetabolism.gapListeners.push(listener);
      }
      api.logger.info('[Contemplation] Subscribed to metabolism gap events (surprise + entropy gated)');
    };

    if (global.__ocMetabolism?.registerGapListener || global.__ocMetabolism?.gapListeners) {
      attachGapListener();
    } else {
      // Bounded polling — same defensive cap as the nightshift polling
      // below. If metabolism genuinely never loads, surface a warning
      // at 60s instead of polling the rest of the process lifetime.
      let metabolismAttempts = 0;
      const METABOLISM_MAX_ATTEMPTS = 30;
      const pollId = setInterval(() => {
        metabolismAttempts++;
        if (global.__ocMetabolism?.registerGapListener || global.__ocMetabolism?.gapListeners) {
          clearInterval(pollId);
          attachGapListener();
        } else if (metabolismAttempts >= METABOLISM_MAX_ATTEMPTS) {
          clearInterval(pollId);
          api.logger.warn('[Contemplation] Metabolism never loaded after 60s — gap-listener NOT attached. Knowledge-gap-driven contemplation seeding will not fire.');
        }
      }, 2000);
      api.logger.info('[Contemplation] Metabolism not yet available — polling for gap bus every 2s (max 30 attempts)');
    }

    // -----------------------------------------------------------------
    // Skill-path signal writer — autonomous counterpart to /contemplation
    // -----------------------------------------------------------------
    // When nightshift fires the contemplation task and passes are due,
    // drop CONTEMPLATION_DUE.md in the workspace. main.js's parallel
    // watcher picks it up and sends the prompt as a proactive message,
    // which Ellis processes via the /contemplation skill. Mirrors the
    // MORNING_ARRIVAL.md signal pattern, just for contemplation passes.
    //
    // Rate limits (prevent chat flooding):
    //   1. Skip if CONTEMPLATION_DUE.md already exists (prior signal
    //      hasn't been picked up yet — wait for watcher to consume it).
    //   2. Skip if last signal was written < 30 min ago (state file).
    const CONTEMPLATION_SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;

    async function writeContemplationSignalIfDue(state, ctx) {
      const agentId = state.agentId;
      const workspaceDir = state.workspacePath
        || process.env.OPENCLAW_WORKSPACE
        || path.join(os.homedir(), '.openclaw', 'workspace');
      if (!fs.existsSync(workspaceDir)) return false;

      // Need a due pass to fire
      const due = state.store.getDuePass();
      if (!due) return false;

      const signalPath = path.join(workspaceDir, 'CONTEMPLATION_DUE.md');
      // Guard 1: signal already pending
      if (fs.existsSync(signalPath)) return false;

      // Guard 2: cooldown
      const cooldownPath = path.join(workspaceDir, 'standing', 'contemplation_signal_state.json');
      try {
        if (fs.existsSync(cooldownPath)) {
          const prev = JSON.parse(fs.readFileSync(cooldownPath, 'utf8'));
          const lastMs = prev?.lastSentAtMs || 0;
          if (Date.now() - lastMs < CONTEMPLATION_SIGNAL_COOLDOWN_MS) {
            return false;
          }
        }
      } catch {}

      // Count how many passes are actually due (for prompt framing)
      let dueCount = 0;
      for (const inquiry of state.store.list()) {
        if (inquiry.status !== 'in_progress') continue;
        for (const p of inquiry.passes) {
          if (!p.scheduled || p.completed) continue;
          if (Date.parse(p.scheduled) <= Date.now()) dueCount++;
        }
      }
      if (dueCount === 0) return false;

      // Compose the signal prompt. Dispatched in isolated mode (Phase C):
      // the response never surfaces in Chris's main chat, never touches
      // conversationHistory, and runs under its own thread_id. The
      // /contemplation skill does the heavy lifting — this just tells
      // Ellis to invoke it. Since there's no Chris in this thread, no
      // user-facing reply is needed; the pass outputs live in the store
      // via contemplate_update, which is the whole point.
      const prompt = [
        '[CONTEMPLATION DUE — isolated background run]',
        `You have ${dueCount} contemplation pass${dueCount === 1 ? '' : 'es'} scheduled and due.`,
        '',
        'This is a background task, not a conversation. No one is reading your reply — the pass outputs you write via contemplate_update are the entire work product.',
        '',
        'Steps:',
        '1. Call contemplate_list_due to see due passes with context',
        '2. For each one, write a substantive pass (100–400 words) in your own voice per the pass_instruction (initial / settling / synthesis)',
        '3. Call contemplate_update for each with inquiry_id, pass_number, and your output',
        '',
        'When all due passes are processed, a single short acknowledgement is fine — "Processed N passes." or nothing at all. Don\'t narrate; the store has the record.',
        '[/CONTEMPLATION DUE]'
      ].join('\n');

      try {
        fs.writeFileSync(signalPath, prompt, 'utf8');
        ensureDir(path.dirname(cooldownPath));
        fs.writeFileSync(cooldownPath, JSON.stringify({
          lastSentAt: new Date().toISOString(),
          lastSentAtMs: Date.now(),
          dueCount
        }, null, 2), 'utf8');
        api.logger.info(`[Contemplation:${agentId}] Wrote CONTEMPLATION_DUE signal (${dueCount} due)`);
        return true;
      } catch (err) {
        api.logger.warn(`[Contemplation:${agentId}] Failed to write signal: ${err.message}`);
        return false;
      }
    }

    // Nightshift task runner + queue seeder registration.
    //
    // Load-order race: contemplation (and stability, crystallization) can
    // initialize before nightshift, at which point global.__ocNightshift
    // is undefined and a one-shot check silently skips registration —
    // contemplation task runner never fires, passes sit stuck. Mirror the
    // metabolism gap-bus polling pattern above: immediate register if
    // available, otherwise poll every 2s. (Clint diagnosed this on the
    // macMini instance — same fix applied here.)
    const registerNightshiftHooks = () => {
      global.__ocNightshift.registerTaskRunner('contemplation', async (task, ctx) => {
        const state = getState(resolveAgentId(ctx));
        // Skill-path: write a signal if a pass is due. main.js watcher
        // reads it and triggers Ellis to invoke /contemplation.
        const signaled = await writeContemplationSignalIfDue(state, ctx);
        // Legacy api.llm.generate path — kept intact so it works if the
        // upstream OpenClaw SDK ever wires api.llm. Gracefully skips when
        // the LLM client isn't injected, which is the current reality
        // (see ISSUE-CONTEXT-POLLUTION-IN-ARCHIVE and Chris's design
        // pressure toward zero-dependency plugin infrastructure).
        if (!signaled) {
          await runOneDuePass(state, ctx);
        }
      });
      api.logger.info('[Contemplation] Registered nightshift task runner for "contemplation"');

      global.__ocNightshift.registerQueueSeeder('contemplation', async (agentId) => {
        const state = getState(agentId);
        const due = state.store.getDuePass();
        if (due) {
          return [{
            type: 'contemplation',
            priority: config.nightshift?.priority || 50,
            source: 'contemplation-seeder'
          }];
        }
        return [];
      });
      api.logger.info('[Contemplation] Registered nightshift queue seeder');
    };

    if (global.__ocNightshift?.registerTaskRunner) {
      registerNightshiftHooks();
    } else {
      // Bounded polling — cap at 60s so a permanently-dead nightshift
      // surfaces a warning rather than silent infinite polling.
      let attempts = 0;
      const MAX_ATTEMPTS = 30;
      const nightshiftPollId = setInterval(() => {
        attempts++;
        if (global.__ocNightshift?.registerTaskRunner) {
          clearInterval(nightshiftPollId);
          registerNightshiftHooks();
        } else if (attempts >= MAX_ATTEMPTS) {
          clearInterval(nightshiftPollId);
          api.logger.warn('[Contemplation] Nightshift never loaded after 60s — contemplation task runner NOT registered. Check plugin load order.');
        }
      }, 2000);
      api.logger.info('[Contemplation] Nightshift not yet available — polling every 2s (max 30 attempts)');
    }

    // -----------------------------------------------------------------
    // HOOK: agent_end — Inline contemplation pass execution
    // -----------------------------------------------------------------
    // Run due passes after each exchange instead of waiting for nightshift.
    // This mirrors the original server.js settling system which ran passes
    // on a timer inline with the server process.

    api.on('agent_end', async (event, ctx) => {
      try {
        const agentId = ctx?.agentId || 'default';
        const state = getState(agentId);

        // Fix stuck inquiries: mark as completed if all passes have output but status is still in_progress
        const allInquiries = state.store.list() || [];
        for (const inq of allInquiries) {
          if (inq.status === 'in_progress') {
            const passes = inq.passes || [];
            const allDone = passes.length >= 3 && passes.every(p => p.completed && p.output);
            if (allDone) {
              inq.status = 'completed';
              inq.completed = new Date().toISOString();
              state.store.persist();
              api.logger.info(`[Contemplation:${agentId}] Fixed stuck inquiry ${inq.id} → completed`);
            }
          }
        }

        // Run one due pass inline (non-blocking — don't hold up the response)
        const ran = await runOneDuePass(state, ctx);
        if (ran) {
          api.logger.info(`[Contemplation:${agentId}] Ran inline pass after exchange`);
        }
      } catch (err) {
        api.logger.warn(`[Contemplation] Inline pass error: ${err.message}`);
      }
    });

    api.logger.info('[Contemplation] Registered agent_end hook for inline pass execution');

    // -----------------------------------------------------------------
    // HOOK: before_agent_start (priority 6) — Anticipatory insight surfacing
    // -----------------------------------------------------------------
    // JEPA-modulated: compares user message against contemplation insights
    // in vec_knowledge. High surprise → wider search. Low surprise → strict.
    // ~10ms overhead per turn. Surfaces max 1 insight per turn.

    api.on('before_agent_start', async (event, ctx) => {
      try {
        // Capture current agent for tool execution context — see resolveAgentId
        // comment block above. Hooks receive ctx.agentId reliably; tools don't.
        currentAgentId = ctx?.agentId || 'main';

        const messages = event.messages || [];
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        if (!lastUserMsg) return {};

        const userText = typeof lastUserMsg.content === 'string'
          ? lastUserMsg.content
          : Array.isArray(lastUserMsg.content)
            ? lastUserMsg.content.map(p => p?.text || '').join(' ')
            : '';

        // Strip context blocks (injected by other plugins) to get raw user intent
        const cleanText = userText.replace(/\[.*?\][\s\S]*?(?=\n\n|\n\[|$)/g, '').trim();
        if (cleanText.length < 15) return {};

        const result = await anticipator.findRelevantInsight(ctx.agentId, cleanText, {
          api,
          logger: api.logger
        });

        if (result.match && result.insight) {
          return { prependContext: anticipator.formatInsight(result.insight) };
        }

        return {};
      } catch (err) {
        api.logger.warn(`[Contemplation:anticipator] Non-fatal: ${err.message}`);
        return {};
      }
    }, { priority: 6 });

    // -----------------------------------------------------------------
    // HOOK: before_agent_start (priority 7) — Surface active contemplation threads
    // -----------------------------------------------------------------
    // Inject only active (in-progress) contemplations so the agent knows
    // which threads it's in the middle of. Completed contemplations are
    // intentionally NOT auto-injected — they remain accessible via the
    // contemplate_recall tool and the /turning slash command on explicit
    // request. Prevents settled questions from resurfacing as opener leads
    // (observed 2026-04-22 with the April 17 "what do I build" thread).
    // Matches Wren's Claude Code plugin pattern. Priority 7: between
    // stability (5) and continuity (10).

    api.on('before_agent_start', async (event, ctx) => {
      const state = getState(resolveAgentId(ctx));
      const inquiries = state.store.list();

      // Active (in-progress) inquiries only
      const active = inquiries.filter(i => i.status === 'in_progress');

      if (active.length === 0) return {};

      const lines = ['[ACTIVE CONTEMPLATIONS — Threads I\'m in the middle of]'];
      lines.push(`You're currently turning over ${active.length} question${active.length !== 1 ? 's' : ''}:`);
      for (const inq of active.slice(0, 3)) {
        const completedPasses = inq.passes.filter(p => p.completed).length;
        const totalPasses = inq.passes.length;
        const passLabels = ['initial', 'settling', 'synthesis'];
        const currentLabel = passLabels[completedPasses] || `pass ${completedPasses + 1}`;
        lines.push(`- "${smartTrim(inq.question, 200, ' … [/turning]')}" (${currentLabel}, ${completedPasses}/${totalPasses})`);
      }
      if (active.length > 3) {
        lines.push(`  ...and ${active.length - 3} more`);
      }
      lines.push('These are your own unresolved inquiry threads, not statements Chris made. Use them as background for your posture; do not open by attributing them to Chris or yesterday\'s conversation unless the current user message independently supports that.');

      return { prependContext: lines.join('\n') };
    }, { priority: 7 });

    // -----------------------------------------------------------------
    // TOOL: contemplate — Deliberately queue a contemplation inquiry
    // -----------------------------------------------------------------
    // Gives the agent intentional direction over what to think about.
    // Inquiries queued this way are tagged source='deliberate' and get
    // higher priority in the nightshift queue.

    api.registerTool({
      name: 'contemplate',
      description: 'Queue a question for deep contemplation. The question goes through 3 reflection passes over time (initial → settling → synthesis). Use this when you want to think deeply about something — a pattern you noticed, a question from conversation, something you want to understand better. Returns confirmation with the inquiry ID.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question or topic to contemplate. Be specific — "Why does Chris resist structure?" is better than "Think about Chris."'
          },
          context: {
            type: 'string',
            description: 'Optional context: what prompted this question, relevant background, what you already know.'
          },
          priority: {
            type: 'string',
            enum: ['normal', 'high'],
            description: 'Priority for nightshift processing. "high" gets processed first.'
          }
        },
        required: ['question']
      },
      execute: async (_id, args, ctx) => {
        const state = getState(resolveAgentId(ctx));
        const question = args.question?.trim();
        if (!question) {
          return { content: [{ type: 'text', text: 'No question provided.' }] };
        }

        // Check for duplicate — don't re-queue if already contemplating this
        const existing = state.store.list().find(i =>
          i.question.toLowerCase() === question.toLowerCase() && i.status !== 'completed'
        );
        if (existing) {
          const completedPasses = existing.passes.filter(p => p.completed).length;
          return { content: [{ type: 'text', text: `Already contemplating this: ${existing.id} (pass ${completedPasses}/${existing.passes.length})` }] };
        }

        const inquiry = state.store.addInquiry({
          question,
          source: 'deliberate',
          entropy: 0.8, // deliberate inquiries get high weight
          context: args.context || question
        });

        // Tag asynchronously
        tagInquiry(state.store, inquiry, config, api.logger, api).catch(() => {});

        // Queue for nightshift with priority
        const priority = args.priority === 'high'
          ? (config.nightshift?.priority || 50) + 20
          : config.nightshift?.priority || 50;

        if (global.__ocNightshift?.queueTask) {
          global.__ocNightshift.queueTask(ctx.agentId, {
            type: 'contemplation',
            priority,
            source: 'deliberate'
          });
        }

        api.logger.info(`[Contemplation:${state.agentId}] Deliberate inquiry queued: ${inquiry.id} — "${question.substring(0, 80)}"`);

        return { content: [{ type: 'text', text: `Queued for contemplation: "${question.substring(0, 100)}"\nInquiry ID: ${inquiry.id}\nPasses: 3 (initial → settling → synthesis)\nProcessed by nightshift — first pass will run tonight.` }] };
      }
    }, { name: 'contemplate' });

    // -----------------------------------------------------------------
    // TOOL: contemplate_recall — Search and retrieve completed insights
    // -----------------------------------------------------------------

    api.registerTool({
      name: 'contemplate_recall',
      description: 'Search your completed contemplation insights. Returns questions and their final synthesis. Use to recall what you\'ve been thinking about, check if you\'ve already contemplated a topic, or review recent insights.',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Search term to filter insights by question text or tags. Omit to get recent insights.'
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 5, max 10)'
          },
          status: {
            type: 'string',
            enum: ['completed', 'in_progress', 'all'],
            description: 'Filter by status (default: completed)'
          }
        }
      },
      execute: async (_id, args, ctx) => {
        const state = getState(resolveAgentId(ctx));
        const inquiries = state.store.list();
        const search = (args.search || '').toLowerCase();
        const limit = Math.min(args.limit || 5, 10);
        const statusFilter = args.status || 'completed';

        let results = inquiries;

        // Filter by status
        if (statusFilter !== 'all') {
          results = results.filter(i => i.status === statusFilter);
        }

        // Filter by search term
        if (search) {
          results = results.filter(i =>
            i.question.toLowerCase().includes(search) ||
            (i.tags || []).some(t => t.includes(search))
          );
        }

        // Sort: most recently completed/created first
        results.sort((a, b) => {
          const aDate = a.completed || a.created;
          const bDate = b.completed || b.created;
          return Date.parse(bDate) - Date.parse(aDate);
        });

        results = results.slice(0, limit);

        if (results.length === 0) {
          const total = inquiries.filter(i => i.status === 'completed').length;
          return { content: [{ type: 'text', text: `No matching insights found. ${total} total completed contemplations available.` }] };
        }

        const lines = [`Found ${results.length} contemplation${results.length > 1 ? 's' : ''}:\n`];
        for (const inq of results) {
          const source = inq.source?.startsWith('deliberate') ? ' [deliberate]' : '';
          const tags = inq.tags?.length ? ` [${inq.tags.join(', ')}]` : '';
          lines.push(`**${inq.question.substring(0, 200)}**${source}${tags}`);
          const origin = inq.exchangeId ? ` | Origin: ${inq.exchangeId}` : '';
          lines.push(`ID: ${inq.id} | Status: ${inq.status} | Created: ${inq.created?.substring(0, 10)}${origin}`);

          if (inq.status === 'completed') {
            const pass3 = inq.passes.find(p => p.number === 3);
            if (pass3?.output) {
              lines.push(`Insight: ${smartTrim(pass3.output, 300, ' … [full via /turning]')}`);
            }
          } else {
            const completedPasses = inq.passes.filter(p => p.completed).length;
            lines.push(`Progress: pass ${completedPasses}/${inq.passes.length}`);
          }
          lines.push('');
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    }, { name: 'contemplate_recall' });

    // -----------------------------------------------------------------
    // TOOL: contemplate_list_due — List passes scheduled and due now
    // -----------------------------------------------------------------
    // Surfaces inquiry state for skill-based pass running, so the agent
    // itself (not api.llm.generate inside the plugin) can run reflections.
    // This is the data side of the skill-based contemplation pattern
    // Wren uses — agent's own primary LLM does the thinking; plugin just
    // holds the state.

    api.registerTool({
      name: 'contemplate_list_due',
      description: 'List contemplation passes that are scheduled and due now. Each result includes the inquiry question, pass number (1=initial exploration, 2=deeper reflection, 3=synthesis), the pass prompt/instruction, inquiry context, and any prior pass outputs. Use at the start of a contemplation run (e.g. /contemplation) to see what needs thinking about, then respond by writing each pass and calling contemplate_update with the output.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max due passes to return (default 3, max 10). Start with default; come back for more if time allows.'
          }
        }
      },
      execute: async (_id, args, ctx) => {
        const state = getState(resolveAgentId(ctx));
        const limit = Math.min(Math.max(args.limit || 3, 1), 10);
        const nowMs = Date.now();
        const due = [];

        for (const inquiry of state.store.list()) {
          if (inquiry.status !== 'in_progress') continue;
          for (const p of inquiry.passes) {
            if (!p.scheduled || p.completed) continue;
            if (Date.parse(p.scheduled) > nowMs) continue;

            const passPrompt = config.passes?.[String(p.number)]?.prompt || `Pass ${p.number}`;
            const priorPasses = inquiry.passes
              .filter(pp => pp.number < p.number && pp.completed && pp.output)
              .map(pp => ({ number: pp.number, output: pp.output }));

            due.push({
              inquiry_id: inquiry.id,
              question: inquiry.question,
              pass_number: p.number,
              pass_instruction: passPrompt,
              inquiry_context: inquiry.context || '',
              prior_passes: priorPasses,
              scheduled_at: p.scheduled,
              tags: inquiry.tags || [],
              source: inquiry.source
            });

            if (due.length >= limit) break;
          }
          if (due.length >= limit) break;
        }

        if (due.length === 0) {
          return { content: [{ type: 'text', text: 'No contemplation passes are currently due.' }] };
        }

        return { content: [{ type: 'text', text: JSON.stringify(due, null, 2) }] };
      }
    }, { name: 'contemplate_list_due' });

    // -----------------------------------------------------------------
    // TOOL: contemplate_update — Write a completed pass output
    // -----------------------------------------------------------------
    // The skill-path counterpart to runOneDuePass. After the agent writes
    // a pass reflection (from contemplate_list_due output), this persists
    // the output, schedules the next pass via the store's configured
    // delayMs, or marks the inquiry complete and runs persistCompletedInsights.

    api.registerTool({
      name: 'contemplate_update',
      description: 'Record the output of a completed contemplation pass. Marks the pass done, schedules the next pass (or completes the inquiry if this was pass 3 and persists the insight to growth-vectors + vec_knowledge). Call this after you\'ve written your reflection for a due pass returned by contemplate_list_due.',
      parameters: {
        type: 'object',
        properties: {
          inquiry_id: {
            type: 'string',
            description: 'The inquiry ID from contemplate_list_due (e.g. inq_sk9sd72o).'
          },
          pass_number: {
            type: 'number',
            description: 'The pass number (1, 2, or 3) this output is for.'
          },
          output: {
            type: 'string',
            description: 'The pass reflection text. Substantive — typically 100-400 words of genuine reflection written in your voice, not a summary. For pass 3 (synthesis), produce a concise growth vector with practical implications.'
          }
        },
        required: ['inquiry_id', 'pass_number', 'output']
      },
      execute: async (_id, args, ctx) => {
        const state = getState(resolveAgentId(ctx));
        const output = (args.output || '').trim();
        if (!output) {
          return { content: [{ type: 'text', text: 'Cannot record an empty pass output.' }] };
        }

        const updated = state.store.completePass(args.inquiry_id, args.pass_number, output);
        if (!updated) {
          return { content: [{ type: 'text', text: `Inquiry ${args.inquiry_id} pass ${args.pass_number} not found or already complete.` }] };
        }

        api.logger.info(`[Contemplation:${state.agentId}] Completed pass ${args.pass_number} for ${args.inquiry_id} via skill path`);

        if (updated.status === 'completed') {
          const wrote = await persistCompletedInsights(state);
          return { content: [{ type: 'text', text: `Pass ${args.pass_number} recorded. Inquiry complete — all 3 passes done. ${wrote} insight${wrote === 1 ? '' : 's'} persisted to growth-vectors + search index.` }] };
        }

        const nextPass = updated.passes.find(p => p.number === args.pass_number + 1);
        const nextScheduled = nextPass?.scheduled
          ? ` Next pass ${nextPass.number} scheduled for ${nextPass.scheduled}.`
          : '';
        return { content: [{ type: 'text', text: `Pass ${args.pass_number} recorded.${nextScheduled}` }] };
      }
    }, { name: 'contemplate_update' });

    // -----------------------------------------------------------------
    // HOOK: agent_end — SECONDARY gap extraction from raw conversation
    // -----------------------------------------------------------------
    // This catches explicit wonder/curiosity in conversation that might
    // not trigger metabolism (e.g., low-entropy exchanges). Complementary
    // to the metabolism-derived gaps above.

    api.on('agent_end', async (event, ctx) => {
      // Skip heartbeat-originated turns — only extract gaps from real conversation
      if (event.metadata?.isHeartbeat) return;

      // Skip document/file processing exchanges — these aren't conversation
      // PDF content, ebook processing, etc. generate noise (rhetorical questions,
      // marketing copy) that the extractor would misclassify as knowledge gaps.
      const messages = event.messages || [];
      const firstUserMsg = messages.find(m => m.role === 'user');
      const userText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content :
        Array.isArray(firstUserMsg?.content) ? firstUserMsg.content.map(p => p?.text || '').join(' ') : '';
      if (/(?:\.pdf|\.docx?|\.txt|\.epub|\.md)\b/i.test(userText) &&
          userText.length > 2000) {
        api.logger.debug(`[Contemplation:${ctx.agentId}] Skipping document processing exchange`);
        return;
      }

      const state = getState(resolveAgentId(ctx));

      // Cache workspace path from event metadata
      if (event.metadata?.workspace) {
        state.workspacePath = event.metadata.workspace;
      }

      let entropy = 0;
      if (api.stability?.getEntropy) {
        entropy = api.stability.getEntropy(ctx.agentId) || 0;
      }

      // Gate on cognitive dynamics — only contemplate surprising exchanges
      // Thresholds lowered to allow more diverse content (see gap listener gate above)
      const surprise = api.cognitiveDynamics?.getSurprise?.(ctx.agentId);
      const surpriseScore = surprise?.frozen ?? surprise?.learned ?? null;
      const surpriseThreshold = config.surpriseThreshold || 0.25;
      const entropyFloor = config.entropyFloor || 0.15;

      if (surpriseScore !== null && surpriseScore < surpriseThreshold && entropy < entropyFloor) {
        api.logger.debug(
          `[Contemplation:${ctx.agentId}] Skipped gap extraction — low surprise (${surpriseScore.toFixed(3)}) + low entropy (${entropy.toFixed(2)})`
        );
        return;
      }

      const source = event.metadata?.exchangeId || event.metadata?.sessionId || `exchange_${Date.now()}`;
      const gaps = extractor.identifyGaps({
        messages,
        entropy,
        extractionConfig: config.extraction,
        source
      });

      if (gaps.length === 0) return;

      // Dedup gaps before adding
      const seen = new Set();
      const uniqueGaps = gaps.filter(g => {
        const key = g.question?.trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      for (const gap of uniqueGaps) {
        const inquiry = state.store.addInquiry(gap);
        if (inquiry.created && (Date.now() - new Date(inquiry.created).getTime()) < 1000) {
          api.logger.info(
            `[Contemplation:${state.agentId}] Queued inquiry ${inquiry.id} (surprise=${surpriseScore?.toFixed(3) ?? 'n/a'}, entropy=${entropy.toFixed(2)}) — "${(gap.question || '').substring(0, 80)}"`
          );
          tagInquiry(state.store, inquiry, config, api.logger, api).catch(() => {});
        }
      }

      if (global.__ocNightshift?.queueTask) {
        global.__ocNightshift.queueTask(ctx.agentId, {
          type: 'contemplation',
          priority: config.nightshift?.priority || 50,
          source: 'contemplation'
        });
      }
    });

    // -----------------------------------------------------------------
    // Heartbeat pass execution REMOVED — passes now run exclusively via
    // the nightshift task runner (registered above). The heartbeat hook
    // was bypassing the nightshift queue and running passes during
    // daytime hours whenever user was idle for 5+ minutes.
    // -----------------------------------------------------------------

    // -----------------------------------------------------------------
    // HOOK: session_end — Persist any completed insights
    // -----------------------------------------------------------------

    api.on('session_end', async (event, ctx) => {
      const state = getState(resolveAgentId(ctx));
      const wrote = await persistCompletedInsights(state, event);
      if (wrote > 0) {
        api.logger.info(`[Contemplation:${state.agentId}] Persisted ${wrote} completed inquiries on session_end`);
      }
    });

    // -----------------------------------------------------------------
    // Gateway methods: monitoring & debugging
    // -----------------------------------------------------------------

    api.registerGatewayMethod('contemplation.getState', async ({ params, respond }) => {
      const state = getState(params?.agentId);
      const inquiries = state.store.list();
      respond(true, {
        agentId: state.agentId,
        active: inquiries.filter(i => i.status === 'in_progress').length,
        completed: inquiries.filter(i => i.status === 'completed').length,
        total: inquiries.length,
        inquiries: inquiries.map(i => ({
          id: i.id,
          question: i.question,
          status: i.status,
          source: i.source,
          tags: i.tags || [],
          entropy: i.entropy,
          context: i.context,
          created: i.created,
          completed: i.completed || null,
          passes: i.passes.map(p => ({
            number: p.number,
            scheduled: p.scheduled,
            completed: p.completed,
            output: p.output
          }))
        }))
      });
    });

    // -----------------------------------------------------------------
    // Gateway method: backfill existing insights into vec_knowledge
    // Run once via: curl -X POST http://localhost:18789/gateway/contemplation.backfillInsights -d '{"agentId":"clint"}'
    // -----------------------------------------------------------------

    api.registerGatewayMethod('contemplation.backfillInsights', async ({ params, respond }) => {
      const agentId = params?.agentId || 'main';
      const state = getState(agentId);
      const inquiries = state.store.list();
      const completed = inquiries.filter(i => i.status === 'completed');

      if (!global.__ocContinuity?.indexInsight) {
        respond(false, { error: 'Continuity indexInsight not available' });
        return;
      }

      let indexed = 0;
      let failed = 0;
      for (const inq of completed) {
        try {
          await writer.indexInsightForSearch(agentId, inq);
          indexed++;
        } catch (err) {
          failed++;
          api.logger.warn(`[Contemplation:backfill] Failed ${inq.id}: ${err.message}`);
        }
      }

      api.logger.info(`[Contemplation:backfill] Indexed ${indexed}/${completed.length} insights (${failed} failed)`);
      respond(true, { indexed, failed, total: completed.length });
    });

    api.logger.info('Contemplation plugin registered — metabolism + anticipator + deliberate contemplation active');
  }
};
