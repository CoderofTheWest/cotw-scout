const assert = require('assert');

const scanner = require('../lib/scanner');
const pluginFactory = require('../index');

(function testFindCandidates() {
  const nowMs = Date.parse('2026-02-20T00:00:00Z');
  const vectors = [
    {
      id: 'vec_old',
      text: 'old and resolved',
      created: '2025-12-01T00:00:00Z',
      resolved: true
    },
    {
      id: 'vec_new',
      text: 'too recent',
      created: '2026-02-10T00:00:00Z',
      resolved: true
    },
    {
      id: 'vec_pending',
      text: 'already pending',
      created: '2025-12-01T00:00:00Z',
      resolved: true,
      crystallization: { status: 'pending_review' }
    }
  ];

  const config = {
    gates: { minAge: 1000 * 60 * 60 * 24 * 30 },
    crystallization: { maxPending: 5 }
  };

  const candidates = scanner.findCandidates(vectors, config, { nowMs });
  assert.deepStrictEqual(candidates.map((v) => v.id), ['vec_old']);
})();

(function testApprovalDetection() {
  const plugin = pluginFactory({}, {});
  assert.deepStrictEqual(plugin.detectApprovalDecision('yes crystallize this'), { decision: 'approve' });
  assert.deepStrictEqual(plugin.detectApprovalDecision('reject this'), { decision: 'reject' });
  assert.deepStrictEqual(plugin.detectApprovalDecision('edit: tighten the wording'), {
    decision: 'edit',
    editText: 'tighten the wording'
  });
})();

console.log('All tests passed');
