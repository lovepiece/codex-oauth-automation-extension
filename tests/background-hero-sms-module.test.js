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
      return { code: '123456', smsDateTime: '2026-04-26 12:34:56', smsText: 'code 123456' };
    },
    getCurrentActivation() {
      return activation;
    },
    moveActivationToFailedList: async () => null,
    moveActivationToStandbyList: async () => null,
    finalizeActivation: async () => ({ released: false }),
    syncActiveActivations: async () => [activation],
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
  assert.equal(result.smsDateTime, '2026-04-26 12:34:56');
  assert.equal(result.smsText, 'code 123456');

  const injectEvent = events.find((entry) => entry[0] === 'inject');
  assert.deepEqual(injectEvent?.[1], [
    'content/activation-utils.js',
    'content/utils.js',
    'content/auth-page-recovery.js',
    'content/signup-page.js',
  ]);

  const pageResendIndex = events.findIndex((entry) => entry[0] === 'message' && entry[1] === 'RESEND_PHONE_VERIFICATION_CODE');
  const heroResendIndexes = events
    .map((entry, index) => [entry, index])
    .filter(([entry]) => entry[0] === 'hero-resend')
    .map(([, index]) => index);
  assert.ok(pageResendIndex >= 0, 'should click page resend after first timeout');
  assert.ok(heroResendIndexes.some((index) => index < pageResendIndex), 'should request HeroSMS status=3 before receiving SMS');
  assert.ok(heroResendIndexes.some((index) => index > pageResendIndex), 'page resend should request HeroSMS status=3 again');

  assert.ok(
    events.some((entry) => entry[0] === 'log' && /等待满 1 分钟后额外重发短信，已点击页面上的"重新发送短信"按钮/.test(entry[1])),
    'should log page resend attempt after timeout'
  );
});

test('hero sms phone verification only clicks page resend after 1 minute timeout', () => {
  assert.doesNotMatch(source, /HERO_SMS_INITIAL_PAGE_RESEND_AFTER_MS/);
  assert.doesNotMatch(source, /接收短信页面等待 15 秒后仍未收到短信/);
  assert.match(source, /clickPhonePageResendOnce\(tabId, '等待满 1 分钟后额外重发短信'\)/);
  assert.match(source, /shouldTriggerPageResend\(reason, resendAttempt\)/);
  assert.match(
    source,
    /resendPageResult\?\.resent[\s\S]*sleepWithStop\(HERO_SMS_INITIAL_RESEND_DELAY_MS\);[\s\S]*requestFreshSmsBeforeReceive\(`\$\{logPrefix\}后`\)/
  );
  assert.doesNotMatch(source, /initialPageResend/);
});

test('hero sms timeout requests step 7 restart after old number cleanup', () => {
  assert.match(source, /reason === 'hero_sms_wait_code_timeout'/);
  assert.match(source, /hero_sms_timeout_restart_step7/);
  assert.match(source, /等待手机短信超过 3 分钟仍未收到验证码/);
});

test('hero sms waits 5 seconds before requesting fresh sms and counts phone verification success', () => {
  assert.match(source, /HERO_SMS_INITIAL_RESEND_DELAY_MS = 5000/);
  assert.match(
    source,
    /sleepWithStop\(HERO_SMS_INITIAL_RESEND_DELAY_MS\);[\s\S]*requestFreshSmsBeforeReceive\('接收短信前'\)/
  );
  assert.match(source, /requestFreshSmsBeforeReceive\('接收短信前'\)/);
  assert.match(source, /rejectedSmsCodes/);
  assert.match(source, /recordSuccessfulPhoneVerification\(activation\.activationId\)/);
  assert.match(source, /已累计成功验证手机/);
  assert.match(source, /nextUseCount >= HERO_SMS_NUMBER_MAX_USES/);
});

test('hero sms only completes activation for phone max usage after submit continue', () => {
  assert.match(source, /submitError\.afterPhoneSubmit = true/);
  assert.match(source, /pageError\.afterPhoneSubmit = true/);
  assert.match(source, /reason === 'phone_max_usage_exceeded' && error\?\.afterPhoneSubmit/);
  assert.match(source, /phone_max_usage_exceeded_without_submit_continue/);
});

test('finalizeAfterSuccessfulFlow does not increment HeroSMS use count again', () => {
  const finalizeBody = source.match(/async function finalizeAfterSuccessfulFlow\(\) \{([\s\S]*?)\n    async function onAlarm/);
  assert.ok(finalizeBody, 'should locate finalizeAfterSuccessfulFlow body');
  assert.doesNotMatch(finalizeBody[1], /useCount \+ 1/);
  assert.match(finalizeBody[1], /currentUseCount/);
  assert.match(source, /recordSuccessfulPhoneVerification\(activation\.activationId\)/);
});

test('HeroSMS failed phone numbers wait before cancel and move 409 conflicts to standby', () => {
  assert.match(source, /HERO_SMS_CANCEL_REFUND_DELAY_MS = 2 \* 60 \* 1000/);
  assert.match(source, /sleepWithStop\(HERO_SMS_CANCEL_REFUND_DELAY_MS\);[\s\S]*runtime\.heroSmsSetStatus\(activation\.activationId, 8\)/);
  assert.match(source, /ACCESS_CANCEL/);
  assert.match(source, /EARLY_CANCEL_DENIED\|OTP_RECEIVED\|HTTP\\s\*409/);
  assert.match(source, /moveActivationToStandbyList\(activation, reason/);
});

test('handlePhonePageDuringStep8 requests a distinct sms after invalid code without resubmitting phone', async () => {
  const activation = {
    activationId: 401,
    phoneNumber: '66810000002',
    country: '52',
    useCount: 0,
    lastCode: '',
  };
  const state = {
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
  const waitCalls = [];
  let waitCount = 0;
  let fillCount = 0;
  const runtime = {
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    ensureActivationReadyForSubmission: async () => activation,
    getCountrySelection: async () => ({ name: '泰国' }),
    setRuntimeStatus: (status) => events.push(['runtime-status', status]),
    requestResendForCurrentActivation: async () => {
      events.push(['hero-resend']);
      return { response: 'ACCESS_RETRY_GET' };
    },
    waitForCode: async (_activation, options = {}) => {
      waitCount += 1;
      waitCalls.push({
        excludeCodes: options.excludeCodes,
        requestFreshCodeOnStart: options.requestFreshCodeOnStart,
        markReady: options.markReady,
        requireFreshCodeByDateTime: options.requireFreshCodeByDateTime,
        freshSmsAfterDateTime: options.freshSmsAfterDateTime,
        freshCallAfterDateTime: options.freshCallAfterDateTime,
      });
      if (options.requestFreshCodeOnStart) {
        await options.onResend?.({
          attempt: 1,
          reason: 'initial',
          activation,
        });
      }
      return { code: waitCount === 1 ? '111111' : '222222' };
    },
    getCurrentActivation: () => activation,
    moveActivationToFailedList: async () => null,
    moveActivationToStandbyList: async () => null,
    finalizeActivation: async () => ({ released: false }),
    syncActiveActivations: async () => [activation],
    cleanupFailedActivation: async () => ({ ok: true }),
    getActivationRemainingMs: () => 60_000,
    mergeCurrentActivation: (patch = {}) => {
      Object.assign(activation, patch);
      return activation;
    },
  };
  const api = new Function('self', `${source}; return self.MultiPageBackgroundHeroSms;`)( {
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
  });
  const manager = api.createHeroSmsManager({
    addLog: async (message) => events.push(['log', message]),
    broadcastDataUpdate: () => {},
    chrome: { runtime: { getURL: (path) => path } },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => state,
    sendTabMessageWithTimeout: async (_tabId, _source, message) => {
      events.push(['message', message.type, message.payload?.code || '']);
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        return {
          codeEntryReady: true,
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'GET_PHONE_VERIFICATION_STATE') {
        return {
          addPhonePage: true,
          phoneVerificationPage: true,
          hasCodeTarget: true,
          errorText: '',
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'FILL_PHONE_VERIFICATION_CODE') {
        fillCount += 1;
        return fillCount === 1
          ? { invalidCode: true, errorText: '验证码错误' }
          : { success: true };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    },
    setState: async (patch) => Object.assign(state, patch),
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await manager.handlePhonePageDuringStep8(99, state);

  assert.equal(result.code, '222222');
  assert.equal(waitCalls.length, 2);
  assert.deepEqual(waitCalls[1], {
    excludeCodes: [],
    requestFreshCodeOnStart: true,
    markReady: false,
    requireFreshCodeByDateTime: true,
    freshSmsAfterDateTime: '',
    freshCallAfterDateTime: '',
  });
  assert.equal(
    events.filter((entry) => entry[0] === 'message' && entry[1] === 'SUBMIT_PHONE_NUMBER').length,
    1,
    'should keep the same submitted phone number after an invalid sms code'
  );
  assert.equal(
    events.filter((entry) => entry[0] === 'hero-resend').length,
    2,
    'should request status=3 before receive and again after the invalid code'
  );
  assert.deepEqual(
    events
      .filter((entry) => entry[0] === 'message' && entry[1] === 'FILL_PHONE_VERIFICATION_CODE')
      .map((entry) => entry[2]),
    ['111111', '222222']
  );
});

test('HeroSMS invalid sms code retries until a distinct code is received', () => {
  assert.match(source, /rejectedSmsCodes\.has\(receivedCode\)/);
  assert.match(source, /与上一次被拒绝的验证码相同/);
  assert.match(source, /continue;/);
  assert.match(source, /duplicateError\.invalidCode = true/);
});

test('auto-run reset preserves current HeroSMS activation for next run', () => {
  const autoRunSource = fs.readFileSync('background/auto-run-controller.js', 'utf8');
  assert.match(autoRunSource, /currentHeroSmsActivation: prevState\.currentHeroSmsActivation \|\| null/);
  assert.match(autoRunSource, /heroSmsLastCode: prevState\.heroSmsLastCode \|\| ''/);
  assert.match(autoRunSource, /heroSmsStandbyActivations: Array\.isArray\(prevState\.heroSmsStandbyActivations\)/);
  assert.match(autoRunSource, /heroSmsPendingSuccessActivationId: Number\(prevState\.heroSmsPendingSuccessActivationId\) \|\| 0/);
});

test('handlePhonePageDuringStep8 checks active activation before submitting phone number', async () => {
  const activation = {
    activationId: 202,
    phoneNumber: '237686822243',
    country: '37',
    useCount: 0,
    lastCode: '',
  };
  const state = {
    heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
    heroSmsApiKey: 'sk-test',
    heroSmsService: 'dr',
    heroSmsCountry: '37',
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
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    ensureActivationReadyForSubmission: async () => activation,
    getCountrySelection: async () => ({ name: '喀麦隆' }),
    setRuntimeStatus: (status) => events.push(['runtime-status', status]),
    syncActiveActivations: async () => [],
  };
  const api = new Function('self', `${source}; return self.MultiPageBackgroundHeroSms;`)({
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
  });
  const manager = api.createHeroSmsManager({
    addLog: async (message) => events.push(['log', message]),
    broadcastDataUpdate: () => {},
    chrome: { runtime: { getURL: (path) => path } },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => state,
    sendTabMessageWithTimeout: async (_tabId, _source, message) => {
      events.push(['message', message.type]);
      return {};
    },
    setState: async (patch) => Object.assign(state, patch),
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  await assert.rejects(
    () => manager.handlePhonePageDuringStep8(99, state),
    /已不在 active activations 列表中/
  );
  assert.equal(
    events.some((entry) => entry[0] === 'message' && entry[1] === 'SUBMIT_PHONE_NUMBER'),
    false,
    'should not submit phone number when HeroSMS active activation is missing'
  );
});

test('handlePhonePageDuringStep8 moves number to standby when phone page rate limits resend', async () => {
  const firstActivation = {
    activationId: 301,
    phoneNumber: '237686822243',
    country: '37',
    useCount: 0,
    lastCode: '',
  };
  const secondActivation = {
    activationId: 302,
    phoneNumber: '237686822244',
    country: '37',
    useCount: 0,
    lastCode: '',
  };
  const state = {
    heroSmsBaseUrl: 'https://hero-sms.com/stubs/handler_api.php',
    heroSmsApiKey: 'sk-test',
    heroSmsService: 'dr',
    heroSmsCountry: '37',
    currentHeroSmsActivation: firstActivation,
    heroSmsLastCode: '',
    heroSmsRuntimeStatus: '',
    heroSmsActiveActivations: [],
    heroSmsActiveActivationsFetchedAt: 0,
    heroSmsFailedActivations: [],
    heroSmsPendingSuccessActivationId: 0,
  };
  const events = [];
  let activationIndex = 0;
  const runtime = {
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    ensureActivationReadyForSubmission: async () => {
      const activation = activationIndex === 0 ? firstActivation : secondActivation;
      state.currentHeroSmsActivation = activation;
      return activation;
    },
    getCountrySelection: async () => ({ name: '喀麦隆' }),
    setRuntimeStatus: (status) => events.push(['runtime-status', status]),
    requestResendForCurrentActivation: async () => {
      events.push(['hero-resend', activationIndex]);
      return { response: 'ACCESS_RETRY_GET' };
    },
    syncActiveActivations: async () => [activationIndex === 0 ? firstActivation : secondActivation],
    heroSmsSetStatus: async () => {
      const error = new Error('EARLY_CANCEL_DENIED: Activation cannot be cancelled at this time.');
      error.status = 409;
      error.responseText = JSON.stringify({
        title: 'EARLY_CANCEL_DENIED',
        details: 'Activation cannot be cancelled at this time. Minimum activation period must pass.',
      });
      throw error;
    },
    finalizeActivation: async () => ({ released: false, error: 'HeroSMS setStatus=8 failed' }),
    moveActivationToStandbyList: async (activation, reason, errorText) => {
      events.push(['standby', activation.activationId, reason, errorText]);
      activationIndex += 1;
      return { activationId: activation.activationId };
    },
    waitForCode: async () => ({ code: '654321' }),
    getCurrentActivation: () => state.currentHeroSmsActivation,
    getActivationRemainingMs: () => 60_000,
    mergeCurrentActivation: (patch = {}) => {
      Object.assign(state.currentHeroSmsActivation, patch);
      return state.currentHeroSmsActivation;
    },
  };
  const api = new Function('self', `${source}; return self.MultiPageBackgroundHeroSms;`)({
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
  });
  const manager = api.createHeroSmsManager({
    addLog: async (message) => events.push(['log', message]),
    broadcastDataUpdate: () => {},
    chrome: { runtime: { getURL: (path) => path } },
    ensureContentScriptReadyOnTab: async () => {},
    getState: async () => state,
    sendTabMessageWithTimeout: async (_tabId, _source, message) => {
      events.push(['message', message.type, activationIndex]);
      if (message.type === 'SUBMIT_PHONE_NUMBER') {
        return {
          codeEntryReady: true,
          phoneVerificationPage: true,
          url: 'https://auth.openai.com/phone-verification',
        };
      }
      if (message.type === 'GET_PHONE_VERIFICATION_STATE') {
        return activationIndex === 0
          ? {
            addPhonePage: true,
            phoneVerificationPage: true,
            hasCodeTarget: true,
            errorText: '尝试重新发送的次数过多。请稍后重试。',
            url: 'https://auth.openai.com/phone-verification',
          }
          : {
            addPhonePage: true,
            phoneVerificationPage: true,
            hasCodeTarget: true,
            errorText: '',
            url: 'https://auth.openai.com/phone-verification',
          };
      }
      if (message.type === 'FILL_PHONE_VERIFICATION_CODE') {
        return { success: true };
      }
      throw new Error(`Unexpected message: ${message.type}`);
    },
    setState: async (patch) => Object.assign(state, patch),
    sleepWithStop: async () => {},
    throwIfStopped: () => {},
  });

  const result = await manager.handlePhonePageDuringStep8(99, state);

  assert.equal(result.activationId, secondActivation.activationId);
  assert.deepEqual(events.find((entry) => entry[0] === 'standby')?.slice(1, 3), [
    firstActivation.activationId,
    'phone_resend_rate_limited',
  ]);
  assert.equal(
    events.filter((entry) => entry[0] === 'message' && entry[1] === 'SUBMIT_PHONE_NUMBER').length,
    2,
    'should retry with a new number after rate limit error'
  );
});
