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
    extractFunction('getPhoneCountryOptionMatchText'),
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

test('findPhoneCountryOption scrolls virtualized listbox to locate target country', async () => {
  const bundle = [
    extractFunction('getPhoneDigits'),
    extractFunction('getPhoneCountryOptionDialCode'),
    extractFunction('getPhoneCountryOptionKey'),
    extractFunction('getPhoneCountryOptionMatchText'),
    extractFunction('normalizePhoneCountryMatchText'),
    extractFunction('normalizePhoneCountryTarget'),
    extractFunction('findPhoneCountryOptionForNumber'),
    extractFunction('findPhoneCountryOptionByTarget'),
    extractFunction('getPhoneCountryListBox'),
    extractFunction('scrollPhoneCountryListBox'),
    extractFunction('findPhoneCountryOption'),
  ].join('\n');

  const factory = new Function(`
function createOption(id, key, text) {
  return {
    id,
    textContent: text,
    getAttribute(name) {
      if (name === 'aria-disabled') return 'false';
      if (name === 'data-key') return key;
      return '';
    },
    querySelectorAll() {
      return [];
    },
  };
}

const firstPageOptions = [
  createOption('option-US', 'US', '美国 (+1)'),
  createOption('option-CN', 'CN', '中国 (+86)'),
];
const secondPageOptions = [
  createOption('option-TH', 'TH', '泰国 (+66)'),
];

const listBox = {
  scrollTop: 0,
  clientHeight: 400,
  scrollHeight: 9800,
  scrollTo({ top }) {
    this.scrollTop = top;
  },
};

const document = {
  querySelector(selector) {
    if (selector === '[role="listbox"]') {
      return listBox;
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector !== '[role="option"]') {
      return [];
    }
    return listBox.scrollTop >= 300 ? secondPageOptions : firstPageOptions;
  },
};

function getActionText(option) {
  return option.textContent || '';
}
function isVisibleElement() {
  return true;
}
function throwIfStopped() {}
async function sleep() {}

${bundle}

return { findPhoneCountryOption, listBox, secondPageOptions };
`);

  const api = factory();
  const option = await api.findPhoneCountryOption({
    name: '泰国',
    eng: 'Thailand',
    names: ['泰国', 'Thailand'],
  }, '66834507628', 2000);

  assert.equal(option, api.secondPageOptions[0]);
  assert.ok(api.listBox.scrollTop > 0);
});

test('buildFixedPhoneCountryFallbackValue falls back to Thailand +66 format', () => {
  const bundle = [
    extractFunction('getPhoneDigits'),
    extractFunction('buildFixedPhoneCountryFallbackValue'),
  ].join('\n');

  const factory = new Function(`
const FIXED_PHONE_COUNTRY_FALLBACK = {
  key: 'TH',
  dialCode: '66',
  name: '泰国',
};

${bundle}

return { buildFixedPhoneCountryFallbackValue };
`);

  const api = factory();

  assert.equal(api.buildFixedPhoneCountryFallbackValue('66834507628'), '+66834507628');
  assert.equal(api.buildFixedPhoneCountryFallbackValue('834507628'), '+66834507628');
});
