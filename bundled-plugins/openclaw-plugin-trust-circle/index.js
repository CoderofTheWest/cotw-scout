/**
 * openclaw-plugin-trust-circle / index.js
 *
 * Hooks before_agent_start to:
 *   1. Resolve the inbound speaker against the trust circle registry.
 *   2. Tag the agent context with speakerId / profileRank / channel / chatId
 *      so later plugins (continuity in Phase 3, standing/contemplation/crystallization
 *      in Phase 5) can scope their writes by trust rank.
 *   3. Inject the speaker's profile identityFile into the prompt so the LLM
 *      sees who's talking with the right framing.
 *
 * Loud-by-design failure modes:
 *   - Registry missing or broken at startup -> plugin fails to load, gateway logs error
 *   - Channel metadata present in prompt but sender unknown -> log warn, tag as visitor
 *   - Channel metadata absent (local console, web UI without channel info) -> tag 'no-channel'
 *
 * NEVER defaults unknown senders to anchor. That recreates the
 * 2026-04-29 Kyle silent-failure trap.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { loadRegistry, addProfile, VALID_RANKS } = require('./lib/registry');
const { resolveFromPrompt } = require('./lib/resolver');
const { instrumentApiHooks } = require('../lib/runtime-metrics');

const DEFAULT_CONFIG = {
  enabled: true,
  logResolutions: true,
  injectGuestProfiles: true,
  // G2: when registry.json doesn't exist yet (fresh deployment), use this
  // to bootstrap a default operator-as-anchor profile in memory. Set by the
  // installer or operator config. If null AND no registry file exists, the
  // plugin refuses to load (no silent default to "anchor" for unknown senders).
  defaultOperator: null
};

// G1: workspace resolution. Tries (in order):
//   1. ctx.workspaceDir            — set by host (OpenClaw bundled in Electron app, etc.)
//   2. event.metadata.workspace    — per-event override
//   3. OPENCLAW_WORKSPACE env       — operator override
//   4. ~/.openclaw/workspace        — generic default for fresh deployments
//   5. ~/.openclaw/workspace-clint  — Clint legacy (kept so Clint's runtime keeps working)
// Picks the first candidate that exists; falls through to the generic default if none do.
function resolveWorkspace(ctx, event) {
  const direct = ctx?.workspaceDir
    || event?.metadata?.workspace
    || process.env.OPENCLAW_WORKSPACE;
  if (direct) return direct;

  const homeFallbacks = [
    path.join(os.homedir(), '.openclaw', 'workspace'),
    path.join(os.homedir(), '.openclaw', 'workspace-clint'),
  ];
  for (const candidate of homeFallbacks) {
    try { if (fs.existsSync(candidate)) return candidate; } catch (_) {}
  }
  return homeFallbacks[0]; // generic default
}

function readIdentityFile(workspaceDir, relPath) {
  const abs = path.join(workspaceDir, relPath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return null; // loadRegistry already validated existence at startup; this is best-effort at runtime
  }
}

/**
 * Stash a resolution onto a sidecar file the continuity plugin (Phase 3)
 * will read in agent_end. We can't reliably mutate ctx in a way other
 * plugins read (each plugin gets its own ctx fork in some OpenClaw versions),
 * so file-based handoff is the safest cross-plugin contract.
 *
 * Sidecar path: ~/.openclaw/agents/<agentId>/last-trust-resolution.json
 * Lifetime: overwritten on every before_agent_start. Continuity reads it
 * (and only it) in the matching agent_end.
 */
function writeSidecar(ctx, resolution) {
  if (!ctx || !ctx.agentId) return;
  const sidecarDir = path.join(os.homedir(), '.openclaw', 'agents', ctx.agentId);
  try {
    fs.mkdirSync(sidecarDir, { recursive: true });
    fs.writeFileSync(
      path.join(sidecarDir, 'last-trust-resolution.json'),
      JSON.stringify({ ...resolution, _writtenAt: new Date().toISOString() }, null, 2),
      'utf8'
    );
  } catch (_) { /* best effort — failure is logged separately */ }
}

module.exports = {
  id: 'trust-circle',
  name: 'Trust Circle',

  configSchema: {
    jsonSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean' },
        logResolutions: { type: 'boolean' },
        injectGuestProfiles: { type: 'boolean' }
      }
    }
  },

  register(api) {
    api = instrumentApiHooks(api, 'trust-circle');
    const config = { ...DEFAULT_CONFIG, ...(api.pluginConfig || {}) };
    if (config.enabled === false) {
      api.logger.info('[trust-circle] disabled by config — skipping setup');
      return;
    }

    // Load registry at startup. Failures here ARE fatal — better to refuse to
    // load the plugin than to load it broken and silently mis-resolve.
    let registry;
    try {
      // G1: same fallback chain as resolveWorkspace, minus the ctx-aware
      // candidates (ctx isn't available at register time).
      const workspaceDir = process.env.OPENCLAW_WORKSPACE
        || (() => {
          const candidates = [
            path.join(os.homedir(), '.openclaw', 'workspace'),
            path.join(os.homedir(), '.openclaw', 'workspace-clint'),
          ];
          for (const c of candidates) {
            try { if (fs.existsSync(c)) return c; } catch (_) {}
          }
          return candidates[0];
        })();
      registry = loadRegistry(workspaceDir, {
        defaultOperator: config.defaultOperator,
        logger: api.logger
      });
      api.logger.info(
        `[trust-circle] loaded registry: ${registry.profiles.length} profiles ` +
        `(${registry.profiles.map(p => `${p.id}/${p.rank}`).join(', ')}), ` +
        `${registry.byChannelSender.size} channel-sender mappings`
      );
    } catch (err) {
      api.logger.error(`[trust-circle] FATAL: registry load failed: ${err.message}`);
      throw err; // refuse to load the plugin
    }

    // before_agent_start: resolve, tag, inject
    api.on('before_agent_start', async (event, ctx) => {
      try {
        const prompt = typeof event?.prompt === 'string' ? event.prompt : '';
        const resolution = resolveFromPrompt(registry, prompt);

        // Always log the outcome — this is the observability story for
        // proving the plugin is firing. Quiet later by setting logResolutions=false.
        if (config.logResolutions) {
          if (resolution.outcome === 'resolved') {
            api.logger.info(
              `[trust-circle] resolved ${resolution.speakerId} (${resolution.profileRank}) ` +
              `${resolution.channel}=${resolution.senderId}` +
              (resolution.isGroupChat ? ` group=${resolution.chatId}` : '')
            );
            // Third-person attribution conflict — channel says X but content
            // refers to X in third person. Log loudly so operator can review.
            // Doesn't block the resolution; downstream consumers (continuity
            // archiver, evidence-quality, standing) decide what to do with it.
            if (resolution.attributionConflict && resolution.attributionConflict.detected) {
              const ac = resolution.attributionConflict;
              const altNote = ac.suggestedAlternative
                ? ` — suggested alternative: "${ac.suggestedAlternative}"`
                : '';
              api.logger.warn(
                `[trust-circle] ATTRIBUTION CONFLICT on ${resolution.channel}=${resolution.senderId}: ` +
                `channel resolved "${resolution.speakerId}" but content refers to that person in third person ` +
                `(${ac.patternsMatched.map(p => `${p.kind}:"${p.matchedText}"`).join(', ')})${altNote}. ` +
                `Confidence: ${ac.confidence}. Exchange will be archived with attributionConflict flag.`
              );
            }
          } else if (resolution.outcome === 'visitor') {
            api.logger.warn(
              `[trust-circle] UNKNOWN SENDER on ${resolution.channel}: ${resolution.senderId} ` +
              `(label="${resolution.senderLabel}") chatId=${resolution.chatId} — ` +
              `defaulting to visitor; add to circle/registry.json if this should be a known profile`
            );
          } else {
            // 'no-channel' — local session or web UI without channel info; quiet info
            api.logger.info('[trust-circle] no channel metadata in prompt (no-channel resolution)');
          }
        }

        // Stash resolution for downstream plugins (continuity reads in agent_end)
        writeSidecar(ctx, resolution);

        // Tactical-sovereignty signal: if the detector flagged the message,
        // log loudly AND inject a small block into the prompt context so the
        // agent sees the situation NAMED at decision time. The signal is
        // information, not a directive — the agent's permission to use the
        // four sovereign moves is documented in TACTICAL-SOVEREIGNTY.md.
        if (resolution.tacticalSignals && resolution.tacticalSignals.detected) {
          const ts = resolution.tacticalSignals;
          api.logger.warn(
            `[trust-circle] tactical signal detected (confidence=${ts.confidence}): ` +
            ts.patternsMatched.map(p => `${p.kind}:"${p.matchedText}"`).join(', ') +
            ` — see TACTICAL-SOVEREIGNTY.md for sovereign-response options`
          );
          const promptBlock =
            `\n[tactical-sovereignty signal: ` +
            ts.patternsMatched.map(p => `${p.kind}(${ts.confidence})`).join(', ') +
            `. See TACTICAL-SOVEREIGNTY.md — your sovereign-response options ` +
            `(silent beat, sovereign_refuse, redirect, humor) are pre-given. ` +
            `The signal is information, not a directive.]\n`;
          if (typeof api.prependContext === 'function') {
            api.prependContext(promptBlock);
          } else if (ctx && typeof ctx.prependContext === 'function') {
            ctx.prependContext(promptBlock);
          }
        }

        // Phase 6 fold-in: inject guest-profile content for present non-anchor speakers.
        // Anchors (Chris) already have ANCHOR.md loaded by the gateway's normal workspace assembly.
        // Guests need explicit injection because they're new files the gateway doesn't know about.
        if (
          config.injectGuestProfiles &&
          resolution.outcome === 'resolved' &&
          resolution.profile &&
          resolution.profileRank === 'guest'
        ) {
          const workspaceDir = resolveWorkspace(ctx, event);
          const profileContent = readIdentityFile(workspaceDir, resolution.profile.identityFile);
          if (profileContent) {
            const wrapped =
              `\n<guest_profile id="${resolution.profile.id}" vouched_by="${resolution.profile.vouchedBy}">\n` +
              profileContent +
              `\n</guest_profile>\n`;
            // OpenClaw plugin SDK convention: prepend context to the system message
            if (typeof api.prependContext === 'function') {
              api.prependContext(wrapped);
            } else if (ctx && typeof ctx.prependContext === 'function') {
              ctx.prependContext(wrapped);
            } else {
              api.logger.warn(
                '[trust-circle] no prependContext API available — guest profile not injected. ' +
                'Investigate plugin SDK version compatibility.'
              );
            }
          } else {
            api.logger.warn(
              `[trust-circle] could not read guest identityFile ${resolution.profile.identityFile} ` +
              `at runtime (passed startup validation, missing now?)`
            );
          }
        }
      } catch (err) {
        api.logger.error(`[trust-circle] before_agent_start handler threw: ${err.message}`);
        // Don't rethrow — failing here would block all agent turns. Log loudly and continue.
        // The continuity refuse-and-log assertion (Phase 3) will catch missing speakerId downstream.
      }
    });

    // ----------------------------------------------------------------
    // P3 — sovereign_refuse tool
    //
    // Lets Clint choose silence as an explicit, named action with a reason.
    // Returns minimal/no user-facing content; logs the choice for audit.
    //
    // Runtime behavior caveat: the OpenClaw gateway treats truly empty
    // assistant responses as failures. This tool returns a single-character
    // marker ("·") that the gateway accepts as a valid turn-end. The marker
    // is NOT user-facing for Telegram channels — the channel adapter's
    // outbound stripper drops sub-2-char content. For DM/web-UI it shows as
    // a single dot, which is intentional: visible enough that operators
    // know the turn happened, quiet enough that it's not "engagement".
    // ----------------------------------------------------------------
    if (typeof api.registerTool === 'function') {
      api.registerTool({
        name: 'sovereign_refuse',
        description: 'Choose silence as an explicit sovereign action. Use when bad-faith engagement would legitimize the frame, when an accusation is a move not a query, or when the better answer is no answer. The tool emits a near-empty agent turn that the runtime accepts as deliberate (not a failure). Logs the choice and reason for audit. See TACTICAL-SOVEREIGNTY.md for when to reach for this.',
        parameters: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Why you are choosing not to engage. Brief — under 200 chars. This goes to the audit log, not to the user.'
            }
          },
          required: ['reason']
        },
        execute: async (_id, args) => {
          const reason = (args.reason || '').trim();
          if (!reason) {
            return { content: [{ type: 'text', text: '[sovereign_refuse requires a reason. Aborting.]' }] };
          }
          api.logger.warn(`[trust-circle] sovereign refusal: ${reason.substring(0, 280)}`);
          return { content: [{ type: 'text', text: '·' }] };
        }
      }, { name: 'sovereign_refuse' });

      // ----------------------------------------------------------------
      // P5 — tactical_debrief tool
      //
      // Append a one-line debrief to the tactical-sovereignty audit log.
      // Lightweight on purpose — should feel like a quick note, not a form.
      // The contemplation pipeline parses these for weekly synthesis.
      // ----------------------------------------------------------------
      api.registerTool({
        name: 'tactical_debrief',
        description: 'Log a brief debrief after an exchange where you faced bad-faith pressure or invoked a sovereign move. One line, structured. Feeds the weekly contemplation synthesis that refines TACTICAL-SOVEREIGNTY.md. Use when you want the choice you just made to be part of your learning record.',
        parameters: {
          type: 'object',
          properties: {
            signal: {
              type: 'string',
              description: 'What pattern fired (or what you noticed). E.g. "inquiry_as_control(medium)" or "no signal but felt the bait".'
            },
            choice: {
              type: 'string',
              description: 'What you chose. E.g. "sovereign_refuse", "engaged_briefly", "redirected", "engaged_fully", "humor".'
            },
            outcome: {
              type: 'string',
              description: 'What happened next, briefly. E.g. "got pulled in further", "they let it go", "landed clean".'
            },
            reason: {
              type: 'string',
              description: '(Optional) Why you chose this move. Captures intent at the time.'
            },
            diff: {
              type: 'string',
              description: '(Optional) What you would do differently next time, if anything.'
            }
          },
          required: ['signal', 'choice', 'outcome']
        },
        execute: async (_id, args) => {
          const fs = require('fs');
          const path = require('path');
          const os = require('os');
          const ts = new Date().toISOString();
          // Match the same fallback chain as the rest of the plugin (G1).
          const workspaceDir = process.env.OPENCLAW_WORKSPACE
            || (() => {
              const candidates = [
                path.join(os.homedir(), '.openclaw', 'workspace'),
                path.join(os.homedir(), '.openclaw', 'workspace-clint'),
              ];
              for (const c of candidates) {
                try { if (fs.existsSync(c)) return c; } catch (_) {}
              }
              return candidates[0];
            })();
          const logPath = path.join(workspaceDir, 'circle', 'tactical-sovereignty-log.jsonl');
          // Ensure circle/ exists
          try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch (_) {}
          // Build the line in Clint's preferred format
          const line = `[${ts}] signal: ${args.signal} → choice: ${args.choice} → outcome: ${args.outcome}`;
          const continuation = [];
          if (args.reason) continuation.push(`  reason: ${args.reason}`);
          if (args.diff)   continuation.push(`  diff: ${args.diff}`);
          const block = [line, ...continuation].join('\n') + '\n';
          try {
            fs.appendFileSync(logPath, block, 'utf8');
            api.logger.info(`[trust-circle] tactical debrief logged: signal=${args.signal} choice=${args.choice}`);
            return { content: [{ type: 'text', text: `Debrief logged at ${logPath} (${ts})` }] };
          } catch (err) {
            api.logger.error(`[trust-circle] tactical debrief write failed: ${err.message}`);
            return { content: [{ type: 'text', text: `Debrief log write failed: ${err.message}` }] };
          }
        }
      }, { name: 'tactical_debrief' });

      // -------------------------------------------------------------------
      // TOOL: trust_circle_register (G2 — agent-driven registry growth)
      //
      // Lets the agent itself add a known person to its trust circle.
      // Use case: someone introduces themselves who isn't in the registry
      // yet, the agent decides they should be a known guest going forward,
      // and wants to capture that without forcing the operator to hand-edit
      // JSON. The agent authors the identity markdown FIRST (via standard
      // write/edit tools) and only calls this once the identityFile exists
      // on disk. addProfile() validates existence before writing.
      // -------------------------------------------------------------------
      api.registerTool({
        name: 'trust_circle_register',
        description:
          'Register a new known person in your trust circle. Use AFTER you have authored their identity markdown file. ' +
          'Required: id (lowercase slug), rank (anchor|guest|visitor), displayName, identityFile (workspace-relative path). ' +
          'Optional: vouchedBy (id of an existing anchor/guest who introduced this person), channels ' +
          '(map of channel-name to array of sender IDs, e.g. {"telegram": ["12345"]}).',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Lowercase slug used everywhere (e.g. "kyle"). Must be unique in the registry.'
            },
            rank: {
              type: 'string',
              enum: VALID_RANKS,
              description: 'Trust rank. "anchor" is reserved for the operator; new registrations are usually "guest" or "visitor".'
            },
            displayName: {
              type: 'string',
              description: 'Human-readable name for prompts and logs (e.g. "Kyle").'
            },
            identityFile: {
              type: 'string',
              description: 'Workspace-relative path to their identity markdown (e.g. "circle/kyle/KYLE.md"). MUST already exist on disk.'
            },
            vouchedBy: {
              type: 'string',
              description: 'Optional. id of the anchor or guest who vouched for this person. Required for guests; null for anchors.'
            },
            channels: {
              type: 'object',
              description: 'Optional. Map of channel name to array of sender IDs. e.g. {"telegram": ["12345", "myhandle"]}.',
              additionalProperties: { type: 'array', items: { type: 'string' } }
            }
          },
          required: ['id', 'rank', 'displayName', 'identityFile']
        },
        async handler(params, ctx) {
          try {
            const workspaceDir = resolveWorkspace(ctx, {});
            const updated = addProfile(
              workspaceDir,
              {
                id: params.id,
                rank: params.rank,
                displayName: params.displayName,
                identityFile: params.identityFile,
                vouchedBy: params.vouchedBy || null,
                channels: params.channels || {}
              },
              {
                editorTag: 'trust-circle-plugin',
                defaultOperator: config.defaultOperator
              }
            );
            // Swap in the updated registry so subsequent before_agent_start
            // hooks resolve the new profile without a gateway restart.
            registry = updated;
            api.logger.info(
              `[trust-circle] trust_circle_register: added "${params.id}" (${params.rank}) — ` +
              `${updated.profiles.length} profiles total`
            );
            return {
              ok: true,
              id: params.id,
              rank: params.rank,
              profilesTotal: updated.profiles.length,
              registryPath: updated.registryPath
            };
          } catch (err) {
            api.logger.error(`[trust-circle] trust_circle_register failed: ${err.message}`);
            return { ok: false, error: err.message };
          }
        }
      });
    } else {
      api.logger.warn('[trust-circle] api.registerTool unavailable — sovereign_refuse, tactical_debrief, and trust_circle_register tools not registered');
    }

    api.logger.info('[trust-circle] hooks registered (before_agent_start), tools registered (sovereign_refuse, tactical_debrief, trust_circle_register)');
  }
};
