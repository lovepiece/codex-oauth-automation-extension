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

test('phone number formatting keeps direct international value for add-phone inputs', () => {
  const api = new Function(`
function getSelectedPhoneCountryDialCode() {
  return '237';
}

${extractFunction('getPhoneDigits')}
${extractFunction('normalizePhoneCountryTarget')}
${extractFunction('buildInternationalPhoneValue')}
${extractFunction('normalizePhoneNumberForDialCode')}
${extractFunction('normalizePhoneNumberForOpenAiForm')}

return {
  buildInternationalPhoneValue,
  normalizePhoneNumberForDialCode,
  normalizePhoneNumberForOpenAiForm,
};
`)();

  assert.equal(
    api.buildInternationalPhoneValue('237688632116', null),
    '+237688632116'
  );
  assert.equal(
    api.buildInternationalPhoneValue('+237688632116', null),
    '+237688632116'
  );

  assert.equal(
    api.normalizePhoneNumberForDialCode('237686438311', '237'),
    '686438311'
  );
  assert.equal(
    api.normalizePhoneNumberForOpenAiForm('+237 6 86 43 83 11'),
    '686438311'
  );
});

test('phone submit waits for continue button after filling number', () => {
  const submitPhoneNumberSource = extractFunction('submitPhoneNumber');

  assert.match(source.slice(0, source.indexOf('function getVerificationCodeTarget')), /message\.type === 'SUBMIT_PHONE_NUMBER'/);
  assert.match(source, /async function waitForPhoneActionButtonEnabled\(/);
  assert.ok(
    submitPhoneNumberSource.indexOf('const actionButton = snapshot.actionButton')
      < submitPhoneNumberSource.indexOf('fillInput(phoneInput, phoneInputValue)')
  );
  assert.ok(
    submitPhoneNumberSource.indexOf('fillInput(phoneInput, phoneInputValue)')
      < submitPhoneNumberSource.indexOf('await waitForPhoneActionButtonEnabled(8000)')
  );
  assert.doesNotMatch(
    submitPhoneNumberSource.slice(
      submitPhoneNumberSource.indexOf('const actionButton = snapshot.actionButton'),
      submitPhoneNumberSource.indexOf('fillInput(phoneInput, phoneInputValue)')
    ),
    /isActionEnabled\(actionButton\)/
  );
});

test('phone submit fills full international number without preselecting country', () => {
  const submitPhoneNumberSource = extractFunction('submitPhoneNumber');

  assert.doesNotMatch(submitPhoneNumberSource, /ensurePhoneCountryMatchesNumber\(phoneNumber, phoneCountry\)/);
  assert.doesNotMatch(submitPhoneNumberSource, /normalizePhoneNumberForDialCode\(phoneNumber, selectedDialCode\)/);
  assert.match(submitPhoneNumberSource, /const phoneInputValue = directPhoneValue/);
  assert.match(submitPhoneNumberSource, /const hiddenValue = directPhoneValue/);
});

test('phone code entry only starts on phone-verification page', () => {
  const waitForPhoneCodeEntryReadySource = extractFunction('waitForPhoneCodeEntryReady');
  const submitPhoneNumberSource = extractFunction('submitPhoneNumber');

  assert.match(source, /function isPhoneNumberEntryPageUrl\(/);
  assert.match(source, /function isPhoneVerificationCodePageUrl\(/);
  assert.match(source, /phoneVerificationPage: Boolean\(snapshot\?\.phoneVerificationPage\)/);
  assert.match(waitForPhoneCodeEntryReadySource, /snapshot\.phoneVerificationPage && snapshot\.codeTarget/);
  assert.match(submitPhoneNumberSource, /phoneVerificationPage: true/);
});
