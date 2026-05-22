/**
 * PlanStore — Plan persistence for the planmode plugin.
 *
 * Plans are JSON files in a per-agent data directory.
 * Lifecycle: pending_approval → approved → executing → completed
 *
 * Created: Mar 31, 2026
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

class PlanStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.archiveDir = path.join(dataDir, 'completed');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    }

    _slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 50)
            .replace(/-+$/, '');
    }

    async create(goal, steps, rawContent) {
        const slug = this._slugify(goal) || `plan-${Date.now()}`;
        const plan = {
            id: `plan-${Date.now()}`,
            slug,
            goal,
            status: 'pending_approval',
            steps: steps.map(s => typeof s === 'string'
                ? { description: s, status: 'pending', result: null }
                : s
            ),
            rawContent: rawContent || '',
            created_at: new Date().toISOString(),
            approved_at: null,
            completed_at: null
        };
        await this._write(slug, plan);
        return plan;
    }

    async _scanForStatus(status) {
        try {
            const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
            let latest = null;
            let latestTime = 0;
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(this.dataDir, file), 'utf8'));
                    if (data.status === status) {
                        const t = new Date(data.created_at).getTime();
                        if (t > latestTime) { latest = data; latest._file = file; latestTime = t; }
                    }
                } catch (_) { /* skip malformed */ }
            }
            return latest;
        } catch (_) { return null; }
    }

    async getPendingApproval() { return this._scanForStatus('pending_approval'); }

    async getActive() {
        return (await this._scanForStatus('executing')) || (await this._scanForStatus('approved'));
    }

    async approve() {
        const plan = await this.getPendingApproval();
        if (!plan) return null;
        plan.status = 'approved';
        plan.approved_at = new Date().toISOString();
        await this._write(plan.slug, plan);
        return plan;
    }

    async reject() {
        const plan = await this.getPendingApproval();
        if (!plan) return null;
        plan.status = 'rejected';
        await this._write(plan.slug, plan);
        return plan;
    }

    async startExecution() {
        const plan = await this._scanForStatus('approved');
        if (!plan) return null;
        plan.status = 'executing';
        await this._write(plan.slug, plan);
        return plan;
    }

    async complete(summary) {
        const plan = await this.getActive();
        if (!plan) return null;
        plan.status = 'completed';
        plan.summary = summary;
        plan.completed_at = new Date().toISOString();
        // Archive
        if (!fs.existsSync(this.archiveDir)) fs.mkdirSync(this.archiveDir, { recursive: true });
        const clean = { ...plan }; delete clean._file;
        fs.writeFileSync(path.join(this.archiveDir, `${plan.slug}-${Date.now()}.json`), JSON.stringify(clean, null, 2));
        // Remove from active
        try { fs.unlinkSync(path.join(this.dataDir, plan._file || `${plan.slug}.json`)); } catch (_) {}
        return plan;
    }

    formatForPrompt(plan) {
        if (!plan) return '';
        const lines = [`[ACTIVE PLAN]`, `Goal: ${plan.goal}`, `Status: ${plan.status}`];
        if (plan.steps && plan.steps.length > 0) {
            const done = plan.steps.filter(s => s.status === 'completed').length;
            lines.push(`\nSteps (${done}/${plan.steps.length} complete):`);
            plan.steps.forEach((s, i) => {
                const m = s.status === 'completed' ? '\u2713'
                    : s.status === 'in_progress' ? '\u2192' : ' ';
                lines.push(`${m} ${i + 1}. ${s.description}`);
                if (s.result) lines.push(`     Result: ${s.result}`);
            });
        }
        return lines.join('\n');
    }

    async _write(slug, plan) {
        const clean = { ...plan }; delete clean._file;
        await fsp.writeFile(path.join(this.dataDir, `${slug}.json`), JSON.stringify(clean, null, 2));
    }
}

module.exports = { PlanStore };
