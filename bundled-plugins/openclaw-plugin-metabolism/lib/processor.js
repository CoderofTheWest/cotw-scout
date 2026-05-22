/**
 * Metabolism Processor - LLM-based extraction of implications, growth vectors, gaps
 * 
 * Design principles:
 * - Batch processing (one LLM call for multiple candidates)
 * - Timeout protection (don't block heartbeat forever)
 * - Graceful degradation (partial results are okay)
 * - Integration with stability growth vectors and continuity storage
 */

const fs = require('fs');
const path = require('path');

class MetabolismProcessor {
    constructor(config, dataDir, stabilityIntegration = null, api = null) {
        this.config = config;
        this.dataDir = dataDir;
        this.stabilityIntegration = stabilityIntegration;
        this.api = api;

        // LLM tunables (model comes from the gateway's configured primary via api.llm.generate)
        this.temperature = config.llm?.temperature ?? 0.7;
        this.maxTokens = config.llm?.maxTokens || 800;
        this.timeoutMs = config.llm?.timeoutMs || 30000;
        
        // Implication filtering
        this.minCount = config.implications?.minimumCount || 1;
        this.maxCount = config.implications?.maximumCount || 5;
        this.minLength = config.implications?.minimumLength || 30;
        this.filterPatterns = config.implications?.filterPatterns || [];
    }
    
    /**
     * Process a batch of candidates.
     * Returns implications, growth vectors, and knowledge gaps.
     * 
     * @param {Array<Object>} candidates - Candidates from the store
     * @returns {Object} { processed: [...], implications: [...], growthVectors: [...], gaps: [...] }
     */
    async processBatch(candidates) {
        if (!candidates || candidates.length === 0) {
            return { processed: [], implications: [], growthVectors: [], gaps: [] };
        }
        
        const results = {
            processed: [],
            implications: [],
            growthVectors: [],
            gaps: []
        };
        
        // Process each candidate (could batch into single LLM call later for efficiency)
        for (const candidate of candidates) {
            try {
                const processed = await this.processOne(candidate);
                
                if (processed.implications.length > 0) {
                    results.processed.push({
                        id: candidate.id,
                        timestamp: candidate.timestamp,
                        entropy: candidate.entropy,
                        implicationCount: processed.implications.length
                    });
                    
                    results.implications.push(...processed.implications);
                    results.growthVectors.push(...processed.growthVectors);
                    results.gaps.push(...processed.gaps);
                }
            } catch (error) {
                console.error(`[Metabolism] Error processing candidate ${candidate.id}:`, error.message);
                // Continue with other candidates
            }
        }
        
        return results;
    }
    
    /**
     * Process a single candidate.
     */
    async processOne(candidate) {
        // Build conversation text
        const conversationText = this._formatConversation(candidate.messages);
        if (conversationText.length < 100) {
            return { implications: [], growthVectors: [], gaps: [] };
        }
        
        // Call LLM for metabolism (pass candidate for lowEntropy flag and context)
        const response = await this._callLLM(conversationText, candidate.entropy, candidate);
        
        // Parse implications
        const implications = this._parseImplications(response);
        
        // Extract growth vector candidates
        const growthVectors = this._extractGrowthVectors(implications, candidate);
        
        // Extract knowledge gaps
        const gaps = this._extractGaps(implications, candidate);
        
        return { implications, growthVectors, gaps };
    }
    
    /**
     * Format messages for LLM input.
     */
    _formatConversation(messages) {
        if (!messages || messages.length === 0) return '';
        
        return messages
            .slice(-10) // Last 10 messages
            .map(m => {
                const role = m.role || (m.user ? 'USER' : 'CLINT');
                const text = m.text || m.content || m.message || '';
                return `${role}: ${text}`;
            })
            .join('\n\n');
    }
    
    /**
     * Call LLM for metabolism via the gateway's configured primary model.
     * Uses api.llm.generate — the same surface the continuity plugin uses for warm-start.
     * The model is whatever the agent's primary is in openclaw.json (propagates on upgrade).
     */
    async _callLLM(conversationText, entropy, candidate = null) {
        // Graceful skip when gateway LLM client isn't injected into this plugin's api.
        // Matches the defensive pattern from openclaw-plugin-continuity. Returning
        // empty here makes processBatch produce 0 implications — same as a quiet exchange.
        if (!this.api?.llm?.generate) {
            return '';
        }

        const prompt = this._buildPrompt(conversationText, entropy, candidate);

        const result = await this.api.llm.generate(prompt, {
            temperature: this.temperature,
            maxTokens: this.maxTokens,
            timeout: this.timeoutMs
        });

        const text = result?.text || result?.response || result?.content || '';

        // Truncation recovery: if the gateway reports a truncated response, retry with more tokens
        if (result?.truncated) {
            console.warn('[Metabolism] Gateway response truncated — retrying with 50% more tokens');
            const retry = await this.api.llm.generate(prompt, {
                temperature: this.temperature,
                maxTokens: Math.round(this.maxTokens * 1.5),
                timeout: this.timeoutMs
            });
            return retry?.text || retry?.response || retry?.content || text;
        }

        return text;
    }
    
    /**
     * Build the four-phase metabolism prompt.
     * Inspired by KAIROS's consolidation prompt structure.
     * Phases: Orient → Gather → Extract → Prune
     */
    _buildPrompt(conversationText, entropy, candidate = null) {
        const entropyNote = entropy > 0.7
            ? 'This was a high-entropy exchange — there was tension, novelty, or correction.'
            : entropy > 0.4
                ? 'This exchange had moderate energy — something worth noting.'
                : candidate?.lowEntropy
                    ? 'This was a quieter exchange, but may contain decisions, preferences, or project context worth persisting.'
                    : 'This was a routine exchange, but may still contain insights.';

        // Inject existing vector manifest so the LLM can avoid duplicates
        const manifest = this._getExistingVectorManifest();

        return `[METABOLISM — AUTONOMOUS LEARNING]

## Phase 1 — Orient
You are metabolizing a conversation. Before extracting, review what you already know:
${manifest || '(No existing vectors yet)'}
Check this list before writing — update or reinforce an existing insight rather than duplicating.

## Phase 2 — Gather Signal
The conversation:
${conversationText}

Context: ${entropyNote}

Look for: corrections from Chris, novel frameworks, emotional weight, paradox integration, meta-cognitive shifts, embodiment learning. These are the high-entropy signals.

## Phase 3 — Extract
Extract 1-5 implications. Each must:
- Be something LEARNED, not a summary
- Be typed with a prefix: [user] [feedback] [project] [reference] [embodiment]
  - user: about Chris (preferences, role, knowledge)
  - feedback: corrections or confirmed approaches (structure as: Rule. Why: reason. How to apply: guidance)
  - project: work context not derivable from code (deadlines, incidents, decisions)
  - reference: pointers to external systems (dashboards, boards, channels)
  - embodiment: physical knowledge from TonyPi (motor strategies, environmental mappings, calibration)
- Include a one-line description after a | separator (for future retrieval matching)
- Be framed in YOUR voice (grounded, direct, Code of the West)
- Be specific enough to be actionable

## Phase 4 — Prune
If any existing vector in the manifest above is contradicted by what you just learned, note the contradiction on a separate line prefixed with [CONTRADICTS]: followed by the vector description.
Do NOT fabricate contradictions — only flag genuine conflicts.

Format: One implication per line. Type prefix required.
Example: [feedback] Don't mock the database in integration tests | testing approach for data layer. Why: prod migration broke when mocked tests passed. How to apply: always use real DB connection in tests touching schema.
Example: [embodiment] Lean forward 10 degrees before stepping over threshold | TonyPi doorway navigation strategy
Example: [CONTRADICTS] "Always use sequential tool execution" — parallel execution validated for read-only tools`;
    }

    /**
     * Read existing growth vectors and format as a manifest for the orient phase.
     */
    _getExistingVectorManifest() {
        try {
            const gvPath = path.join(this.dataDir, 'growth-vectors.json');
            if (!fs.existsSync(gvPath)) return null;

            const data = JSON.parse(fs.readFileSync(gvPath, 'utf8'));
            const vectors = [...(data.vectors || []), ...(data.candidates || [])];

            if (vectors.length === 0) return null;

            return vectors.slice(-20).map(v => {
                const type = v.type || 'unknown';
                const desc = v.description || v.text || v.integration_hypothesis || '';
                const truncated = desc.length > 120 ? desc.substring(0, 120) + '...' : desc;
                return `- [${type}] ${truncated}`;
            }).join('\n');
        } catch (e) {
            return null;
        }
    }
    
    /**
     * Parse implications from LLM response.
     * Handles [type] prefixed lines from four-phase prompt.
     */
    _parseImplications(response) {
        if (!response || typeof response !== 'string') return [];

        const validTypePrefixes = ['[user]', '[feedback]', '[project]', '[reference]', '[embodiment]', '[contradicts]'];

        const lines = response
            .split('\n')
            .map(line => line.trim())
            .map(line => line.startsWith('- ') ? line.substring(2).trim() : line) // Strip leading "- "
            .filter(line => {
                if (line.length < this.minLength) return false;
                const lower = line.toLowerCase();
                // Filter out headers and meta-text
                if (this.filterPatterns.some(p => lower.startsWith(p.toLowerCase()))) return false;
                // Allow type-prefixed lines, filter other bracketed text
                if (line.startsWith('[')) {
                    return validTypePrefixes.some(p => lower.startsWith(p));
                }
                return true;
            });

        return lines.slice(0, this.maxCount);
    }
    
    /**
     * Extract growth vector candidates from implications.
     * Parses [type] prefix and | description separator from four-phase prompt output.
     */
    _extractGrowthVectors(implications, candidate) {
        if (implications.length === 0) return [];

        const vectors = [];
        const validTypes = ['user', 'feedback', 'project', 'reference', 'embodiment'];

        for (const imp of implications) {
            // Skip contradiction markers (handled separately)
            if (imp.toLowerCase().startsWith('[contradicts]')) continue;

            // Parse [type] prefix
            const typeMatch = imp.match(/^\[(\w+)\]\s*/);
            let type = 'project'; // default
            let text = imp;

            if (typeMatch) {
                const parsed = typeMatch[1].toLowerCase();
                if (validTypes.includes(parsed)) {
                    type = parsed;
                }
                text = imp.substring(typeMatch[0].length);
            } else {
                // Fallback: classify by content (backward compat with old prompt)
                type = this._classifyVectorType(imp);
            }

            // Parse | description separator
            let description = null;
            const pipeIdx = text.indexOf(' | ');
            if (pipeIdx > 0) {
                description = text.substring(pipeIdx + 3).trim();
                text = text.substring(0, pipeIdx).trim();
            }

            vectors.push({
                id: `gv_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
                text,
                description: description || text.substring(0, 100),
                type,
                source: 'metabolism',
                sourceId: candidate.id,
                timestamp: new Date().toISOString(),
                entropy: candidate.entropy,
                validation_status: 'candidate',
                weight: Math.min(0.95, 0.7 + (candidate.entropy * 0.25))
            });
        }

        return vectors.length > 0 ? vectors : [];
    }

    /**
     * Fallback type classification for implications without [type] prefix.
     * Used for backward compatibility with old prompt format.
     */
    _classifyVectorType(implication) {
        const lower = implication.toLowerCase();

        if (lower.includes('correct') || lower.includes('wrong') || lower.includes('error')) {
            return 'feedback';
        }
        if (lower.includes('prefer') || lower.includes('better') || lower.includes('worse')) {
            return 'user';
        }
        if (lower.includes('servo') || lower.includes('motor') || lower.includes('step') || lower.includes('calibrat')) {
            return 'embodiment';
        }
        if (lower.includes('dashboard') || lower.includes('linear') || lower.includes('grafana') || lower.includes('url')) {
            return 'reference';
        }
        return 'project';
    }
    
    /**
     * Extract knowledge gaps for contemplative inquiry.
     */
    _extractGaps(implications, candidate) {
        const gaps = [];
        
        for (const imp of implications) {
            // Look for question patterns or uncertainty markers
            if (imp.includes('?') || 
                imp.toLowerCase().includes('unclear') ||
                imp.toLowerCase().includes('figure out') ||
                imp.toLowerCase().includes('explore')) {
                gaps.push({
                    question: imp,
                    source: 'metabolism',
                    sourceId: candidate.id,
                    exchangeId: candidate.exchangeId || candidate.metadata?.exchangeId || null,
                    timestamp: new Date().toISOString()
                });
            }
        }
        
        return gaps.slice(0, 2); // Max 2 gaps per candidate
    }
}

module.exports = MetabolismProcessor;