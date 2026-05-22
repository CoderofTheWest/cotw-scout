/**
 * openclaw-plugin-trust-circle / lib / resolver.js
 *
 * Extracts channel + sender + chat metadata from the prompt text that
 * OpenClaw 2026.4.26 hands to before_agent_start.
 *
 * IMPORTANT: the gateway does NOT pass structured request metadata to
 * plugin hooks — the channel adapter embeds chat info inline in the
 * prompt as a "Conversation info (untrusted metadata)" JSON block.
 * That's the only signal we have. See also continuity/index.js around
 * line 358 which makes the same observation about thread_id markers.
 *
 * The "untrusted metadata" label in the prompt is about preventing
 * LLM-side prompt injection — it does NOT mean the fields are unreliable
 * for OUR purposes (matching against a registry we control). The channel
 * adapter writes them; we trust them.
 */

const { resolveSender } = require('./registry');
const { detectThirdPersonConflict } = require('./conflict-detector');
const { detectTacticalSignals } = require('./tactical-signals');

/**
 * Extract just the user's actual message text from the full prompt.
 * The prompt contains identity files, context blocks, conversation info
 * blocks, etc. — we want only the human's words for conflict detection.
 *
 * Heuristic: take everything after the LAST conv-info / sender-info block.
 * That's the convention OpenClaw uses — channel metadata blocks immediately
 * precede the actual user message.
 */
function _extractUserMessageText(prompt) {
  if (!prompt || typeof prompt !== 'string') return '';
  // Find the end of the last "Sender (untrusted metadata):" or "Conversation info" block
  const senderEnd = prompt.lastIndexOf('```\n', prompt.length);
  if (senderEnd === -1) return prompt.slice(-2000); // fallback: tail of prompt
  const after = prompt.slice(senderEnd + 4).trim();
  // Cap at 2000 chars — enough for conflict detection without scanning huge bodies
  return after.length > 2000 ? after.slice(0, 2000) : after;
}

/**
 * Extract the channel/chat/sender from a prompt string.
 * Returns null if the prompt has no Conversation-info block (e.g. local
 * console session, web UI without channel metadata).
 *
 * @param {string} prompt
 * @returns {{channel: string, chatId: string, senderId: string, senderLabel: ?string,
 *            isGroupChat: boolean, conversationLabel: ?string} | null}
 */
function extractChannelMetadata(prompt) {
  if (!prompt || typeof prompt !== 'string') return null;

  // The channel adapter emits a fenced JSON block after a "Conversation info" header.
  // Match either order (header before fence, fence before header tolerated) and capture the JSON.
  const match = prompt.match(/Conversation info[^\n`]*?:?\s*```json\s*([\s\S]+?)\s*```/i);
  if (!match) return null;

  let convInfo;
  try {
    convInfo = JSON.parse(match[1]);
  } catch (_) {
    return null; // malformed block — treat as absent rather than throw, callers handle null
  }

  // chat_id format observed in trajectory: "telegram:-1003819852585"
  // For DMs the same pattern applies: "telegram:6087936503"
  const rawChatId = convInfo.chat_id;
  if (!rawChatId || typeof rawChatId !== 'string') return null;

  const colon = rawChatId.indexOf(':');
  if (colon < 0) return null;

  const channel = rawChatId.slice(0, colon);
  const chatId = rawChatId.slice(colon + 1);
  const senderId = convInfo.sender_id ? String(convInfo.sender_id) : null;
  if (!senderId) return null;

  return {
    channel,
    chatId,
    senderId,
    senderLabel: convInfo.sender || null,
    isGroupChat: !!convInfo.is_group_chat,
    conversationLabel: convInfo.conversation_label || null
  };
}

/**
 * Resolve a prompt's channel metadata against the trust circle registry.
 * Returns a resolution object that the plugin tags onto ctx and logs.
 *
 * Resolution outcomes:
 *   - 'resolved'    — known sender, full profile attached
 *   - 'visitor'     — channel metadata present but sender not in registry
 *   - 'no-channel'  — no channel metadata in prompt (e.g. local session)
 *
 * NEVER returns 'anchor' as a default. Unknown senders get 'visitor'
 * with a loud log path. This is the no-silent-default discipline.
 *
 * @param {Object} registry - object returned by loadRegistry()
 * @param {string} prompt
 * @returns {{outcome: string, channel: ?string, chatId: ?string, senderId: ?string,
 *            speakerId: ?string, profileRank: ?string, profile: ?Object,
 *            senderLabel: ?string, isGroupChat: boolean,
 *            conversationLabel: ?string}}
 */
function resolveFromPrompt(registry, prompt) {
  const meta = extractChannelMetadata(prompt);
  if (!meta) {
    return {
      outcome: 'no-channel',
      channel: null, chatId: null, senderId: null,
      speakerId: null, profileRank: null, profile: null,
      senderLabel: null, isGroupChat: false, conversationLabel: null
    };
  }

  const profile = resolveSender(registry, meta.channel, meta.senderId);

  if (!profile) {
    return {
      outcome: 'visitor',
      channel: meta.channel,
      chatId: meta.chatId,
      senderId: meta.senderId,
      speakerId: 'unknown_visitor',
      profileRank: 'visitor',
      profile: null,
      senderLabel: meta.senderLabel,
      isGroupChat: meta.isGroupChat,
      conversationLabel: meta.conversationLabel
    };
  }

  // Third-person conflict detection: does the message text refer to the
  // resolved speaker in third person? If so, flag it. Caller (continuity
  // archiver) propagates this to the metadata column so downstream
  // consumers (evidence-quality, standing, contemplation) can downgrade
  // confidence on flagged exchanges.
  const userText = _extractUserMessageText(prompt);
  const conflict = detectThirdPersonConflict(userText, profile, registry?.profiles || []);

  // Tactical-sovereignty signal detection: regex-based check for the four
  // bad-faith patterns documented in KYLE.md (inquiry-as-control,
  // moral-consistency trap, gotcha reframe). Lazy-bias toward false-negatives.
  // Result rides the same sidecar/metadata path as conflict — downstream
  // consumers see the flag at decision time.
  const tacticalSignals = detectTacticalSignals(userText);

  return {
    outcome: 'resolved',
    channel: meta.channel,
    chatId: meta.chatId,
    senderId: meta.senderId,
    speakerId: profile.id,
    profileRank: profile.rank,
    profile,
    senderLabel: meta.senderLabel,
    isGroupChat: meta.isGroupChat,
    attributionConflict: conflict,  // null if no conflict, object if detected
    tacticalSignals,                 // null if no signal, object if detected
    conversationLabel: meta.conversationLabel
  };
}

module.exports = {
  extractChannelMetadata,
  resolveFromPrompt
};
