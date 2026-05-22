#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createCandidateResearchReport } = require('../lib/candidate-research-diagnostics');

main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  try {
    const inputPath = args.fixture || args.input || path.join(__dirname, '..', 'test', 'fixtures', 'candidate-research-field.json');
    const input = readJson(inputPath);
    const claims = Array.isArray(input.claims) ? input.claims : flattenCases(input.cases, 'claims');
    const edges = Array.isArray(input.edges) ? input.edges : flattenCases(input.cases, 'edges');
    const report = createCandidateResearchReport({
      claims,
      edges,
      mode: args.mode || input.mode || 'map',
      now: args.now || input.now,
      agentId: args.agentId || input.agentId,
      threadId: args.threadId || input.threadId,
      options: {
        maxCandidates: args.maxCandidates,
        maxClusters: args.maxClusters,
        maxTensions: args.maxTensions,
        lexicalSimilarityThreshold: args.lexicalSimilarityThreshold,
        noMutate: true
      }
    });

    if ((args.format || 'markdown') === 'json') {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(renderMarkdown(report));
    }
  } catch (err) {
    console.error(`Candidate research diagnostics failed: ${err.message}`);
    process.exit(1);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--fixture') args.fixture = requireValue(argv, ++i, token);
    else if (token === '--input') args.input = requireValue(argv, ++i, token);
    else if (token === '--mode') args.mode = requireValue(argv, ++i, token);
    else if (token === '--format') args.format = requireValue(argv, ++i, token);
    else if (token === '--now') args.now = requireValue(argv, ++i, token);
    else if (token === '--agent-id') args.agentId = requireValue(argv, ++i, token);
    else if (token === '--thread-id') args.threadId = requireValue(argv, ++i, token);
    else if (token === '--max-candidates') args.maxCandidates = parseInteger(requireValue(argv, ++i, token), token);
    else if (token === '--max-clusters') args.maxClusters = parseInteger(requireValue(argv, ++i, token), token);
    else if (token === '--max-tensions') args.maxTensions = parseInteger(requireValue(argv, ++i, token), token);
    else if (token === '--lexical-similarity-threshold') args.lexicalSimilarityThreshold = parseNumber(requireValue(argv, ++i, token), token);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (args.format && !['json', 'markdown'].includes(args.format)) throw new Error('--format must be json or markdown');
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be a number`);
  return parsed;
}

function readJson(filePath) {
  const absolute = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function flattenCases(cases = [], field) {
  return (Array.isArray(cases) ? cases : []).flatMap((item) => Array.isArray(item[field]) ? item[field] : []);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Candidate Research Diagnostics');
  lines.push('');
  lines.push(`- Mode: ${report.mode}`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Claims read: ${report.safetyCounters.claimsRead}`);
  lines.push(`- Candidate-only read: ${report.safetyCounters.candidateOnlyRead}`);
  lines.push(`- Claims mutated: ${report.safetyCounters.claimsMutated}`);
  lines.push(`- Claims promoted: ${report.safetyCounters.claimsPromoted}`);
  lines.push(`- Prompt injection writes: ${report.safetyCounters.promptInjectionWrites}`);
  lines.push(`- Source resolution attempted: ${report.safetyCounters.sourceResolutionAttempted}`);
  lines.push('');

  lines.push('## Verification Ready');
  if (!report.verificationReady.length) lines.push('');
  if (!report.verificationReady.length) lines.push('- None');
  for (const item of report.verificationReady) {
    lines.push(`- ${item.candidateId}: ${item.recommendedClaimText}`);
    lines.push(`  - Sources: ${item.sourceHandles.join(', ')}`);
  }
  lines.push('');

  lines.push('## Tensions');
  if (!report.tensions.length) lines.push('- None');
  for (const tension of report.tensions) {
    lines.push(`- ${tension.tensionId}: ${tension.type} — ${tension.candidateIds.join(' / ')}`);
    lines.push(`  - Resolve by: ${tension.whatWouldResolveIt}`);
    lines.push(`  - Sources: ${tension.sourceHandles.join(', ')}`);
  }
  lines.push('');

  lines.push('## Clusters');
  if (!report.clusters.length) lines.push('- None');
  for (const cluster of report.clusters) {
    lines.push(`- ${cluster.clusterId}: ${cluster.provisionalLabel}`);
    lines.push(`  - Members: ${cluster.memberCandidateIds.join(', ')}`);
    lines.push(`  - Warnings: ${cluster.warnings.join(', ') || 'none'}`);
  }
  lines.push('');

  lines.push('## Signal Profiles');
  for (const profile of report.signalProfiles) {
    lines.push(`- ${profile.candidateId}: ${profile.kind}; belief=${profile.beliefReadiness}; assertion=${profile.assertionUse}`);
    lines.push(`  - Surfaced: ${profile.surfacedBecause.join(', ') || 'baseline'}`);
    lines.push(`  - Sources: ${profile.sourceHandles.join(', ')}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node scripts/candidate-research-diagnostics.js [--fixture FILE|--input FILE] [--mode map|verification|creative|stale-risk|calibration] [--format markdown|json]',
    '',
    'Read-only candidate research diagnostics. This script reads JSON input only; it does not open ClaimStore, mutate claims, resolve sources, promote candidates, or write prompt context.',
    ''
  ].join('\n'));
}
