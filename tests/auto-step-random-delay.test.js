const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let paramsEnd = paramsStart;
  for (; paramsEnd < source.length; paramsEnd += 1) {
    const ch = source[paramsEnd];
    if (ch === '(') paramsDepth += 1;
    if (ch === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        break;
      }
    }
  }

  const braceStart = source.indexOf('{', paramsEnd);
  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

const bundle = [
  'const AUTO_STEP_RANDOM_DELAY_MIN_ALLOWED_SECONDS = 0;',
  'const AUTO_STEP_RANDOM_DELAY_MAX_ALLOWED_SECONDS = 600;',
  'const AUTO_STEP_RANDOM_DELAY_DEFAULT_MIN_SECONDS = 12;',
  'const AUTO_STEP_RANDOM_DELAY_DEFAULT_MAX_SECONDS = 18;',
  'const PERSISTED_SETTING_DEFAULTS = { autoStepRandomDelayMinSeconds: 12, autoStepRandomDelayMaxSeconds: 18 };',
  extractFunction('normalizeAutoStepRandomDelaySeconds'),
  extractFunction('normalizeAutoStepRandomDelayRange'),
  extractFunction('getAutoStepRandomDelayMs'),
].join('\n');

const api = new Function(`${bundle}; return { normalizeAutoStepRandomDelaySeconds, normalizeAutoStepRandomDelayRange, getAutoStepRandomDelayMs };`)();

const defaultRange = api.normalizeAutoStepRandomDelayRange({});
assert.deepStrictEqual(defaultRange, { minSeconds: 12, maxSeconds: 18 }, 'missing settings should fall back to the default 12-18 second range');

for (let i = 0; i < 200; i += 1) {
  const delay = api.getAutoStepRandomDelayMs(defaultRange.minSeconds * 1000, defaultRange.maxSeconds * 1000);
  assert.ok(delay >= 12000, `delay ${delay} should respect the lower bound`);
  assert.ok(delay <= 18000, `delay ${delay} should respect the upper bound`);
  assert.ok(Number.isInteger(delay), `delay ${delay} should be an integer`);
}

const samples = new Set(Array.from({ length: 50 }, () => api.getAutoStepRandomDelayMs(defaultRange.minSeconds * 1000, defaultRange.maxSeconds * 1000)));
assert.ok(samples.size > 1, 'delay helper should produce randomized values');

const customRange = api.normalizeAutoStepRandomDelayRange({
  autoStepRandomDelayMinSeconds: 5,
  autoStepRandomDelayMaxSeconds: 7,
});
assert.deepStrictEqual(customRange, { minSeconds: 5, maxSeconds: 7 }, 'configured ranges should be preserved when already valid');

const collapsedRange = api.normalizeAutoStepRandomDelayRange({
  autoStepRandomDelayMinSeconds: 20,
  autoStepRandomDelayMaxSeconds: 10,
});
assert.deepStrictEqual(collapsedRange, { minSeconds: 20, maxSeconds: 20 }, 'max delay should collapse up to min delay when user input is inverted');

assert.strictEqual(
  api.getAutoStepRandomDelayMs(15000, 15000),
  15000,
  'equal bounds should produce a deterministic delay'
);

const originalRandom = Math.random;
try {
  Math.random = () => 0.6;
  assert.strictEqual(
    api.normalizeAutoStepRandomDelaySeconds(-50, 12),
    0,
    'negative configured delay should clamp to zero seconds'
  );
  assert.strictEqual(
    api.getAutoStepRandomDelayMs(-50, 10),
    6,
    'lower bound should be clamped to zero and still allow random output'
  );
} finally {
  Math.random = originalRandom;
}

console.log('auto step random delay tests passed');
