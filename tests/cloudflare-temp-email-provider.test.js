const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const source = fs.readFileSync('background.js', 'utf8');

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

test('pollCloudflareTempEmailVerificationCode returns code even if delete fails', async () => {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('throwIfStopped'),
    extractFunction('summarizeCloudflareTempEmailMessagesForLog'),
    extractFunction('pollCloudflareTempEmailVerificationCode'),
  ].join('\n');

const api = new Function(`
let stopRequested = false;
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const CLOUDFLARE_TEMP_EMAIL_DEFAULT_PAGE_SIZE = 20;
const logs = [];
function normalizeCloudflareTempEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

async function addLog(message, level) {
  logs.push({ message, level });
}
async function sleepWithStop() {}
async function listCloudflareTempEmailMessages() {
  return {
    config: {},
    messages: [{
      id: 'mail-1',
      address: 'user@example.com',
      receivedDateTime: '2026-04-13T09:20:00.000Z',
      subject: 'OpenAI verification code',
      from: { emailAddress: { address: 'noreply@tm.openai.com' } },
      bodyPreview: 'Your verification code is 123456.',
    }],
  };
}
function pickVerificationMessageWithTimeFallback(messages) {
  return {
    match: {
      code: '123456',
      receivedAt: Date.parse(messages[0].receivedDateTime),
      message: messages[0],
    },
    usedRelaxedFilters: false,
    usedTimeFallback: false,
  };
}
async function deleteCloudflareTempEmailMail() {
  throw new Error('delete failed');
}

${bundle}

return {
  pollCloudflareTempEmailVerificationCode,
  snapshot() {
    return { logs };
  },
};
`)();

  const result = await api.pollCloudflareTempEmailVerificationCode(4, { email: 'user@example.com' }, {
    targetEmail: 'user@example.com',
    maxAttempts: 1,
    intervalMs: 1,
  });

  assert.equal(result.code, '123456');
  const state = api.snapshot();
  assert.equal(state.logs.some((entry) => entry.message.includes('删除 Cloudflare Temp Email 邮件失败')), true);
});

test('pollCloudflareTempEmailVerificationCode requires target email', async () => {
  const bundle = [
    extractFunction('isStopError'),
    extractFunction('throwIfStopped'),
    extractFunction('pollCloudflareTempEmailVerificationCode'),
  ].join('\n');

  const api = new Function(`
let stopRequested = false;
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const CLOUDFLARE_TEMP_EMAIL_DEFAULT_PAGE_SIZE = 20;
function normalizeCloudflareTempEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}
async function addLog() {}
async function sleepWithStop() {}
async function listCloudflareTempEmailMessages() {
  throw new Error('should not reach list');
}
function pickVerificationMessageWithTimeFallback() {
  return { match: null, usedRelaxedFilters: false, usedTimeFallback: false };
}
async function deleteCloudflareTempEmailMail() {}
function summarizeCloudflareTempEmailMessagesForLog() {
  return '';
}

${bundle}

return { pollCloudflareTempEmailVerificationCode };
`)();

  await assert.rejects(
    api.pollCloudflareTempEmailVerificationCode(4, {}, {}),
    /缺少目标邮箱地址/
  );
});
