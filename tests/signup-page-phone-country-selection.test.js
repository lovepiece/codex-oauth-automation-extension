const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }

  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
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

test('findPhoneCountryOptionByTarget matches dropdown option by country names from payload', () => {
  const bundle = [
    extractFunction('getPhoneCountryOptionKey'),
    extractFunction('normalizePhoneCountryMatchText'),
    extractFunction('normalizePhoneCountryTarget'),
    extractFunction('findPhoneCountryOptionByTarget'),
  ].join('\n');

  const factory = new Function(`
const thaiOption = {
  id: 'option-TH',
  textContent: 'Thailand +66',
  getAttribute(name) {
    if (name === 'aria-disabled') return 'false';
    if (name === 'data-key') return 'TH';
    return '';
  },
};
const chinaOption = {
  id: 'option-CN',
  textContent: 'China +86',
  getAttribute(name) {
    if (name === 'aria-disabled') return 'false';
    if (name === 'data-key') return 'CN';
    return '';
  },
};
const document = {
  querySelectorAll(selector) {
    if (selector !== '[role="option"]') {
      return [];
    }
    return [chinaOption, thaiOption];
  },
};
function getActionText(option) {
  return option.textContent || '';
}

${bundle}

return { findPhoneCountryOptionByTarget, thaiOption, chinaOption };
`);

  const api = factory();
  const option = api.findPhoneCountryOptionByTarget({
    id: '52',
    name: '泰国',
    eng: 'Thailand',
    chn: '泰国',
    rus: 'Таиланд',
    names: ['泰国', 'Thailand', 'Таиланд'],
  });

  assert.equal(option, api.thaiOption);
});
