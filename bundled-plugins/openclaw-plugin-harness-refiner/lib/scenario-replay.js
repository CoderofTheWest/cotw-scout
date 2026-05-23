'use strict';

const { analyzeTrajectoryWindows } = require('./analyzer');
const { getScenarioFixtures } = require('./scenario-fixtures');

function runScenarioReplay({ scenarios = getScenarioFixtures(), config = {}, now = new Date().toISOString() } = {}) {
  return scenarios.map((scenario) => {
    const analysis = analyzeTrajectoryWindows({
      windows: [scenario.window],
      config,
      experimentId: `scenario-replay-${scenario.id}`,
      now
    });
    const found = new Set(analysis.signatures.map((signature) => signature.signature));
    const missing = scenario.expectedSignatures.filter((signature) => !found.has(signature));
    return {
      id: scenario.id,
      title: scenario.title,
      passed: missing.length === 0,
      expectedSignatures: scenario.expectedSignatures,
      foundSignatures: [...found],
      missingSignatures: missing,
      proposalCount: analysis.proposals.length,
      digestCount: analysis.digests.length
    };
  });
}

module.exports = {
  runScenarioReplay
};
