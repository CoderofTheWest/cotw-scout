'use strict';

const fs = require('fs');
const path = require('path');
const {
  artifactRegistry,
  buildDefaultRuntimeRoots,
} = require('./runtime-retention-registry');

const DEFAULT_MAX_FILES_PER_CLASS = 5000;

function buildRuntimeRetentionReport(options = {}) {
  const registry = options.registry || artifactRegistry();
  const roots = { ...buildDefaultRuntimeRoots(options), ...(options.roots || {}) };
  const now = new Date(options.now || Date.now()).toISOString();
  const includePaths = options.includePaths === true;
  const maxFilesPerClass = Number(options.maxFilesPerClass || DEFAULT_MAX_FILES_PER_CLASS);

  const artifactClasses = registry.map((entry) => scanArtifactClass(entry, roots, {
    includePaths,
    maxFilesPerClass,
  }));

  const allFiles = artifactClasses.flatMap((entry) => entry.files.map((file) => ({
    ...file,
    classId: entry.id,
    classLabel: entry.label,
    lifecycleTier: entry.lifecycleTier,
    sourceType: entry.sourceType,
  })));
  const policyViolations = artifactClasses.flatMap((entry) => entry.policyViolations);
  const fileCount = artifactClasses.reduce((sum, entry) => sum + entry.fileCount, 0);
  const totalBytes = artifactClasses.reduce((sum, entry) => sum + entry.totalBytes, 0);
  const byLifecycleTier = groupBytes(artifactClasses, 'lifecycleTier');
  const bySourceType = groupBytes(artifactClasses, 'sourceType');
  const status = statusForReport(artifactClasses, policyViolations);

  return {
    ok: true,
    readOnly: true,
    generatedAt: now,
    status,
    roots: redactRoots(roots, includePaths),
    summary: {
      artifactClassCount: artifactClasses.length,
      classesWithData: artifactClasses.filter((entry) => entry.fileCount > 0).length,
      fileCount,
      totalBytes,
      largestFileBytes: allFiles.reduce((max, file) => Math.max(max, file.bytes), 0),
      policyViolationCount: policyViolations.length,
      overBudgetClassCount: artifactClasses.filter((entry) => entry.status === 'over_budget').length,
      nearBudgetClassCount: artifactClasses.filter((entry) => entry.status === 'near_budget').length,
    },
    byLifecycleTier,
    bySourceType,
    topFiles: allFiles
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, options.topFileLimit || 12),
    policyViolations,
    researchDigest: buildResearchDigest(artifactClasses),
    artifactClasses,
  };
}

function scanArtifactClass(entry, roots, options) {
  const rootKeys = entry.roots || [entry.root];
  const files = [];
  const missingRoots = [];
  const errors = [];

  for (const rootKey of rootKeys) {
    const rootPath = roots[rootKey];
    if (!rootPath) {
      missingRoots.push(rootKey);
      continue;
    }
    try {
      if (!fs.existsSync(rootPath)) {
        missingRoots.push(rootKey);
        continue;
      }
      scanRoot(rootPath, entry, files, {
        ...options,
        rootKey,
        rootPath,
      });
    } catch (err) {
      errors.push({ rootKey, error: String(err.message || err) });
    }
  }

  const sortedFiles = files
    .sort((a, b) => b.bytes - a.bytes || String(a.relativePath).localeCompare(String(b.relativePath)))
    .slice(0, options.maxFilesPerClass);
  const totalBytes = sortedFiles.reduce((sum, file) => sum + file.bytes, 0);
  const newestMtimeMs = sortedFiles.reduce((max, file) => Math.max(max, file.mtimeMs || 0), 0);
  const oldestMtimeMs = sortedFiles.reduce((min, file) => Math.min(min, file.mtimeMs || min), sortedFiles[0]?.mtimeMs || 0);
  const policyViolations = evaluatePolicy(entry, sortedFiles, totalBytes);

  return {
    id: entry.id,
    label: entry.label,
    owner: entry.owner,
    sourceType: entry.sourceType,
    lifecycleTier: entry.lifecycleTier,
    sensitivity: entry.sensitivity,
    injectionEligible: entry.injectionEligible === true,
    trainingEligible: entry.trainingEligible === true,
    compactionStrategy: entry.compactionStrategy,
    exportPolicy: entry.exportPolicy,
    restorePolicy: entry.restorePolicy,
    rootKeys,
    missingRoots,
    errors,
    status: statusForClass(entry, sortedFiles, totalBytes, policyViolations),
    fileCount: sortedFiles.length,
    totalBytes,
    newestMtime: newestMtimeMs ? new Date(newestMtimeMs).toISOString() : null,
    oldestMtime: oldestMtimeMs ? new Date(oldestMtimeMs).toISOString() : null,
    budgets: entry.budgets || {},
    policyViolations,
    files: sortedFiles.slice(0, 10),
  };
}

function scanRoot(rootPath, entry, out, options, depth = 0) {
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) {
    maybeAddFile(rootPath, path.dirname(rootPath), entry, out, options);
    return;
  }
  if (!stat.isDirectory()) return;
  if (depth > Number(entry.maxDepth || 3)) return;

  const dirents = fs.readdirSync(rootPath, { withFileTypes: true });
  for (const dirent of dirents) {
    if (out.length >= options.maxFilesPerClass) return;
    const fullPath = path.join(rootPath, dirent.name);
    if (dirent.isDirectory()) {
      scanRoot(fullPath, entry, out, options, depth + 1);
    } else if (dirent.isFile()) {
      maybeAddFile(fullPath, options.rootPath, entry, out, options);
    }
  }
}

function maybeAddFile(filePath, rootPath, entry, out, options) {
  const relativePath = normalizeRelative(path.relative(rootPath, filePath));
  const basename = path.basename(filePath);
  if (!matches(entry.include || [], relativePath, basename)) return;
  if (matches(entry.exclude || [], relativePath, basename)) return;

  const stat = fs.statSync(filePath);
  out.push({
    rootKey: options.rootKey,
    relativePath,
    displayPath: options.includePaths ? filePath : redactPath(filePath),
    path: options.includePaths ? filePath : undefined,
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
  });
}

function matches(patterns, relativePath, basename) {
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(relativePath) || pattern.test(basename);
    if (typeof pattern === 'string') return relativePath === pattern || basename === pattern;
    return false;
  });
}

function evaluatePolicy(entry, files, totalBytes) {
  const budgets = entry.budgets || {};
  const violations = [];
  const totalBudget = budgets.hotMaxBytes || budgets.warmMaxBytes || budgets.coldMaxBytes || null;
  if (totalBudget && totalBytes > totalBudget) {
    violations.push(policyViolation(entry, 'total_bytes_over_budget', 'error', totalBytes, totalBudget));
  } else if (totalBudget && totalBytes > totalBudget * 0.8) {
    violations.push(policyViolation(entry, 'total_bytes_near_budget', 'warn', totalBytes, totalBudget));
  }
  if (budgets.maxFiles && files.length > budgets.maxFiles) {
    violations.push(policyViolation(entry, 'file_count_over_budget', 'error', files.length, budgets.maxFiles));
  }
  if (budgets.maxFileBytes) {
    for (const file of files) {
      if (file.bytes > budgets.maxFileBytes) {
        violations.push({
          classId: entry.id,
          classLabel: entry.label,
          type: 'file_bytes_over_budget',
          severity: 'error',
          value: file.bytes,
          budget: budgets.maxFileBytes,
          file: file.displayPath,
        });
      }
    }
  }
  return violations;
}

function policyViolation(entry, type, severity, value, budget) {
  return {
    classId: entry.id,
    classLabel: entry.label,
    type,
    severity,
    value,
    budget,
  };
}

function statusForClass(entry, files, totalBytes, policyViolations) {
  if (policyViolations.some((violation) => violation.severity === 'error')) return 'over_budget';
  if (policyViolations.length > 0) return 'near_budget';
  if (files.length === 0) return 'no_data';
  const budgets = entry.budgets || {};
  const totalBudget = budgets.hotMaxBytes || budgets.warmMaxBytes || budgets.coldMaxBytes || null;
  if (totalBudget && totalBytes > totalBudget * 0.8) return 'near_budget';
  return 'healthy';
}

function statusForReport(classes, policyViolations) {
  if (policyViolations.some((violation) => violation.severity === 'error')) return 'over_budget';
  if (policyViolations.length > 0 || classes.some((entry) => entry.status === 'near_budget')) return 'near_budget';
  if (classes.every((entry) => entry.status === 'no_data')) return 'no_data';
  return 'healthy';
}

function groupBytes(classes, key) {
  const grouped = {};
  for (const entry of classes) {
    const id = entry[key] || 'unknown';
    grouped[id] ||= { bytes: 0, fileCount: 0, classCount: 0 };
    grouped[id].bytes += entry.totalBytes;
    grouped[id].fileCount += entry.fileCount;
    grouped[id].classCount += 1;
  }
  return grouped;
}

function buildResearchDigest(classes) {
  const researchClasses = classes.filter((entry) => (
    entry.lifecycleTier === 'research_export' ||
    entry.lifecycleTier === 'training_candidate' ||
    entry.sourceType === 'research_artifact' ||
    entry.sourceType === 'training_candidate'
  ));
  const trainingCandidates = classes.filter((entry) => entry.trainingEligible);
  return {
    readOnly: true,
    trainingApproval: false,
    classCount: researchClasses.length,
    fileCount: researchClasses.reduce((sum, entry) => sum + entry.fileCount, 0),
    totalBytes: researchClasses.reduce((sum, entry) => sum + entry.totalBytes, 0),
    trainingCandidateClassCount: trainingCandidates.length,
    trainingCandidateBytes: trainingCandidates.reduce((sum, entry) => sum + entry.totalBytes, 0),
    classes: researchClasses.map((entry) => ({
      id: entry.id,
      label: entry.label,
      sourceType: entry.sourceType,
      lifecycleTier: entry.lifecycleTier,
      fileCount: entry.fileCount,
      totalBytes: entry.totalBytes,
      exportPolicy: entry.exportPolicy,
      trainingEligible: entry.trainingEligible,
    })),
  };
}

function formatRetentionReport(report) {
  const lines = [];
  lines.push(`# Runtime Retention Audit`);
  lines.push('');
  lines.push(`Status: ${report.status}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Read-only: ${report.readOnly ? 'yes' : 'no'}`);
  lines.push(`Artifacts: ${report.summary.fileCount} files across ${report.summary.classesWithData}/${report.summary.artifactClassCount} classes`);
  lines.push(`Total size: ${formatBytes(report.summary.totalBytes)}`);
  lines.push(`Policy violations: ${report.summary.policyViolationCount}`);
  lines.push('');
  lines.push('## Largest Classes');
  for (const entry of report.artifactClasses.slice().sort((a, b) => b.totalBytes - a.totalBytes).slice(0, 10)) {
    lines.push(`- ${entry.label}: ${formatBytes(entry.totalBytes)} across ${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'} (${entry.status})`);
  }
  lines.push('');
  lines.push('## Top Files');
  for (const file of report.topFiles.slice(0, 10)) {
    lines.push(`- ${formatBytes(file.bytes)} ${file.classLabel}: ${file.displayPath || file.relativePath}`);
  }
  if (report.policyViolations.length > 0) {
    lines.push('');
    lines.push('## Policy Pressure');
    for (const violation of report.policyViolations.slice(0, 10)) {
      const file = violation.file ? ` ${violation.file}` : '';
      lines.push(`- ${violation.severity}: ${violation.classLabel} ${violation.type} ${formatValue(violation.value)} / ${formatValue(violation.budget)}${file}`);
    }
  }
  lines.push('');
  lines.push('## Research Digest');
  lines.push(`- Research files: ${report.researchDigest.fileCount}`);
  lines.push(`- Research bytes: ${formatBytes(report.researchDigest.totalBytes)}`);
  lines.push(`- Training approval: ${report.researchDigest.trainingApproval ? 'true' : 'false'}`);
  return lines.join('\n');
}

function formatValue(value) {
  return Number(value) > 1024 ? formatBytes(value) : String(value);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
  return `${Math.round((value / 1024 / 1024 / 1024) * 10) / 10} GB`;
}

function redactRoots(roots, includePaths) {
  const out = {};
  for (const [key, value] of Object.entries(roots)) {
    out[key] = includePaths ? value : redactPath(value);
  }
  return out;
}

function redactPath(value) {
  if (!value) return value;
  const home = require('os').homedir();
  return String(value).startsWith(home) ? `~${String(value).slice(home.length)}` : value;
}

function normalizeRelative(value) {
  return String(value || '').split(path.sep).join('/');
}

module.exports = {
  buildRuntimeRetentionReport,
  formatBytes,
  formatRetentionReport,
};
