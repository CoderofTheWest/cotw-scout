'use strict';

const os = require('os');

const VALIDATOR_VERSION = 'harness-refiner-redaction-validator-v1';

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPatterns({ homeDir = os.homedir() } = {}) {
  const homePathPattern = homeDir
    ? new RegExp(escapeRegExp(homeDir) + '[^\\s)\'"`]*', 'g')
    : null;

  return [
    {
      category: 'anthropic_api_key',
      replacement: '[redacted-anthropic-key]',
      pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g
    },
    {
      category: 'openai_api_key',
      replacement: '[redacted-openai-key]',
      pattern: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/g
    },
    {
      category: 'github_token',
      replacement: '[redacted-github-token]',
      pattern: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g
    },
    {
      category: 'aws_access_key',
      replacement: '[redacted-aws-key]',
      pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
    },
    {
      category: 'oauth_token',
      replacement: '[redacted-oauth-token]',
      pattern: /\b(?:ya29\.[A-Za-z0-9_-]{10,}|xox[abprs]-[A-Za-z0-9-]{10,})\b/g
    },
    {
      category: 'email',
      replacement: '[redacted-email]',
      pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
    },
    {
      category: 'phone',
      replacement: '[redacted-phone]',
      pattern: /(?<![A-Za-z0-9])(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g
    },
    ...(homePathPattern ? [{
      category: 'home_path',
      replacement: '[redacted-home-path]',
      pattern: homePathPattern
    }] : [])
  ];
}

function checkedPatterns(options = {}) {
  return buildPatterns(options).map((definition) => definition.category);
}

function redactText(value, options = {}) {
  let text = String(value ?? '');
  for (const definition of buildPatterns(options)) {
    text = text.replace(definition.pattern, definition.replacement);
  }
  return text;
}

function serializeForValidation(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value || {});
  } catch {
    return String(value || '');
  }
}

function validateNoLeaks(value, options = {}) {
  const text = serializeForValidation(value);
  const leakCounts = {};
  let leakCount = 0;

  for (const definition of buildPatterns(options)) {
    const matches = text.match(definition.pattern);
    const count = matches ? matches.length : 0;
    if (count > 0) {
      leakCounts[definition.category] = count;
      leakCount += count;
    }
  }

  return {
    ok: leakCount === 0,
    validatorVersion: VALIDATOR_VERSION,
    checkedPatterns: checkedPatterns(options),
    leakCounts,
    leakCount
  };
}

function assertNoLeaks(value, options = {}) {
  const report = validateNoLeaks(value, options);
  if (!report.ok) {
    const error = new Error('redaction validation failed');
    error.leakReport = report;
    throw error;
  }
  return report;
}

module.exports = {
  VALIDATOR_VERSION,
  assertNoLeaks,
  checkedPatterns,
  redactText,
  validateNoLeaks
};
