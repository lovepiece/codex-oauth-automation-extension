const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/hero-sms.js', 'utf8');

test('handlePhonePageDuringStep8 triggers page resend on first timeout and injects activation utils', async () => {
  const activation = {
    activationId: 101,
    phoneNumber: '66810000001',
    country: '52',
    useCount: 0,
    lastCode: '',
  };

  const runtimeState = {
    heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
    heroSmsApiKey: 'sk-test',
    heroSmsService: 'dr',
    heroSmsCountry: '52',
    currentHeroSmsActivation: activation,
    heroSmsLastCode: '',
    heroSmsRuntimeStatus: '',
    heroSmsActiveActivations: [],
    heroSmsActiveActivationsFetchedAt: 0,
    heroSmsFailedActivations: [],
    heroSmsPendingSuccessActivationId: 0,
  };

  const extensionState = {
    heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
    heroSmsApiKey: 'sk-test',
    heroSmsService: 'dr',
    heroSmsCountry: '52',
    currentHeroSmsActivation: activation,
    heroSmsLastCode: '',
    heroSmsRuntimeStatus: '',
    heroSmsActiveActivations: [],
    heroSmsActiveActivationsFetchedAt: 0,
    heroSmsFailedActivations: [],
    heroSmsPendingSuccessActivationId: 0,
  };

  const events = [];
  const runtime = {
    getState() {
      return runtimeState;
    },
    setState(patch) {
      Object.assign(runtimeState, patch);
    },
    ensureActivationReadyForSubmission: async () => activation,
    getCountrySelection: async () => ({ name: '泰国' }),
    setRuntimeStatus(status) {
      runtimeState.heroSmsRuntimeStatus = status;
      events.push(['runtime-status', status]);
    },
    requestResendForCurrentActivation: async () => {
      events.push(['hero-resend']);
      return { response: 'ACCESS_RETRY_GET' };
    },
    waitForCode: async (_activation, options = {}) => {
      await options.onResend?.({
        attempt: 1,
        reason: 'timeout',
        activation,
      });
      return { code: '123456' };
    },
    getCurrentActivation() {
      return activation;
    },
    moveActivationToFailedList: async () => null,
    moveActivationToStandbyList: async () => null,
    finalizeActivation: async () => ({ released: false }),
    syncActiveActivations: async () => [],
    cleanupFailedActivation: async () => ({ ok: true }),
    getActivationRemainingMs: () => 60_000,
    mergeCurrentActivation(patch = {}) {
      Object.assign(activation, patch);
      return activation;
    },
  };

  const globalScope = {
    MultiPageBackgroundHeroSms: null,
    HeroSmsCore: {
      createHeroSmsRuntime: () => runtime,
      DEFAULT_HERO_SMS_BASE_URL: 'https://hero-sms.com/stubs/handler_api.php',
      HERO_SMS_NUMBER_MAX_USES: 5,
      HERO_SMS_SMS_POLL_INTERVAL_MS: 5000,
      HERO_SMS_SMS_TIMEOUT_MS: 180000,
      HERO_SMS_RESEND_AFTER_MS: 60000,
      HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT: 3,
      HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS: 2 * 60 * 1000,
      normalizeHeroSmsBaseUrl: (value) => String(value || '').trim(),
      normalizeHeroSmsService: (value) => String(value || '').trim().toLowerCase(),
      normalizeHeroSmsCountry: (value) => String(value || '').trim(),
    },
  };

  const api = new Function('self', `${source}; return self.MultiPageBackgroundHeroSms;`)(globalScope);
  const manager = api.createHeroSmsManager({
    addLog: async (message) => {
      events.push(['log', message]);
    },
    broadcastDataUpdate: () => {},
    chrome: {
      runtime: {
        getURL(path) {
          return path;
        },
      },
    },
    ensureContentScriptReadyOnTab: async (_source, _tabId, options = {}) => {
      events.push(['inject', options.inject]);
    },
    getState: async () => extensionState,
    sendTabMessageWithTimeout: async (_tabId, _source, message) => {
      events.push(['message', message.type]);
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        return {
          codeEntryReady: true,
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'RESEND_PHONE_VERIFICATION_CODE') {
        return { resent: true };
      }
      if (message.type === 'FILL_PHONE_VERIFICATION_CODE') {
        return {};
      }
      throw new Error(`Unexpected message: ${message.type}`);
    },
    setState: async (patch) => {
      Object.assign(extensionState, patch);
    },
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await manager.handlePhonePageDuringStep8(99, extensionState);

  assert.equal(result.code, '123456');

  const injectEvent = events.find((entry) => entry[0] === 'inject');
  assert.deepEqual(injectEvent?.[1], [
    'content/activation-utils.js',
    'content/utils.js',
    'content/auth-page-recovery.js',
    'content/signup-page.js',
  ]);

  const pageResendIndex = events.findIndex((entry) => entry[0] === 'message' && entry[1] === 'RESEND_PHONE_VERIFICATION_CODE');
  const heroResendIndex = events.findIndex((entry) => entry[0] === 'hero-resend');
  assert.ok(pageResendIndex >= 0, 'should click page resend after first timeout');
  assert.ok(heroResendIndex > pageResendIndex, 'page resend should happen before HeroSMS resend request');

  assert.ok(
    events.some((entry) => entry[0] === 'log' && /等待满 1 分钟后，已额外点击一次页面上的"重新发送短信"按钮/.test(entry[1])),
    'should log page resend attempt after timeout'
  );
});
