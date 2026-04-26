const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHeroSmsRuntime,
  extractHeroSmsDeliveredCode,
  parseHeroSmsStatusResponse,
} = require('../hero-sms-core.js');

test('parseHeroSmsStatusResponse reads sms dateTime from structured status payload', () => {
  const parsed = parseHeroSmsStatusResponse({
    verificationType: 2,
    sms: {
      dateTime: '2026-04-26 12:34:56',
      code: '123456',
      text: 'Your verification code is 123456',
    },
    call: {
      from: '15550000000',
      text: 'voice text',
      code: '654321',
      dateTime: '2026-04-26 12:35:00',
      url: 'https://example.test/voice.mp3',
      parsingCount: 1,
    },
  });

  assert.equal(parsed.status, 'STATUS_OK');
  assert.equal(parsed.code, '123456');
  assert.equal(parsed.smsCode, '123456');
  assert.equal(parsed.smsText, 'Your verification code is 123456');
  assert.equal(parsed.smsDateTime, '2026-04-26 12:34:56');
  assert.equal(parsed.callDateTime, '2026-04-26 12:35:00');
  assert.equal(extractHeroSmsDeliveredCode(parsed), '123456');
});

test('parseHeroSmsStatusResponse keeps legacy text status support', () => {
  const parsed = parseHeroSmsStatusResponse('STATUS_OK:654321');

  assert.equal(parsed.status, 'STATUS_OK');
  assert.equal(parsed.code, '654321');
  assert.equal(parsed.raw, 'STATUS_OK:654321');
  assert.equal(extractHeroSmsDeliveredCode(parsed), '654321');
});

test('waitForCode returns sms dateTime from structured getStatus response', async () => {
  const activation = {
    activationId: 101,
    phoneNumber: '15550000000',
    service: 'dr',
    country: '187',
    acquiredAt: 1000,
    expiresAt: 60_000,
  };
  const structuredStatus = {
    verificationType: 2,
    sms: {
      dateTime: '2026-04-26 12:34:56',
      code: '112233',
      text: 'OpenAI code: 112233',
    },
    call: {
      from: '',
      text: '',
      code: '',
      dateTime: '0000-00-00 00:00:00',
      url: '',
      parsingCount: 0,
    },
  };
  const runtime = createHeroSmsRuntime({
    initialState: {
      heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
      heroSmsApiKey: 'sk-test',
      heroSmsService: 'dr',
      heroSmsCountry: '187',
      currentHeroSmsActivation: activation,
    },
    now: () => 1000,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      const action = new URL(url).searchParams.get('action');
      return {
        ok: true,
        text: async () => {
          if (action === 'setStatus') return 'ACCESS_READY';
          if (action === 'getStatusV2') return JSON.stringify(structuredStatus);
          throw new Error(`unexpected action: ${action}`);
        },
      };
    },
  });

  const result = await runtime.waitForCode(activation, { timeoutMs: 5000 });

  assert.equal(result.code, '112233');
  assert.equal(result.smsText, 'OpenAI code: 112233');
  assert.equal(result.smsDateTime, '2026-04-26 12:34:56');
  assert.equal(result.callDateTime, '');
});

test('heroSmsGetNumber sends configured maxPrice to getNumberV2', async () => {
  let requestedUrl = '';
  const runtime = createHeroSmsRuntime({
    initialState: {
      heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
      heroSmsApiKey: 'sk-test',
      heroSmsService: 'dr',
      heroSmsCountry: '187',
      heroSmsMaxPrice: '0.5',
    },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        text: async () => JSON.stringify({
          status: 'success',
          data: {
            activationId: 123,
            phoneNumber: '15550000000',
          },
        }),
      };
    },
  });

  const result = await runtime.heroSmsGetNumber();
  const params = new URL(requestedUrl).searchParams;

  assert.equal(result.activationId, 123);
  assert.equal(params.get('action'), 'getNumberV2');
  assert.equal(params.get('service'), 'dr');
  assert.equal(params.get('country'), '187');
  assert.equal(params.get('maxPrice'), '0.5');
});

test('finalizeActivation only uses status 6 for max uses or phone max usage exceeded', async () => {
  const requestedStatuses = [];
  const createRuntime = (activation) => createHeroSmsRuntime({
    initialState: {
      heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
      heroSmsApiKey: 'sk-test',
      heroSmsService: 'dr',
      heroSmsCountry: '187',
      currentHeroSmsActivation: activation,
    },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const action = parsed.searchParams.get('action');
      if (action === 'setStatus') {
        requestedStatuses.push(Number(parsed.searchParams.get('status')));
        return {
          ok: true,
          text: async () => Number(parsed.searchParams.get('status')) === 6 ? 'ACCESS_ACTIVATION' : 'ACCESS_CANCEL',
        };
      }
      throw new Error(`unexpected action: ${action}`);
    },
  });

  await createRuntime({
    activationId: 301,
    phoneNumber: '15550000001',
    service: 'dr',
    country: '187',
    useCount: 0,
  }).finalizeActivation(undefined, { preferComplete: true, releaseReason: 'manual_release' });

  await createRuntime({
    activationId: 302,
    phoneNumber: '15550000002',
    service: 'dr',
    country: '187',
    useCount: 5,
  }).finalizeActivation(undefined, { releaseReason: 'max_uses_reached' });

  await createRuntime({
    activationId: 303,
    phoneNumber: '15550000003',
    service: 'dr',
    country: '187',
    useCount: 0,
  }).finalizeActivation(undefined, { preferComplete: true, releaseReason: 'phone_max_usage_exceeded' });

  assert.deepEqual(requestedStatuses, [8, 6, 6]);
});

test('cleanupFailedActivation does not fall back to status 6 when cancel fails', async () => {
  const calls = [];
  const runtime = createHeroSmsRuntime({
    initialState: {
      heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
      heroSmsApiKey: 'sk-test',
      heroSmsService: 'dr',
      heroSmsCountry: '187',
      heroSmsFailedActivations: [{
        activationId: 401,
        phoneNumber: '15550000004',
        service: 'dr',
        country: '187',
        useCount: 0,
        reason: 'hero_sms_wait_code_timeout',
        failedAt: 1000,
        cleanupAt: 1000,
      }],
    },
    now: () => 2000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push({
        action: parsed.searchParams.get('action'),
        status: parsed.searchParams.get('status'),
      });
      return {
        ok: false,
        text: async () => 'release failed',
      };
    },
  });

  const result = await runtime.cleanupFailedActivation(401);

  assert.equal(result.status, 'cleanup_failed');
  assert.deepEqual(calls, [
    { action: 'setStatus', status: '8' },
    { action: 'cancelActivation', status: null },
  ]);
});
