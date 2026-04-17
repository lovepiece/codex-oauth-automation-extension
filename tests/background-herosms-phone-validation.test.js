const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

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

test('ensureHeroSmsActivationReadyForSubmission retries when getStatus returns STATUS_CANCEL', async () => {
  const bundle = [
    extractFunction('isHeroSmsActivationCanceledStatus'),
    extractFunction('ensureHeroSmsActivationReadyForSubmission'),
  ].join('\n');

  const factory = new Function(`
let currentState = { heroSmsCountry: '52' };
const activations = [
  { activationId: 101, phoneNumber: '66810000001', country: '52' },
  { activationId: 202, phoneNumber: '66810000002', country: '52' },
];
const statusCalls = [];
const clearedActivationIds = [];
const runtimeStatuses = [];
const logs = [];
let activationCursor = 0;

async function getState() {
  return currentState;
}
async function ensureHeroSmsActivationForFlow() {
  const activation = activations[Math.min(activationCursor, activations.length - 1)];
  activationCursor += 1;
  currentState.currentHeroSmsActivation = activation;
  return activation;
}
function getHeroSmsConfig(state) {
  return { country: state.heroSmsCountry, service: 'dr', baseUrl: 'https://hero-sms.com/stubs/handler_api.php', apiKey: 'sk-test' };
}
function ensureHeroSmsConfig(config) {
  return config;
}
async function heroSmsGetStatus(_config, activationId) {
  statusCalls.push(activationId);
  return activationId === 101
    ? { status: 'STATUS_CANCEL', raw: 'STATUS_CANCEL' }
    : { status: 'STATUS_WAIT_CODE', raw: 'STATUS_WAIT_CODE' };
}
async function mergeHeroSmsCurrentActivationState(patch) {
  currentState.currentHeroSmsActivation = {
    ...currentState.currentHeroSmsActivation,
    ...patch,
  };
  return currentState.currentHeroSmsActivation;
}
async function addLog(message) {
  logs.push(message);
}
async function setHeroSmsCurrentActivationState(value) {
  if (currentState.currentHeroSmsActivation) {
    clearedActivationIds.push(currentState.currentHeroSmsActivation.activationId);
  }
  currentState.currentHeroSmsActivation = value;
  return value;
}
async function setHeroSmsLastCodeState() {}
async function setHeroSmsRuntimeStatusState(status) {
  runtimeStatuses.push(status);
}
const HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT = 3;

${bundle}

return {
  ensureHeroSmsActivationReadyForSubmission,
  snapshot() {
    return {
      statusCalls,
      clearedActivationIds,
      runtimeStatuses,
      logs,
      currentState,
    };
  },
};
`);

  const api = factory();
  const activation = await api.ensureHeroSmsActivationReadyForSubmission({ heroSmsCountry: '52' });
  const snapshot = api.snapshot();

  assert.equal(activation.activationId, 202);
  assert.deepEqual(snapshot.statusCalls, [101, 202]);
  assert.deepEqual(snapshot.clearedActivationIds, [101]);
  assert.match(snapshot.logs[0], /STATUS_CANCEL/);
  assert.match(snapshot.runtimeStatuses[0], /重新获取 HeroSMS 号码/);
});

test('getHeroSmsCountrySelection resolves names from SMS-Country.json data', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsCountryCatalogEntry'),
    extractFunction('loadHeroSmsCountryCatalog'),
    extractFunction('getHeroSmsCountrySelection'),
  ].join('\n');

  const factory = new Function(`
let heroSmsCountryCatalogPromise = null;
const LOG_PREFIX = '[test]';
const chrome = {
  runtime: {
    getURL(path) {
      return path;
    },
  },
};
const console = { warn() {} };
async function fetch(path) {
  return {
    ok: true,
    async json() {
      if (path !== 'data/SMS-Country.json') {
        throw new Error('unexpected path: ' + path);
      }
      return [
        { id: 52, eng: 'Thailand', chn: '泰国', rus: 'Таиланд' },
        { id: 3, eng: 'China', chn: '中国', rus: 'Китай' },
      ];
    },
  };
}

${bundle}

return { getHeroSmsCountrySelection };
`);

  const api = factory();
  const country = await api.getHeroSmsCountrySelection('52');

  assert.deepEqual(country, {
    id: '52',
    name: '泰国',
    eng: 'Thailand',
    chn: '泰国',
    rus: 'Таиланд',
    names: ['泰国', 'Thailand', 'Таиланд'],
  });
});

test('parseHeroSmsActiveActivationsResponse reads active activation rows from API payload', () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsActiveActivation'),
    extractFunction('normalizeHeroSmsActiveActivationList'),
    extractFunction('extractHeroSmsErrorText'),
    extractFunction('parseHeroSmsActiveActivationsResponse'),
  ].join('\n');

  const factory = new Function(`
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };

${bundle}

return { parseHeroSmsActiveActivationsResponse };
`);

  const api = factory();
  const result = api.parseHeroSmsActiveActivationsResponse({
    status: 'success',
    data: [
      {
        activationId: '284049402',
        serviceCode: 'dr',
        phoneNumber: '66638986249',
        activationStatus: '2',
        activationTime: '2026-04-17 19:58:38',
        countryCode: '52',
        activationCost: 0.05,
        smsCode: '334112',
        smsText: '您的 OpenAI 验证代码是：334112',
        estDate: '2026-04-17 20:18:38',
      },
      {
        activationId: '284091501',
        serviceCode: 'dr',
        phoneNumber: '66845874610',
        activationStatus: '2',
        activationTime: '2026-04-17 20:15:18',
        countryCode: '52',
        activationCost: 0.05,
        smsCode: '657431',
        smsText: '您的 OpenAI 验证代码是：657431',
        estDate: '2026-04-17 20:35:18',
      },
    ],
    activeActivations: {
      row: {
        id: '284049402',
        service: 'dr',
        country: '52',
        phone: '66638986249',
        status: '2',
        createDate: '2026-04-17 19:58:38',
        estDate: '2026-04-17 20:18:38',
        code: '334112',
        text: '您的 OpenAI 验证代码是：334112',
      },
      rows: [
        {
          activationId: '284049402',
          serviceCode: 'dr',
          phoneNumber: '66638986249',
          activationStatus: '2',
          activationTime: '2026-04-17 19:58:38',
          countryCode: '52',
          smsCode: '334112',
          smsText: '您 的 OpenAI 验证代码是：334112',
          estDate: '2026-04-17 20:18:38',
        },
        {
          activationId: '284091501',
          serviceCode: 'dr',
          phoneNumber: '66845874610',
          activationStatus: '2',
          activationTime: '2026-04-17 20:15:18',
          countryCode: '52',
          smsCode: '657431',
          smsText: '您的 OpenAI 验证代码是：657431',
          estDate: '2026-04-17 20:35:18',
        },
      ],
    },
  });

  assert.deepEqual(
    result.map((item) => ({
      activationId: item.activationId,
      phoneNumber: item.phoneNumber,
      service: item.service,
      country: item.country,
      status: item.status,
      smsCode: item.smsCode,
      smsText: item.smsText,
      acquiredAt: item.acquiredAt,
      expiresAt: item.expiresAt,
    })),
    [
      {
        activationId: 284091501,
        phoneNumber: '66845874610',
        service: 'dr',
        country: '52',
        status: '2',
        smsCode: '657431',
        smsText: '您的 OpenAI 验证代码是：657431',
        acquiredAt: Date.parse('2026-04-17 20:15:18'),
        expiresAt: Date.parse('2026-04-17 20:35:18'),
      },
      {
        activationId: 284049402,
        phoneNumber: '66638986249',
        service: 'dr',
        country: '52',
        status: '2',
        smsCode: '334112',
        smsText: '您的 OpenAI 验证代码是：334112',
        acquiredAt: Date.parse('2026-04-17 19:58:38'),
        expiresAt: Date.parse('2026-04-17 20:18:38'),
      },
    ]
  );
});

test('takeReusableHeroSmsStandbyActivation reuses a standby number after retry delay', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsBaseUrl'),
    extractFunction('normalizeHeroSmsActivation'),
    extractFunction('normalizeHeroSmsStandbyActivation'),
    extractFunction('normalizeHeroSmsStandbyActivationList'),
    extractFunction('getHeroSmsConfig'),
    extractFunction('getHeroSmsActivationRemainingMs'),
    extractFunction('isHeroSmsActivationCanceledStatus'),
    extractFunction('getHeroSmsStandbyActivations'),
    extractFunction('setHeroSmsStandbyActivationsState'),
    extractFunction('removeHeroSmsStandbyActivationState'),
    extractFunction('isHeroSmsStandbyActivationReusable'),
    extractFunction('cleanupExpiredHeroSmsStandbyActivations'),
    extractFunction('takeReusableHeroSmsStandbyActivation'),
  ].join('\n');

  const factory = new Function(`
let currentState = {
  heroSmsService: 'dr',
  heroSmsCountry: '52',
  heroSmsStandbyActivations: [
    {
      activationId: 301,
      phoneNumber: '66810000003',
      service: 'dr',
      country: '52',
      acquiredAt: Date.now() - 60_000,
      expiresAt: Date.now() + 8 * 60_000,
      useCount: 1,
      retryAt: Date.now() - 1_000,
      standbyAt: Date.now() - 6 * 60_000,
      status: 'waiting_retry',
    },
  ],
};
const logs = [];
const runtimeStatuses = [];

async function getState() {
  return currentState;
}
async function setState(patch) {
  currentState = { ...currentState, ...patch };
}
function broadcastDataUpdate() {}
async function setHeroSmsCurrentActivationState(activation) {
  currentState.currentHeroSmsActivation = activation;
  return activation;
}
async function setHeroSmsRuntimeStatusState(status) {
  runtimeStatuses.push(status);
}
async function addLog(message) {
  logs.push(message);
}
const HERO_SMS_NUMBER_MAX_USES = 5;
const HERO_SMS_ACTIVATION_TTL_MS = 20 * 60 * 1000;
const HERO_SMS_STANDBY_RETRY_DELAY_MS = 5 * 60 * 1000;
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };
const DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';

${bundle}

return {
  takeReusableHeroSmsStandbyActivation,
  snapshot() {
    return { currentState, logs, runtimeStatuses };
  },
};
`);

  const api = factory();
  const activation = await api.takeReusableHeroSmsStandbyActivation();
  const snapshot = api.snapshot();

  assert.equal(activation.activationId, 301);
  assert.equal(snapshot.currentState.heroSmsStandbyActivations.length, 0);
  assert.equal(snapshot.currentState.currentHeroSmsActivation.activationId, 301);
  assert.match(snapshot.logs[0], /备用列表恢复手机号/);
  assert.match(snapshot.runtimeStatuses[0], /备用列表恢复号码/);
});

test('takeReusableHeroSmsRemoteActiveActivation restores a matching active number from HeroSMS', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsBaseUrl'),
    extractFunction('normalizeHeroSmsActivation'),
    extractFunction('normalizeHeroSmsFailedActivation'),
    extractFunction('normalizeHeroSmsFailedActivationList'),
    extractFunction('normalizeHeroSmsStandbyActivation'),
    extractFunction('normalizeHeroSmsStandbyActivationList'),
    extractFunction('normalizeHeroSmsActiveActivation'),
    extractFunction('normalizeHeroSmsActiveActivationList'),
    extractFunction('getHeroSmsConfig'),
    extractFunction('isHeroSmsActivationCanceledStatus'),
    extractFunction('getHeroSmsFailedActivations'),
    extractFunction('getHeroSmsStandbyActivations'),
    extractFunction('setHeroSmsActiveActivationsState'),
    extractFunction('pickReusableHeroSmsRemoteActiveActivation'),
    extractFunction('takeReusableHeroSmsRemoteActiveActivation'),
  ].join('\n');

  const factory = new Function(`
let currentState = {
  heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
  heroSmsApiKey: 'sk-test',
  heroSmsService: 'dr',
  heroSmsCountry: '52',
  heroSmsFailedActivations: [],
  heroSmsStandbyActivations: [],
  heroSmsActiveActivations: [],
  heroSmsActiveActivationsFetchedAt: 0,
};
const logs = [];
const runtimeStatuses = [];
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };
const DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
const HERO_SMS_ACTIVATION_TTL_MS = 20 * 60 * 1000;
const HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS = 2 * 60 * 1000;
const HERO_SMS_STANDBY_RETRY_DELAY_MS = 5 * 60 * 1000;

async function getState() {
  return currentState;
}
async function setState(patch) {
  currentState = { ...currentState, ...patch };
}
function broadcastDataUpdate() {}
async function setHeroSmsCurrentActivationState(activation) {
  currentState.currentHeroSmsActivation = activation;
  return activation;
}
async function setHeroSmsRuntimeStatusState(status) {
  runtimeStatuses.push(status);
}
async function addLog(message) {
  logs.push(message);
}

${bundle}

return {
  takeReusableHeroSmsRemoteActiveActivation,
  snapshot() {
    return { currentState, logs, runtimeStatuses };
  },
};
`);

  const api = factory();
  const activation = await api.takeReusableHeroSmsRemoteActiveActivation(undefined, {
    activeList: [
      {
        activationId: '701',
        phoneNumber: '66810000008',
        serviceCode: 'dr',
        countryCode: '52',
        activationStatus: '1',
        activationTime: '2026-04-17 20:15:18',
        estDate: '2026-04-17 20:35:18',
        smsCode: '',
        smsText: '',
      },
    ],
  });
  const snapshot = api.snapshot();

  assert.equal(activation.activationId, 701);
  assert.equal(activation.phoneNumber, '66810000008');
  assert.equal(snapshot.currentState.currentHeroSmsActivation.activationId, 701);
  assert.equal(snapshot.currentState.heroSmsActiveActivations.length, 1);
  assert.match(snapshot.logs[0], /活跃号码列表恢复手机号/);
  assert.match(snapshot.runtimeStatuses[0], /活跃列表恢复号码/);
});

test('finalizeHeroSmsActivation completes and releases current number for phone_max_usage_exceeded', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsActivation'),
    extractFunction('extractHeroSmsErrorText'),
    extractFunction('validateHeroSmsSetStatusResponse'),
    extractFunction('heroSmsReleaseActivation'),
    extractFunction('attemptHeroSmsActivationRelease'),
    extractFunction('getCurrentHeroSmsActivation'),
    extractFunction('finalizeHeroSmsActivation'),
  ].join('\n');

  const factory = new Function(`
let currentState = {
  heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
  heroSmsApiKey: 'sk-test',
  heroSmsService: 'dr',
  heroSmsCountry: '52',
  currentHeroSmsActivation: {
    activationId: 801,
    phoneNumber: '66810000009',
    service: 'dr',
    country: '52',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 20 * 60 * 1000,
    useCount: 1,
  },
};
const finishCalls = [];
const cancelCalls = [];
const setStatusCalls = [];
const runtimeStatuses = [];
const logs = [];
const lastCodes = [];
const syncCalls = [];

async function getState() {
  return currentState;
}
function getCurrentHeroSmsActivation(state) {
  return state.currentHeroSmsActivation || null;
}
function getHeroSmsConfig(state) {
  return {
    baseUrl: state.heroSmsBaseUrl,
    apiKey: state.heroSmsApiKey,
    service: state.heroSmsService,
    country: state.heroSmsCountry,
  };
}
async function heroSmsSetStatus(_config, activationId, status) {
  setStatusCalls.push({ activationId, status });
  return status === 6 ? 'ACCESS_ACTIVATION' : 'ACCESS_CANCEL';
}
async function heroSmsFinishActivation(_config, activationId) {
  finishCalls.push(activationId);
  return 'ACCESS_ACTIVATION';
}
async function heroSmsCancelActivation(_config, activationId) {
  cancelCalls.push(activationId);
  return 'ACCESS_CANCEL';
}
async function setHeroSmsCurrentActivationState(value) {
  currentState.currentHeroSmsActivation = value;
  return value;
}
async function setHeroSmsLastCodeState(value) {
  lastCodes.push(value);
}
async function setHeroSmsRuntimeStatusState(status) {
  runtimeStatuses.push(status);
}
async function addLog(message) {
  logs.push(message);
}
async function syncHeroSmsActiveActivations(_state, options = {}) {
  syncCalls.push(options.fetchedAt || 0);
  return [];
}
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };

${bundle}

return {
  finalizeHeroSmsActivation,
  snapshot() {
    return { currentState, finishCalls, cancelCalls, setStatusCalls, runtimeStatuses, logs, lastCodes, syncCalls };
  },
};
`);

  const api = factory();
  const result = await api.finalizeHeroSmsActivation(undefined, {
    preferComplete: true,
    releaseReason: 'phone_max_usage_exceeded',
    silent: false,
  });
  const snapshot = api.snapshot();

  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(result.mode, 'complete');
  assert.deepEqual(snapshot.setStatusCalls, [{ activationId: 801, status: 6 }]);
  assert.deepEqual(snapshot.finishCalls, []);
  assert.deepEqual(snapshot.cancelCalls, []);
  assert.equal(snapshot.currentState.currentHeroSmsActivation, null);
  assert.deepEqual(snapshot.lastCodes, ['']);
  assert.match(snapshot.runtimeStatuses[0], /已完成/);
  assert.match(snapshot.logs[0], /已完成号码/);
  assert.equal(snapshot.syncCalls.length, 1);
});

test('finalizeHeroSmsActivation keeps current number when release fails', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsActivation'),
    extractFunction('extractHeroSmsErrorText'),
    extractFunction('validateHeroSmsSetStatusResponse'),
    extractFunction('heroSmsReleaseActivation'),
    extractFunction('attemptHeroSmsActivationRelease'),
    extractFunction('getCurrentHeroSmsActivation'),
    extractFunction('finalizeHeroSmsActivation'),
  ].join('\n');

  const factory = new Function(`
let currentState = {
  heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
  heroSmsApiKey: 'sk-test',
  heroSmsService: 'dr',
  heroSmsCountry: '52',
  currentHeroSmsActivation: {
    activationId: 802,
    phoneNumber: '66810000010',
    service: 'dr',
    country: '52',
    acquiredAt: Date.now(),
    expiresAt: Date.now() + 20 * 60 * 1000,
    useCount: 1,
  },
};
const setStatusCalls = [];
const runtimeStatuses = [];
const logs = [];
const syncCalls = [];

async function getState() {
  return currentState;
}
function getHeroSmsConfig(state) {
  return {
    baseUrl: state.heroSmsBaseUrl,
    apiKey: state.heroSmsApiKey,
    service: state.heroSmsService,
    country: state.heroSmsCountry,
  };
}
async function heroSmsSetStatus(_config, activationId, status) {
  setStatusCalls.push({ activationId, status });
  return '{"title":"OTP_RECEIVED","details":"Cannot terminate activation - OTP has been received on this number"}';
}
async function heroSmsFinishActivation() {
  throw new Error('finish failed');
}
async function heroSmsCancelActivation() {
  throw new Error('cancel failed');
}
async function setHeroSmsCurrentActivationState(value) {
  currentState.currentHeroSmsActivation = value;
  return value;
}
async function setHeroSmsLastCodeState() {}
async function setHeroSmsRuntimeStatusState(status) {
  runtimeStatuses.push(status);
}
async function addLog(message) {
  logs.push(message);
}
async function syncHeroSmsActiveActivations(_state, options = {}) {
  syncCalls.push(options.fetchedAt || 0);
  return [];
}
const HERO_SMS_NUMBER_MAX_USES = 5;
const HERO_SMS_ACTIVATION_TTL_MS = 20 * 60 * 1000;
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };

${bundle}

return {
  finalizeHeroSmsActivation,
  snapshot() {
    return { currentState, setStatusCalls, runtimeStatuses, logs, syncCalls };
  },
};
`);

  const api = factory();
  const result = await api.finalizeHeroSmsActivation(undefined, {
    preferComplete: false,
    releaseReason: 'phone_resend_rate_limited',
    silent: false,
  });
  const snapshot = api.snapshot();

  assert.equal(result.released, false);
  assert.equal(snapshot.currentState.currentHeroSmsActivation.activationId, 802);
  assert.deepEqual(snapshot.setStatusCalls, [{ activationId: 802, status: 8 }]);
  assert.equal(snapshot.runtimeStatuses.length, 0);
  assert.equal(snapshot.syncCalls.length, 0);
  assert.match(snapshot.logs[0], /释放号码 .* 失败/);
});

test('cleanupHeroSmsFailedActivation cancels normal failures and only completes max-usage failures', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsBaseUrl'),
    extractFunction('normalizeHeroSmsFailedActivation'),
    extractFunction('normalizeHeroSmsFailedActivationList'),
    extractFunction('extractHeroSmsErrorText'),
    extractFunction('validateHeroSmsSetStatusResponse'),
    extractFunction('heroSmsReleaseActivation'),
    extractFunction('attemptHeroSmsActivationRelease'),
    extractFunction('getHeroSmsFailedActivations'),
    extractFunction('cleanupHeroSmsFailedActivation'),
  ].join('\n');

  const factory = new Function(`
let currentState = {
  heroSmsFailedActivations: [
    {
      activationId: 401,
      phoneNumber: '66810000004',
      service: 'dr',
      country: '52',
      failedAt: Date.now(),
      cleanupAt: Date.now(),
      reason: 'phone_sms_unavailable',
      useCount: 3,
      status: 'scheduled',
      baseUrl: 'https://hero-sms.com/stubs/handler_api.php',
      apiKey: 'sk-test',
    },
    {
      activationId: 402,
      phoneNumber: '66810000005',
      service: 'dr',
      country: '52',
      failedAt: Date.now(),
      cleanupAt: Date.now(),
      reason: 'phone_max_usage_exceeded',
      useCount: 1,
      status: 'scheduled',
      baseUrl: 'https://hero-sms.com/stubs/handler_api.php',
      apiKey: 'sk-test',
    },
  ],
};
const cancelCalls = [];
const finishCalls = [];
const setStatusCalls = [];
const logs = [];

async function getState() {
  return currentState;
}
function getHeroSmsConfig() {
  return {
    baseUrl: 'https://hero-sms.com/stubs/handler_api.php',
    apiKey: 'sk-test',
    service: 'dr',
    country: '52',
  };
}
async function heroSmsSetStatus(_config, activationId, status) {
  setStatusCalls.push({ activationId, status });
  return status === 6 ? 'ACCESS_ACTIVATION' : 'ACCESS_CANCEL';
}
async function heroSmsCancelActivation(_config, activationId) {
  cancelCalls.push(activationId);
  return 'ACCESS_CANCEL';
}
async function heroSmsFinishActivation(_config, activationId) {
  finishCalls.push(activationId);
  return 'ACCESS_ACTIVATION';
}
async function addLog(message) {
  logs.push(message);
}
async function clearHeroSmsFailedActivationCleanupAlarm() {}
async function setState(patch) {
  currentState = { ...currentState, ...patch };
}
function broadcastDataUpdate() {}
const HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS = 2 * 60 * 1000;
const HERO_SMS_NUMBER_MAX_USES = 5;
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };
async function upsertHeroSmsFailedActivationState(entry) {
  const normalizedEntry = normalizeHeroSmsFailedActivation(entry);
  const currentList = getHeroSmsFailedActivations(currentState);
  const existingIndex = currentList.findIndex((item) => item.activationId === normalizedEntry.activationId);
  if (existingIndex >= 0) {
    currentList[existingIndex] = { ...currentList[existingIndex], ...normalizedEntry };
  } else {
    currentList.unshift(normalizedEntry);
  }
  await setState({ heroSmsFailedActivations: currentList });
  return currentList;
}

${bundle}

return {
  cleanupHeroSmsFailedActivation,
  snapshot() {
    return { currentState, cancelCalls, finishCalls, setStatusCalls, logs };
  },
};
`);

  const api = factory();
  await api.cleanupHeroSmsFailedActivation(401);
  await api.cleanupHeroSmsFailedActivation(402);
  const snapshot = api.snapshot();

  assert.deepEqual(snapshot.setStatusCalls, [
    { activationId: 401, status: 8 },
    { activationId: 402, status: 6 },
  ]);
  assert.deepEqual(snapshot.cancelCalls, []);
  assert.deepEqual(snapshot.finishCalls, []);
  assert.equal(snapshot.currentState.heroSmsFailedActivations.find((item) => item.activationId === 401).status, 'cancelled');
  assert.equal(snapshot.currentState.heroSmsFailedActivations.find((item) => item.activationId === 402).status, 'completed');
});

test('cleanupExpiredHeroSmsStandbyActivations auto releases expired or maxed standby numbers', async () => {
  const bundle = [
    extractFunction('normalizeHeroSmsCountry'),
    extractFunction('normalizeHeroSmsService'),
    extractFunction('normalizeHeroSmsBaseUrl'),
    extractFunction('normalizeHeroSmsActivation'),
    extractFunction('normalizeHeroSmsStandbyActivation'),
    extractFunction('normalizeHeroSmsStandbyActivationList'),
    extractFunction('extractHeroSmsErrorText'),
    extractFunction('validateHeroSmsSetStatusResponse'),
    extractFunction('heroSmsReleaseActivation'),
    extractFunction('attemptHeroSmsActivationRelease'),
    extractFunction('getHeroSmsConfig'),
    extractFunction('getHeroSmsActivationRemainingMs'),
    extractFunction('getHeroSmsStandbyActivations'),
    extractFunction('setHeroSmsStandbyActivationsState'),
    extractFunction('cleanupExpiredHeroSmsStandbyActivations'),
  ].join('\n');

  const factory = new Function(`
let currentState = {
  heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
  heroSmsApiKey: 'sk-test',
  heroSmsService: 'dr',
  heroSmsCountry: '52',
  heroSmsStandbyActivations: [
    {
      activationId: 901,
      phoneNumber: '66810000011',
      service: 'dr',
      country: '52',
      acquiredAt: Date.now() - 30 * 60 * 1000,
      expiresAt: Date.now() - 1000,
      useCount: 1,
      retryAt: Date.now() - 1000,
      standbyAt: Date.now() - 10 * 60 * 1000,
      status: 'waiting_retry',
    },
    {
      activationId: 902,
      phoneNumber: '66810000012',
      service: 'dr',
      country: '52',
      acquiredAt: Date.now() - 10 * 60 * 1000,
      expiresAt: Date.now() + 10 * 60 * 1000,
      useCount: 5,
      retryAt: Date.now() - 1000,
      standbyAt: Date.now() - 6 * 60 * 1000,
      status: 'waiting_retry',
    },
  ],
};
const setStatusCalls = [];
const logs = [];

async function getState() {
  return currentState;
}
async function setState(patch) {
  currentState = { ...currentState, ...patch };
}
function broadcastDataUpdate() {}
async function addLog(message) {
  logs.push(message);
}
async function heroSmsSetStatus(_config, activationId, status) {
  setStatusCalls.push({ activationId, status });
  return status === 6 ? 'ACCESS_ACTIVATION' : 'ACCESS_CANCEL';
}
async function heroSmsFinishActivation(_config, activationId) {
  return 'ACCESS_ACTIVATION:' + activationId;
}
async function heroSmsCancelActivation(_config, activationId) {
  return 'ACCESS_CANCEL:' + activationId;
}
const HERO_SMS_NUMBER_MAX_USES = 5;
const HERO_SMS_ACTIVATION_TTL_MS = 20 * 60 * 1000;
const HERO_SMS_STANDBY_RETRY_DELAY_MS = 5 * 60 * 1000;
const HERO_SMS_SERVICE_ALIASES = { openai: 'dr', chatgpt: 'dr' };
const DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';

${bundle}

return {
  cleanupExpiredHeroSmsStandbyActivations,
  snapshot() {
    return { currentState, setStatusCalls, logs };
  },
};
`);

  const api = factory();
  const result = await api.cleanupExpiredHeroSmsStandbyActivations();
  const snapshot = api.snapshot();

  assert.equal(result.length, 0);
  assert.equal(snapshot.currentState.heroSmsStandbyActivations.length, 0);
  assert.deepEqual(
    snapshot.setStatusCalls.slice().sort((left, right) => left.activationId - right.activationId),
    [
      { activationId: 901, status: 8 },
      { activationId: 902, status: 6 },
    ]
  );
  assert.equal(snapshot.logs.some((item) => /有效期结束.*自动释放/.test(item)), true);
  assert.equal(snapshot.logs.some((item) => /达到 Max 上限.*自动完成/.test(item)), true);
});

test('getStep8FreshNumberFailureReason treats HeroSMS wait timeout as replaceable number failure', () => {
  const bundle = [
    extractFunction('isPhoneMaxUsageExceededErrorText'),
    extractFunction('isPhoneResendRateLimitedErrorText'),
    extractFunction('isPhoneSmsUnavailableErrorText'),
    extractFunction('getStep8FreshNumberFailureReason'),
  ].join('\n');

  const factory = new Function(`
${bundle}

return { getStep8FreshNumberFailureReason };
`);

  const api = factory();
  const result = api.getStep8FreshNumberFailureReason({
    code: 'hero_sms_wait_code_timeout',
    message: 'HeroSMS 等待短信验证码超时。',
  });

  assert.deepEqual(result, {
    code: 'hero_sms_wait_code_timeout',
    label: '等待 HeroSMS 短信超时',
    recovery: 'history_back',
  });
});

test('shouldTriggerStep8PageResend only clicks page resend once after the first 1-minute timeout', () => {
  const bundle = [
    extractFunction('shouldTriggerStep8PageResend'),
  ].join('\n');

  const factory = new Function(`
${bundle}

return { shouldTriggerStep8PageResend };
`);

  const api = factory();

  assert.equal(api.shouldTriggerStep8PageResend('initial', 1), false);
  assert.equal(api.shouldTriggerStep8PageResend('timeout', 1), true);
  assert.equal(api.shouldTriggerStep8PageResend('timeout', 2), false);
  assert.equal(api.shouldTriggerStep8PageResend('TIMEOUT', 1), true);
});
