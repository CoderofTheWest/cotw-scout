'use strict';

const { SCHEMA_VERSIONS } = require('./schema-versions');

const BUNDLE_KEY_TYPES = Object.freeze({
  scores: 'process_score_receipt',
  relabelCandidates: 'relabel_candidate_packet',
  teacherRelabels: 'teacher_relabel_receipt'
});

const TYPE_VERSION_KEYS = Object.freeze({
  process_score_receipt: 'SCORE_RECEIPT',
  relabel_candidate_packet: 'RELABEL_CANDIDATE_PACKET',
  teacher_relabel_receipt: 'TEACHER_RELABEL_RECEIPT',
  ground_truth_label: 'GROUND_TRUTH_LABEL',
  scorer_calibration_report: 'SCORER_CALIBRATION_REPORT',
  teacher_repair_quality_receipt: 'TEACHER_REPAIR_QUALITY_RECEIPT',
  holdout_manifest: 'HOLDOUT_MANIFEST',
  sealed_shard_manifest: 'SHARD_MANIFEST',
  hindsight_correlation_report: 'HINDSIGHT_CORRELATION_REPORT'
});

function currentSchemaVersionForType(type) {
  const key = TYPE_VERSION_KEYS[type];
  return key ? SCHEMA_VERSIONS[key] : null;
}

function inferReceiptType(receipt = {}, bundleKey = '') {
  if (receipt.type && TYPE_VERSION_KEYS[receipt.type]) return receipt.type;
  return BUNDLE_KEY_TYPES[bundleKey] || null;
}

function migrateReceiptSchema(receipt = {}, { bundleKey = '', targetVersion = null } = {}) {
  const type = inferReceiptType(receipt, bundleKey);
  if (!type) return { receipt: { ...receipt }, migrated: false, migration: null };

  const currentVersion = currentSchemaVersionForType(type);
  const desiredVersion = targetVersion || currentVersion;
  const sourceVersion = receipt.schemaVersion ?? null;
  if (desiredVersion !== currentVersion) {
    throw new Error(`unsupported target schema version for ${type}: ${desiredVersion}`);
  }
  if (sourceVersion !== null && sourceVersion !== currentVersion) {
    throw new Error(`unsupported schema migration for ${type}: ${sourceVersion} -> ${currentVersion}`);
  }

  const next = {
    ...receipt,
    type,
    schemaVersion: currentVersion
  };
  return {
    receipt: next,
    migrated: sourceVersion === null || receipt.type !== type,
    migration: sourceVersion === null || receipt.type !== type
      ? { type, fromVersion: sourceVersion, toVersion: currentVersion, operation: 'legacy_to_current' }
      : null
  };
}

function downgradeReceiptSchema(receipt = {}, { bundleKey = '', targetVersion = null } = {}) {
  const type = inferReceiptType(receipt, bundleKey);
  if (!type) return { receipt: { ...receipt }, migrated: false, migration: null };
  if (targetVersion !== null) {
    throw new Error(`unsupported downgrade target for ${type}: ${targetVersion}`);
  }
  const next = { ...receipt };
  delete next.schemaVersion;
  return {
    receipt: next,
    migrated: receipt.schemaVersion !== undefined,
    migration: { type, fromVersion: receipt.schemaVersion ?? null, toVersion: null, operation: 'current_to_legacy' }
  };
}

function normalizeBundleSchemas(artifacts = {}) {
  const normalized = {};
  const migrations = [];
  const schemaVersions = {};
  const errors = [];

  for (const [bundleKey, entries] of Object.entries(artifacts)) {
    if (!Array.isArray(entries)) {
      normalized[bundleKey] = entries;
      continue;
    }
    normalized[bundleKey] = [];
    for (const entry of entries) {
      const type = inferReceiptType(entry, bundleKey);
      if (!type) {
        normalized[bundleKey].push(entry);
        continue;
      }
      try {
        const result = migrateReceiptSchema(entry, { bundleKey });
        normalized[bundleKey].push(result.receipt);
        schemaVersions[type] = result.receipt.schemaVersion;
        if (result.migration) migrations.push({ bundleKey, ...result.migration });
      } catch (error) {
        errors.push({
          bundleKey,
          type,
          schemaVersion: entry?.schemaVersion ?? null,
          message: error.message
        });
      }
    }
  }

  if (errors.length > 0) {
    const error = new Error('bundle contains unsupported receipt schema versions');
    error.schemaReport = { ok: false, errors, migrations, schemaVersions };
    throw error;
  }

  return {
    artifacts: normalized,
    report: {
      ok: true,
      schemaVersions,
      migrations,
      migratedCount: migrations.length
    }
  };
}

function validateBundleSchemaVersions(artifacts = {}) {
  try {
    const result = normalizeBundleSchemas(artifacts);
    return result.report;
  } catch (error) {
    return error.schemaReport || { ok: false, errors: [{ message: error.message }], migrations: [], schemaVersions: {} };
  }
}

module.exports = {
  BUNDLE_KEY_TYPES,
  TYPE_VERSION_KEYS,
  currentSchemaVersionForType,
  downgradeReceiptSchema,
  inferReceiptType,
  migrateReceiptSchema,
  normalizeBundleSchemas,
  validateBundleSchemaVersions
};
