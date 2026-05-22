/**
 * scaffoldManager.js
 *
 * Manages the evolved scaffold files: reads, writes, versions, and rolls back.
 * All evolved content lives in data/evolved/ — never modifies files outside the plugin.
 *
 * Scaffold files:
 *   code-mode-rules.md  — Learned prompt rules
 *   tool-hints.json     — Per-tool guidance
 *   workflows.json      — Task sequence rules
 *   parameters.json     — Model-namespaced sampling params
 *   thresholds.json     — Code-mode entropy/loop overrides
 *   executables/         — Active JS rules (managed by executableLoader)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ScaffoldManager {
    /**
     * @param {object} config - Plugin config
     * @param {string} dataDir - Base data directory for the plugin
     * @param {object} logger - Plugin logger
     */
    constructor(config, dataDir, logger) {
        this.config = config;
        this.evolvedDir = path.join(dataDir, 'evolved');
        this.historyDir = path.join(this.evolvedDir, 'history');
        this.mutationsDir = path.join(dataDir, 'mutations');
        this.analysisDir = path.join(dataDir, 'analysis');
        this.logger = logger;

        this._ensureDir(this.evolvedDir);
        this._ensureDir(this.historyDir);
        this._ensureDir(this.mutationsDir);
        this._ensureDir(this.analysisDir);

        // Track last analysis time
        this.stateFile = path.join(dataDir, 'evolution-state.json');
    }

    // -----------------------------------------------------------------------
    // Read scaffold files
    // -----------------------------------------------------------------------

    loadRules() {
        return this._readFile(path.join(this.evolvedDir, 'code-mode-rules.md'), '');
    }

    loadToolHints() {
        return this._readJson(path.join(this.evolvedDir, 'tool-hints.json'), {});
    }

    loadWorkflows() {
        return this._readJson(path.join(this.evolvedDir, 'workflows.json'), []);
    }

    loadParameters(modelId) {
        const all = this._readJson(path.join(this.evolvedDir, 'parameters.json'), {});
        if (modelId) return all[modelId] || {};
        return all;
    }

    loadThresholds() {
        return this._readJson(path.join(this.evolvedDir, 'thresholds.json'), {});
    }

    // -----------------------------------------------------------------------
    // Scaffold version hash
    // -----------------------------------------------------------------------

    /**
     * Compute a hash of the current scaffold state.
     * Used to track which scaffold version a session was recorded under.
     */
    getScaffoldVersion() {
        const parts = [
            this.loadRules(),
            JSON.stringify(this.loadToolHints()),
            JSON.stringify(this.loadWorkflows()),
            JSON.stringify(this.loadParameters())
        ];
        return crypto.createHash('sha256').update(parts.join('|||')).digest('hex').slice(0, 12);
    }

    // -----------------------------------------------------------------------
    // Format evolved context for injection
    // -----------------------------------------------------------------------

    /**
     * Format all evolved scaffold content into a single context block
     * for prependContext injection.
     */
    formatEvolvedContext(executableRuleSummaries) {
        const lines = ["[WHAT YOU'VE LEARNED IN CODE MODE]"];
        let hasContent = false;

        // Tool hints
        const hints = this.loadToolHints();
        const hintEntries = Object.entries(hints);
        if (hintEntries.length > 0) {
            lines.push('');
            lines.push('Tool Guidance:');
            for (const [tool, data] of hintEntries) {
                const hint = typeof data === 'string' ? data : data.hint;
                if (hint) {
                    lines.push(`  ${tool}: ${hint}`);
                    hasContent = true;
                }
            }
        }

        // Prompt rules
        const rules = this.loadRules();
        if (rules.trim()) {
            lines.push('');
            lines.push('Learned Rules:');
            lines.push(rules.trim());
            hasContent = true;
        }

        // Workflow sequences
        const workflows = this.loadWorkflows();
        if (workflows.length > 0) {
            lines.push('');
            lines.push('Workflow Patterns:');
            for (const wf of workflows) {
                const desc = typeof wf === 'string' ? wf : `${wf.name}: ${wf.sequence}`;
                lines.push(`  ${desc}`);
                hasContent = true;
            }
        }

        // Active executable rules (summaries only — the actual firing happens in hooks)
        if (executableRuleSummaries && executableRuleSummaries.length > 0) {
            lines.push('');
            lines.push('Active Scaffold Rules:');
            for (const summary of executableRuleSummaries) {
                lines.push(`  [${summary.category}] ${summary.description}`);
                hasContent = true;
            }
        }

        if (!hasContent) return '';
        lines.push('[/EVOLVED SCAFFOLD CONTEXT]');
        return lines.join('\n');
    }

    // -----------------------------------------------------------------------
    // Commit / revert mutations (Phase 3+ — stubs for now)
    // -----------------------------------------------------------------------

    /**
     * Commit a mutation: apply its changes to the evolved scaffold,
     * snapshot current state to history first.
     */
    commit(mutation) {
        // Snapshot before applying
        this._snapshotHistory(`pre-commit-${mutation.id}`);

        const targetPath = path.join(this.evolvedDir, this._resolveTargetFile(mutation.changeType));

        if (mutation.changeType === 'prompt_rule') {
            // Append rule to code-mode-rules.md
            const current = this.loadRules();
            const updated = current ? `${current}\n\n${mutation.diff.after}` : mutation.diff.after;
            fs.writeFileSync(targetPath, updated);
        } else if (mutation.changeType === 'tool_hint') {
            // Merge hint into tool-hints.json
            const current = this.loadToolHints();
            const newHints = typeof mutation.diff.after === 'string'
                ? JSON.parse(mutation.diff.after) : mutation.diff.after;
            Object.assign(current, newHints);
            fs.writeFileSync(targetPath, JSON.stringify(current, null, 2));
        } else if (mutation.changeType === 'workflow_sequence') {
            // Add workflow to array
            const current = this.loadWorkflows();
            const newWf = typeof mutation.diff.after === 'string'
                ? JSON.parse(mutation.diff.after) : mutation.diff.after;
            current.push(newWf);
            fs.writeFileSync(targetPath, JSON.stringify(current, null, 2));
        } else if (mutation.changeType === 'parameter_tune') {
            // Merge parameter into model-namespaced params
            const current = this.loadParameters();
            const newParams = typeof mutation.diff.after === 'string'
                ? JSON.parse(mutation.diff.after) : mutation.diff.after;
            for (const [model, params] of Object.entries(newParams)) {
                current[model] = { ...(current[model] || {}), ...params };
            }
            fs.writeFileSync(targetPath, JSON.stringify(current, null, 2));
        }

        // Update mutation status
        mutation.status = 'committed';
        mutation.committedAt = new Date().toISOString();
        this._writeMutation(mutation);

        this.logger.info(`[CodeEvolution] Committed mutation ${mutation.id} (${mutation.changeType})`);
    }

    /**
     * Revert a mutation — restore from history snapshot.
     */
    revert(mutation, reason) {
        mutation.status = 'reverted';
        mutation.revertedAt = new Date().toISOString();
        mutation.revertReason = reason;
        this._writeMutation(mutation);

        this.logger.info(`[CodeEvolution] Reverted mutation ${mutation.id}: ${reason}`);
    }

    // -----------------------------------------------------------------------
    // State tracking
    // -----------------------------------------------------------------------

    getLastAnalysisTime() {
        const state = this._readJson(this.stateFile, {});
        return state.lastAnalysisTime || 0;
    }

    setLastAnalysisTime(time) {
        const state = this._readJson(this.stateFile, {});
        state.lastAnalysisTime = time || Date.now();
        fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    _resolveTargetFile(changeType) {
        const map = {
            prompt_rule: 'code-mode-rules.md',
            tool_hint: 'tool-hints.json',
            workflow_sequence: 'workflows.json',
            parameter_tune: 'parameters.json',
            executable_rule: 'executables/' // Handled by executableLoader
        };
        return map[changeType] || 'code-mode-rules.md';
    }

    _snapshotHistory(label) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const snapshotDir = path.join(this.historyDir, `${timestamp}_${label}`);
        this._ensureDir(snapshotDir);

        const files = ['code-mode-rules.md', 'tool-hints.json', 'workflows.json',
            'parameters.json', 'thresholds.json'];
        for (const file of files) {
            const src = path.join(this.evolvedDir, file);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(snapshotDir, file));
            }
        }
    }

    _writeMutation(mutation) {
        const filepath = path.join(this.mutationsDir, `mutation_${mutation.id}.json`);
        fs.writeFileSync(filepath, JSON.stringify(mutation, null, 2));
    }

    _readFile(filepath, fallback) {
        try {
            if (fs.existsSync(filepath)) {
                return fs.readFileSync(filepath, 'utf8');
            }
        } catch (e) { /* best effort */ }
        return fallback;
    }

    _readJson(filepath, fallback) {
        try {
            if (fs.existsSync(filepath)) {
                return JSON.parse(fs.readFileSync(filepath, 'utf8'));
            }
        } catch (e) { /* best effort */ }
        return fallback;
    }

    _ensureDir(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

module.exports = ScaffoldManager;
