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

function createProviderApi(options = {}) {
  const {
    receiveMailbox = '',
    messages = [{
      id: 'mail-1',
      address: 'user@example.com',
      receivedDateTime: '2026-04-13T09:20:00.000Z',
      subject: 'OpenAI verification code',
      from: { emailAddress: { address: 'noreply@tm.openai.com' } },
      bodyPreview: 'Your verification code is 123456.',
    }],
    deleteShouldFail = false,
  } = options;

  const bundle = [
    extractFunction('isStopError'),
    extractFunction('throwIfStopped'),
    extractFunction('normalizeCloudflareTempEmailReceiveMailbox'),
    extractFunction('resolveCloudflareTempEmailPollTargetEmail'),
    extractFunction('summarizeCloudflareTempEmailMessagesForLog'),
    extractFunction('pollCloudflareTempEmailVerificationCode'),
  ].join('\n');

  return new Function('options', `
let stopRequested = false;
const STOP_ERROR_MESSAGE = '流程已被用户停止。';
const CLOUDFLARE_TEMP_EMAIL_DEFAULT_PAGE_SIZE = 20;
const logs = [];
const listCalls = [];
const messages = options.messages;
function normalizeCloudflareTempEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}
async function addLog(message, level) {
  logs.push({ message, level });
}
async function sleepWithStop() {}
function ensureCloudflareTempEmailConfig() {
  return { receiveMailbox: options.receiveMailbox };
}
async function listCloudflareTempEmailMessages(_state, config) {
  listCalls.push(config.address);
  return {
    config: {},
    messages,
  };
}
function pickVerificationMessageWithTimeFallback(currentMessages) {
  return {
    match: currentMessages[0]
      ? {
          code: String(currentMessages[0].bodyPreview).match(/(\\d{6})/)[1],
          receivedAt: Date.parse(currentMessages[0].receivedDateTime),
          message: currentMessages[0],
        }
      : null,
    usedRelaxedFilters: false,
    usedTimeFallback: false,
  };
}
async function deleteCloudflareTempEmailMail() {
  if (options.deleteShouldFail) {
    throw new Error('delete failed');
  }
}

${bundle}

return {
  pollCloudflareTempEmailVerificationCode,
  snapshot() {
    return { logs, listCalls };
  },
};
`)(options);
}

test('pollCloudflareTempEmailVerificationCode returns code even if delete fails', async () => {
  const api = createProviderApi({ deleteShouldFail: true });

  const result = await api.pollCloudflareTempEmailVerificationCode(4, { email: 'user@example.com' }, {
    targetEmail: 'user@example.com',
    maxAttempts: 1,
    intervalMs: 1,
  });

  assert.equal(result.code, '123456');
  const state = api.snapshot();
  assert.equal(state.logs.some((entry) => entry.message.includes('删除 Cloudflare Temp Email 邮件失败')), true);
  assert.deepEqual(state.listCalls, ['user@example.com']);
});

test('pollCloudflareTempEmailVerificationCode requires target email or receive mailbox', async () => {
  const api = createProviderApi({ messages: [] });

  await assert.rejects(
    api.pollCloudflareTempEmailVerificationCode(4, {}, {}),
    /目标邮箱地址|邮件接收邮箱/
  );
});

test('pollCloudflareTempEmailVerificationCode prefers configured receive mailbox over registration email', async () => {
  const api = createProviderApi({
    receiveMailbox: 'forward-box@email.20021108.xyz',
    messages: [{
      id: 'mail-2',
      address: 'forward-box@email.20021108.xyz',
      receivedDateTime: '2026-04-13T10:20:00.000Z',
      subject: 'Login verification code',
      from: { emailAddress: { address: 'noreply@tm.openai.com' } },
      bodyPreview: 'Your verification code is 654321.',
    }],
  });

  const result = await api.pollCloudflareTempEmailVerificationCode(4, {
    email: 'duck-forwarded@duck.com',
    cloudflareTempEmailReceiveMailbox: 'forward-box@email.20021108.xyz',
  }, {
    targetEmail: 'duck-forwarded@duck.com',
    maxAttempts: 1,
    intervalMs: 1,
  });

  assert.equal(result.code, '654321');
  assert.deepEqual(api.snapshot().listCalls, ['forward-box@email.20021108.xyz']);
});
