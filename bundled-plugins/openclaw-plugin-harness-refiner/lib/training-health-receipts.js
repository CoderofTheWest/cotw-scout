'use strict';

const { fullHash, safeText, stableHash } = require('./safe');

function buildTrainingHealthReceipt(input = {}, options = {}) {
  const now = options.now || input.createdAt || new Date().toISOString();
  const checks = {
    cudaVerified: Boolean(input.cudaVerified),
    trainerHeartbeat: Boolean(input.trainerHeartbeat),
    stepCounterAdvancing: Boolean(input.stepCounterAdvancing),
    checkpointTimestampAdvancing: Boolean(input.checkpointTimestampAdvancing),
    adapterHashChanged: Boolean(input.adapterHashChanged),
    fixedEvalCompleted: Boolean(input.fixedEvalCompleted),
    paidComputeIdle: Boolean(input.paidComputeIdle)
  };
  const hardStops = [];
  if (!checks.cudaVerified) hardStops.push('cuda_not_verified');
  if (!checks.trainerHeartbeat) hardStops.push('trainer_heartbeat_missing');
  if (!checks.stepCounterAdvancing) hardStops.push('step_counter_stalled');
  if (!checks.checkpointTimestampAdvancing) hardStops.push('checkpoint_timestamp_stalled');
  if (checks.paidComputeIdle) hardStops.push('paid_compute_idle_without_progress');

  const id = safeText(input.id || `training-health-${stableHash({ checks, runId: input.runId || '', now })}`, 160);
  return {
    id,
    type: 'training_health_receipt',
    runId: safeText(input.runId || '', 120),
    trainerPid: safeText(input.trainerPid || '', 80),
    gpuUtilization: Number.isFinite(Number(input.gpuUtilization)) ? Number(input.gpuUtilization) : null,
    step: Number.isFinite(Number(input.step)) ? Number(input.step) : null,
    loss: Number.isFinite(Number(input.loss)) ? Number(input.loss) : null,
    gradNorm: Number.isFinite(Number(input.gradNorm)) ? Number(input.gradNorm) : null,
    learningRate: Number.isFinite(Number(input.learningRate)) ? Number(input.learningRate) : null,
    checkpointTimestamp: safeText(input.checkpointTimestamp || '', 80),
    adapterHash: safeText(input.adapterHash || '', 160),
    fixedEvalBeforeHash: safeText(input.fixedEvalBeforeHash || '', 160),
    fixedEvalAfterHash: safeText(input.fixedEvalAfterHash || '', 160),
    checks,
    hardStops,
    healthy: hardStops.length === 0,
    trainingLaunchAuthorized: false,
    adapterPromotionAuthorized: false,
    receiptHash: fullHash({ input, checks, hardStops }),
    createdAt: now
  };
}

module.exports = {
  buildTrainingHealthReceipt
};
