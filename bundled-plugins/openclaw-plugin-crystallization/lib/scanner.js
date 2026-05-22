function isTimeEligible(vector, minAge, nowMs) {
  if (!vector || !vector.created) {
    return false;
  }

  const createdMs = Date.parse(vector.created);
  if (Number.isNaN(createdMs)) {
    return false;
  }

  return nowMs - createdMs >= minAge;
}

function isBlockedByStatus(vector) {
  const status = vector?.crystallization?.status;
  return status === 'pending_review' || status === 'approved';
}

function findCandidates(vectors, config, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const minAge = config?.gates?.minAge ?? 0;
  const maxPending = config?.crystallization?.maxPending ?? 5;
  const pendingCount = vectors.filter((v) => v?.crystallization?.status === 'pending_review').length;

  if (pendingCount >= maxPending) {
    return [];
  }

  return vectors.filter((vector) => {
    if (!vector || !vector.id) {
      return false;
    }

    if (isBlockedByStatus(vector)) {
      return false;
    }

    if (vector.resolved === false) {
      return false;
    }

    return isTimeEligible(vector, minAge, nowMs);
  });
}

function selectCandidatesById(vectors, ids) {
  const idSet = new Set(ids || []);
  if (!idSet.size) {
    return [];
  }

  return vectors.filter((vector) => idSet.has(vector.id));
}

module.exports = {
  findCandidates,
  isTimeEligible,
  selectCandidatesById
};
