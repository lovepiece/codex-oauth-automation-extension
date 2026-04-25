(function attachBackgroundHeroSms(root, factory) {
  root.MultiPageBackgroundHeroSms = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundHeroSmsModule() {
  const HeroSmsCore = self.HeroSmsCore || {};
  const {
    createHeroSmsRuntime,
    DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php',
    HERO_SMS_NUMBER_MAX_USES = 5,
    HERO_SMS_SMS_POLL_INTERVAL_MS = 5000,
    HERO_SMS_SMS_TIMEOUT_MS = 180000,
    HERO_SMS_RESEND_AFTER_MS = 60000,
    HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT = 3,
    HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS = 2 * 60 * 1000,
    normalizeHeroSmsBaseUrl = (value) => String(value || '').trim(),
    normalizeHeroSmsService = (value) => String(value || '').trim().toLowerCase(),
    normalizeHeroSmsCountry = (value) => String(value || '').trim(),
  } = HeroSmsCore;

  const HERO_SMS_FAILED_ACTIVATION_ALARM_PREFIX = 'hero-sms-failed-cleanup:';

  function createHeroSmsManager(deps = {}) {
    const {
      addLog,
      broadcastDataUpdate,
      chrome,
      ensureContentScriptReadyOnTab,
      getState,
      sendTabMessageWithTimeout,
      setState,
      SIGNUP_PAGE_INJECT_FILES = ['content/activation-utils.js', 'content/utils.js', 'content/auth-page-recovery.js', 'content/signup-page.js'],
      sleepWithStop,
      throwIfStopped,
    } = deps;

    if (typeof createHeroSmsRuntime !== 'function') {
      throw new Error('HeroSmsCore 未加载，无法初始化 HeroSMS 管理器。');
    }

    let syncQueued = false;
    const runtime = createHeroSmsRuntime({
      fetchImpl: typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      sleepImpl: typeof sleepWithStop === 'function'
        ? (ms) => sleepWithStop(ms)
        : ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      onLog(entry) {
        Promise.resolve(addLog?.(`HeroSMS：${entry.message}`, entry.level === 'error' ? 'error' : (entry.level === 'warn' ? 'warn' : 'info'))).catch(() => {});
      },
      onStateChange() {
        queueRuntimeSync();
      },
      onStatusChange() {
        queueRuntimeSync();
      },
      countryCatalogUrl: chrome?.runtime?.getURL?.('data/SMS-Country.json') || 'data/SMS-Country.json',
    });

    function buildAlarmName(activationId) {
      return `${HERO_SMS_FAILED_ACTIVATION_ALARM_PREFIX}${activationId}`;
    }

    function extractStatePatch() {
      const state = runtime.getState();
      return {
        heroSmsBaseUrl: state.heroSmsBaseUrl || DEFAULT_HERO_SMS_BASE_URL,
        heroSmsApiKey: state.heroSmsApiKey || '',
        heroSmsService: state.heroSmsService || '',
        heroSmsCountry: state.heroSmsCountry || '',
        currentHeroSmsActivation: state.currentHeroSmsActivation || null,
        heroSmsLastCode: state.heroSmsLastCode || '',
        heroSmsRuntimeStatus: state.heroSmsRuntimeStatus || '',
        heroSmsActiveActivations: Array.isArray(state.heroSmsActiveActivations) ? state.heroSmsActiveActivations : [],
        heroSmsActiveActivationsFetchedAt: Number(state.heroSmsActiveActivationsFetchedAt) || 0,
        heroSmsFailedActivations: Array.isArray(state.heroSmsFailedActivations) ? state.heroSmsFailedActivations : [],
        heroSmsPendingSuccessActivationId: Number(state.heroSmsPendingSuccessActivationId) || 0,
      };
    }

    async function syncRuntimeToExtension() {
      const patch = extractStatePatch();
      await setState(patch);
      broadcastDataUpdate?.(patch);
    }

    function queueRuntimeSync() {
      if (syncQueued) {
        return;
      }
      syncQueued = true;
      Promise.resolve().then(async () => {
        syncQueued = false;
        await syncRuntimeToExtension();
      }).catch(() => {
        syncQueued = false;
      });
    }

    async function syncRuntimeFromExtension(stateOverride = null) {
      const state = stateOverride || await getState();
      runtime.setState({
        heroSmsBaseUrl: normalizeHeroSmsBaseUrl(state.heroSmsBaseUrl),
        heroSmsApiKey: String(state.heroSmsApiKey || '').trim(),
        heroSmsService: normalizeHeroSmsService(state.heroSmsService),
        heroSmsCountry: normalizeHeroSmsCountry(state.heroSmsCountry),
        currentHeroSmsActivation: state.currentHeroSmsActivation || null,
        heroSmsLastCode: state.heroSmsLastCode || '',
        heroSmsRuntimeStatus: state.heroSmsRuntimeStatus || '',
        heroSmsActiveActivations: Array.isArray(state.heroSmsActiveActivations) ? state.heroSmsActiveActivations : [],
        heroSmsActiveActivationsFetchedAt: Number(state.heroSmsActiveActivationsFetchedAt) || 0,
        heroSmsFailedActivations: Array.isArray(state.heroSmsFailedActivations) ? state.heroSmsFailedActivations : [],
        heroSmsPendingSuccessActivationId: Number(state.heroSmsPendingSuccessActivationId) || 0,
      });
      return runtime.getState();
    }

    async function ensureSignupPageReady(tabId, timeoutMs = 15000, logMessage = '') {
      return ensureContentScriptReadyOnTab('signup-page', tabId, {
        inject: SIGNUP_PAGE_INJECT_FILES,
        injectSource: 'signup-page',
        timeoutMs,
        retryDelayMs: 600,
        logMessage,
      });
    }

    async function sendSignupPageCommand(tabId, type, payload = {}, options = {}) {
      await ensureSignupPageReady(
        tabId,
        options.timeoutMs || 15000,
        options.logMessage || 'HeroSMS：正在等待手机号页面内容脚本重新就绪...'
      );
      const result = await sendTabMessageWithTimeout(tabId, 'signup-page', {
        type,
        source: 'background',
        payload,
      }, options.responseTimeoutMs || options.timeoutMs || 15000);
      if (result?.error) {
        throw new Error(result.error);
      }
      return result || {};
    }

    function isPhoneMaxUsageExceededErrorText(text = '') {
      return /phone_max_usage_exceeded/i.test(String(text || '').trim());
    }

    function isPhoneResendRateLimitedErrorText(text = '') {
      return /尝试重新发送的次数过多。?\s*请稍后重试。?|too\s+many\s+(?:times\s+to\s+)?resend|too\s+many\s+resend\s+attempts?/i.test(String(text || '').trim());
    }

    function isPhoneSmsUnavailableErrorText(text = '') {
      return /无法向此电话号码发送短信|unable\s+to\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number|cannot\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number/i.test(String(text || '').trim());
    }

    function shouldRetryWithFreshNumber(error) {
      const message = String(error?.errorText || error?.message || error || '').trim();
      return error?.code === 'hero_sms_wait_code_timeout'
        || isPhoneMaxUsageExceededErrorText(message)
        || isPhoneResendRateLimitedErrorText(message)
        || isPhoneSmsUnavailableErrorText(message);
    }

    function resolveFailureReason(error) {
      const message = String(error?.errorText || error?.message || error || '').trim();
      if (error?.code === 'hero_sms_wait_code_timeout') {
        return 'hero_sms_wait_code_timeout';
      }
      if (isPhoneMaxUsageExceededErrorText(message)) {
        return 'phone_max_usage_exceeded';
      }
      if (isPhoneResendRateLimitedErrorText(message)) {
        return 'phone_resend_rate_limited';
      }
      if (isPhoneSmsUnavailableErrorText(message)) {
        return 'phone_sms_unavailable';
      }
      if (error?.invalidCode) {
        return 'phone_verification_invalid_code';
      }
      return 'phone_verification_failed';
    }

    function getFailureLabel(reason) {
      const labels = {
        hero_sms_wait_code_timeout: '等待 HeroSMS 短信超时',
        phone_max_usage_exceeded: 'phone_max_usage_exceeded',
        phone_resend_rate_limited: '页面提示重发短信次数过多',
        phone_sms_unavailable: '页面提示当前号码无法接收短信',
        phone_verification_invalid_code: '验证码被页面拒绝',
      };
      return labels[reason] || '当前号码不可继续使用';
    }

    function resolveRecoveryAction(reason) {
      if (reason === 'phone_max_usage_exceeded') return 'retry_button';
      if (reason === 'phone_resend_rate_limited'
        || reason === 'hero_sms_wait_code_timeout'
        || reason === 'phone_sms_unavailable') return 'history_back';
      return null;
    }

    function shouldTriggerPageResend(reason = '', attempt = 0) {
      return String(reason || '').trim().toLowerCase() === 'timeout'
        && Number(attempt) === 1;
    }

    async function clickPhonePageResendOnce(tabId, logPrefix) {
      await throwIfPhoneVerificationPageRequiresFreshNumber(tabId, `${logPrefix}前`);
      const resendPageResult = await resendPhoneVerificationCode(tabId);
      let heroSmsResendRequested = false;
      if (resendPageResult?.errorText) {
        const pageResendError = new Error(resendPageResult.errorText);
        pageResendError.errorText = resendPageResult.errorText;
        if (shouldRetryWithFreshNumber(pageResendError)) {
          throw pageResendError;
        }
        await addLog?.(`步骤 9：${logPrefix}提示错误（${resendPageResult.errorText}），继续等待验证码...`, 'warn');
      } else if (resendPageResult?.resent) {
        await addLog?.(`步骤 9：${logPrefix}，已点击页面上的"重新发送短信"按钮。`, 'warn');
        await requestFreshSmsBeforeReceive(`${logPrefix}后`);
        heroSmsResendRequested = true;
      } else {
        await addLog?.(`步骤 9：${logPrefix}，但当前页面重发按钮暂不可用。`, 'warn');
      }
      if (resendPageResult && typeof resendPageResult === 'object') {
        resendPageResult.heroSmsResendRequested = heroSmsResendRequested;
      }
      return resendPageResult;
    }

    async function ensureFailedActivationCleanupAlarm(entry) {
      if (!chrome?.alarms || !entry?.activationId || !entry?.cleanupAt) {
        return;
      }
      const when = Number(entry.cleanupAt);
      if (!Number.isFinite(when) || when <= Date.now()) {
        return;
      }
      await chrome.alarms.clear(buildAlarmName(entry.activationId));
      await chrome.alarms.create(buildAlarmName(entry.activationId), { when });
    }

    async function clearFailedActivationCleanupAlarm(activationId) {
      if (!chrome?.alarms) {
        return;
      }
      await chrome.alarms.clear(buildAlarmName(activationId));
    }

    async function moveActivationToFailedList(activation, reason, errorText = '') {
      await syncRuntimeFromExtension();
      const entry = await runtime.moveActivationToFailedList(activation, reason, errorText);
      if (entry) {
        await syncRuntimeToExtension();
        await ensureFailedActivationCleanupAlarm(entry);
      }
      return entry;
    }

    async function moveActivationToStandbyList(activation, reason, errorText = '') {
      await syncRuntimeFromExtension();
      const entry = await runtime.moveActivationToStandbyList(activation, reason, errorText);
      if (entry) {
        await syncRuntimeToExtension();
      }
      return entry;
    }

    async function finalizeActivation(options = {}) {
      await syncRuntimeFromExtension();
      const result = await runtime.finalizeActivation(undefined, options);
      await syncRuntimeToExtension();
      return result;
    }

    async function syncActiveActivations(options = {}) {
      await syncRuntimeFromExtension();
      const activations = await runtime.syncActiveActivations(undefined, options);
      await syncRuntimeToExtension();
      return activations;
    }

    async function ensureCurrentActivationExistsBeforeSubmit(activation) {
      if (!activation?.activationId || !activation?.phoneNumber) {
        throw new Error('HeroSMS 当前号码记录不完整，无法提交手机号。');
      }

      const activeList = await syncActiveActivations({ fetchedAt: Date.now() });
      const currentPhoneDigits = String(activation.phoneNumber || '').replace(/\D/g, '');
      const found = (Array.isArray(activeList) ? activeList : []).some((item) => {
        const itemId = Number(item?.activationId) || 0;
        const itemPhoneDigits = String(item?.phoneNumber || '').replace(/\D/g, '');
        return itemId === Number(activation.activationId)
          || (currentPhoneDigits && itemPhoneDigits === currentPhoneDigits);
      });

      if (!found) {
        throw new Error(`HeroSMS 当前号码 ${activation.phoneNumber}（ID ${activation.activationId}）已不在 active activations 列表中，停止填写手机号。`);
      }

      return true;
    }

    async function requestResendForCurrentActivation(options = {}) {
      await syncRuntimeFromExtension();
      const result = await runtime.requestResendForCurrentActivation(options);
      await syncRuntimeToExtension();
      return result;
    }

    async function requestFreshSmsBeforeReceive(reasonLabel = '接收短信前') {
      await addLog?.(`步骤 9：${reasonLabel}，正在通过 HeroSMS API 请求新的手机验证码（status=3）...`, 'warn');
      return requestResendForCurrentActivation({ silent: false });
    }

    async function recordSuccessfulPhoneVerification(activationId) {
      await syncRuntimeFromExtension();
      const currentActivation = runtime.getCurrentActivation();
      if (!currentActivation || Number(currentActivation.activationId) !== Number(activationId)) {
        await setState({ heroSmsPendingSuccessActivationId: 0 });
        broadcastDataUpdate?.({ heroSmsPendingSuccessActivationId: 0 });
        return { ok: true, skipped: true };
      }

      const nextUseCount = currentActivation.useCount + 1;
      runtime.mergeCurrentActivation({ useCount: nextUseCount });
      await syncRuntimeToExtension();

      const updatedActivation = runtime.getCurrentActivation();
      const expired = runtime.getActivationRemainingMs(updatedActivation) <= 0;

      await setState({ heroSmsPendingSuccessActivationId: 0 });
      broadcastDataUpdate?.({ heroSmsPendingSuccessActivationId: 0 });

      if (nextUseCount >= HERO_SMS_NUMBER_MAX_USES || expired) {
        await addLog?.(
          `HeroSMS：号码 ${updatedActivation.phoneNumber} 已成功验证手机 ${nextUseCount}/${HERO_SMS_NUMBER_MAX_USES} 次，准备${nextUseCount >= HERO_SMS_NUMBER_MAX_USES ? '完成激活' : '释放号码'}。`,
          'ok'
        );
        return finalizeActivation({
          preferComplete: nextUseCount >= HERO_SMS_NUMBER_MAX_USES,
          releaseReason: nextUseCount >= HERO_SMS_NUMBER_MAX_USES ? 'max_phone_verifications_reached' : 'expired_after_phone_verification',
          silent: false,
        });
      }

      await addLog?.(
        `HeroSMS：号码 ${updatedActivation.phoneNumber} 已累计成功验证手机 ${nextUseCount}/${HERO_SMS_NUMBER_MAX_USES} 次，剩余 ${HERO_SMS_NUMBER_MAX_USES - nextUseCount} 次可复用。`,
        'ok'
      );
      return { ok: true, released: false, useCount: nextUseCount };
    }

    async function cleanupFailedActivation(activationId) {
      await syncRuntimeFromExtension();
      const result = await runtime.cleanupFailedActivation(activationId);
      await syncRuntimeToExtension();
      await clearFailedActivationCleanupAlarm(activationId);
      return result;
    }

    async function reconcileFailedActivationCleanupAlarms() {
      const state = await getState();
      const failedList = Array.isArray(state.heroSmsFailedActivations) ? state.heroSmsFailedActivations : [];
      for (const item of failedList) {
        if (item?.cleanupCompletedAt) {
          await clearFailedActivationCleanupAlarm(item.activationId);
          continue;
        }
        if (Number(item?.cleanupAt) > Date.now()) {
          await ensureFailedActivationCleanupAlarm(item);
          continue;
        }
        await cleanupFailedActivation(item.activationId);
      }
    }

    async function getPhoneState(tabId) {
      return sendSignupPageCommand(tabId, 'GET_PHONE_VERIFICATION_STATE', {}, {
        timeoutMs: 15000,
        responseTimeoutMs: 8000,
      });
    }

    async function submitPhoneNumber(tabId, phoneNumber, phoneCountry) {
      return sendSignupPageCommand(tabId, 'SUBMIT_PHONE_NUMBER', {
        phoneNumber,
        phoneCountry,
      }, {
        timeoutMs: 40000,
        responseTimeoutMs: 40000,
      });
    }

    async function fillPhoneVerificationCode(tabId, code) {
      return sendSignupPageCommand(tabId, 'FILL_PHONE_VERIFICATION_CODE', { code }, {
        timeoutMs: 40000,
        responseTimeoutMs: 40000,
      });
    }

    async function resendPhoneVerificationCode(tabId) {
      return sendSignupPageCommand(tabId, 'RESEND_PHONE_VERIFICATION_CODE', {}, {
        timeoutMs: 20000,
        responseTimeoutMs: 15000,
      });
    }

    async function clickPhoneVerificationRetry(tabId) {
      return sendSignupPageCommand(tabId, 'CLICK_PHONE_VERIFICATION_RETRY', {}, {
        timeoutMs: 30000,
        responseTimeoutMs: 25000,
      });
    }

    async function throwIfPhoneVerificationPageRequiresFreshNumber(tabId, actionLabel = '检查手机号验证码页') {
      const phoneState = await getPhoneState(tabId).catch((error) => {
        addLog?.(`步骤 9：${actionLabel}状态读取失败：${error.message}，继续当前流程。`, 'warn');
        return null;
      });
      const errorText = String(phoneState?.errorText || '').trim();
      if (!errorText) {
        return phoneState;
      }

      const pageError = new Error(errorText);
      pageError.errorText = errorText;
      if (shouldRetryWithFreshNumber(pageError)) {
        throw pageError;
      }
      return phoneState;
    }

    async function goBackToPhoneNumberEntry(tabId) {
      return sendSignupPageCommand(tabId, 'GO_BACK_TO_PHONE_NUMBER_ENTRY', {}, {
        timeoutMs: 30000,
        responseTimeoutMs: 25000,
      });
    }

    async function handlePhonePageDuringStep8(tabId, stateOverride = null) {
      let state = stateOverride || await getState();
      for (let attempt = 1; attempt <= HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT; attempt += 1) {
        throwIfStopped?.();
        await syncRuntimeFromExtension(state);
        const activation = await runtime.ensureActivationReadyForSubmission(state, {
          maxAttempts: HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT,
        });
        await syncRuntimeToExtension();

        const phoneCountry = await runtime.getCountrySelection(activation.country || state.heroSmsCountry).catch(() => null);
        const isReusedNumber = Boolean(activation.lastCode) || activation.useCount > 0;
        await ensureCurrentActivationExistsBeforeSubmit(activation);
        runtime.setRuntimeStatus(`正在提交手机号 ${activation.phoneNumber}`);
        await syncRuntimeToExtension();
        await addLog?.(`步骤 9：检测到手机号页面，正在使用 HeroSMS 号码 ${activation.phoneNumber}${phoneCountry?.name ? `（国家：${phoneCountry.name}）` : ''} 自动接码...`, 'warn');

        try {
          const submitResult = await submitPhoneNumber(tabId, activation.phoneNumber, phoneCountry);
          if (submitResult?.errorText) {
            const submitError = new Error(submitResult.errorText);
            submitError.errorText = submitResult.errorText;
            throw submitError;
          }
          if (!submitResult?.phoneVerificationPage || !submitResult?.codeEntryReady) {
            const currentPhoneState = await getPhoneState(tabId).catch(() => null);
            if (!currentPhoneState?.phoneVerificationPage || !currentPhoneState?.hasCodeTarget) {
              throw new Error(
                `步骤 9：手机号已提交，但尚未进入 https://auth.openai.com/phone-verification 短信验证码页面。当前 URL: ${submitResult?.url || currentPhoneState?.url || 'unknown'}`
              );
            }
          }
          runtime.setRuntimeStatus(`号码 ${activation.phoneNumber} 已提交，等待短信验证码`);
          await throwIfPhoneVerificationPageRequiresFreshNumber(tabId, '提交手机号后');
          await requestFreshSmsBeforeReceive('接收短信前');

          if (isReusedNumber) {
            await sleepWithStop(3000);

            try {
              const resendPageResult = await resendPhoneVerificationCode(tabId);
              if (resendPageResult?.errorText) {
                const pageResendError = new Error(resendPageResult.errorText);
                pageResendError.errorText = resendPageResult.errorText;
                if (shouldRetryWithFreshNumber(pageResendError)) {
                  throw pageResendError;
                }
                await addLog?.(`步骤 9：页面重发提示错误（${resendPageResult.errorText}），继续等待验证码...`, 'warn');
              } else if (resendPageResult?.resent) {
                await addLog?.('步骤 9：已点击页面"重新发送短信"按钮。', 'info');
              } else {
                await addLog?.('步骤 9：页面重发按钮当前不可用，继续等待验证码...', 'warn');
              }
            } catch (resendErr) {
              if (shouldRetryWithFreshNumber(resendErr)) {
                throw resendErr;
              }
              await addLog?.(`步骤 9：点击页面重发按钮时出错（${resendErr.message}），继续等待验证码...`, 'warn');
            }
          }

          const smsResult = await runtime.waitForCode(activation, {
            pollIntervalMs: HERO_SMS_SMS_POLL_INTERVAL_MS,
            timeoutMs: HERO_SMS_SMS_TIMEOUT_MS,
            resendAfterMs: HERO_SMS_RESEND_AFTER_MS,
            requestFreshCodeOnStart: false,
            excludeCodes: activation.lastCode ? [activation.lastCode] : [],
            maxResendAttempts: Math.max(1, Math.floor(HERO_SMS_SMS_TIMEOUT_MS / HERO_SMS_RESEND_AFTER_MS)),
            onResend: async ({ attempt: resendAttempt, reason }) => {
              const reasonText = reason === 'initial' ? '准备下一轮复用' : '等待新短信超时';
              await addLog?.(`步骤 9：${reasonText}，正在通过 HeroSMS API 请求新的手机号验证码（第 ${resendAttempt} 次）...`, 'warn');
              await throwIfPhoneVerificationPageRequiresFreshNumber(tabId, '请求重发前');

              if (shouldTriggerPageResend(reason, resendAttempt)) {
                try {
                  const resendPageResult = await clickPhonePageResendOnce(tabId, '等待满 1 分钟后额外重发短信');
                  if (resendPageResult?.heroSmsResendRequested) {
                    return;
                  }
                } catch (resendErr) {
                  if (shouldRetryWithFreshNumber(resendErr)) {
                    throw resendErr;
                  }
                  await addLog?.(`步骤 9：等待 1 分钟后的页面重发尝试失败：${resendErr.message}`, 'warn');
                }
              }

              await requestFreshSmsBeforeReceive('HeroSMS 轮询等待 60 秒后');
            },
          });
          await syncRuntimeToExtension();

          runtime.setRuntimeStatus(`已收到验证码 ${smsResult.code}，正在回填页面`);
          await syncRuntimeToExtension();
          await addLog?.(`步骤 9：已从 HeroSMS 收到短信验证码 ${smsResult.code}，正在回填到手机号页面...`, 'ok');

          const fillResult = await fillPhoneVerificationCode(tabId, smsResult.code);
          if (fillResult?.invalidCode) {
            const fillError = new Error(fillResult.errorText || `短信验证码 ${smsResult.code} 被页面拒绝`);
            fillError.errorText = fillResult.errorText || fillError.message;
            fillError.invalidCode = true;
            throw fillError;
          }

          await recordSuccessfulPhoneVerification(activation.activationId);
          runtime.setRuntimeStatus('手机号验证码已提交，等待页面跳转');
          await syncRuntimeToExtension();
          return {
            ok: true,
            activationId: activation.activationId,
            code: smsResult.code,
            submitResult,
            fillResult,
          };
        } catch (error) {
          await setState({ heroSmsPendingSuccessActivationId: 0 });
          broadcastDataUpdate?.({ heroSmsPendingSuccessActivationId: 0 });
          runtime.setRuntimeStatus(`手机号验证失败：${error.message}`);

          const reason = resolveFailureReason(error);
          const latestActivation = runtime.getCurrentActivation() || activation;
          await addLog?.(`步骤 9：HeroSMS 手机号验证失败：${error.message}`, 'warn');

          if (shouldRetryWithFreshNumber(error) && latestActivation) {
            await addLog?.(`步骤 9：检测到${getFailureLabel(reason)}，当前 HeroSMS 号码 ${latestActivation.phoneNumber} 不再复用，正在申请新号码（${attempt}/${HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT}）...`, 'warn');
            try {
              const failureText = String(error?.errorText || error?.message || '').trim();
              if (reason === 'phone_max_usage_exceeded') {
                const releaseResult = await finalizeActivation({ preferComplete: true, releaseReason: reason, silent: false });
                if (releaseResult.released) {
                  await addLog?.(`步骤 9：号码 ${latestActivation.phoneNumber}（ID ${latestActivation.activationId}）触发验证次数 Max 上限，已通过 HeroSMS setStatus=6 完成并释放。`, 'warn');
                }
              } else if (reason === 'phone_resend_rate_limited' || reason === 'hero_sms_wait_code_timeout' || reason === 'phone_sms_unavailable') {
                const releaseResult = await finalizeActivation({ preferComplete: false, releaseReason: reason, silent: false });
                if (releaseResult.released) {
                  const label = reason === 'phone_resend_rate_limited' ? '请求次数过多' : reason === 'phone_sms_unavailable' ? '无法接收短信' : '等待验证码超时';
                  await addLog?.(`步骤 9：号码 ${latestActivation.phoneNumber}（ID ${latestActivation.activationId}）${label}，已通过 HeroSMS setStatus=8 取消并释放，准备使用新号码。`, 'warn');
                } else {
                  const standbyEntry = await moveActivationToStandbyList(latestActivation, reason, releaseResult.error || failureText || 'HeroSMS setStatus=8 释放失败');
                  if (standbyEntry) {
                    await addLog?.(`步骤 9：号码 ${latestActivation.phoneNumber}（ID ${latestActivation.activationId}）释放失败，已移入备用列表，5 分钟后重试复用，直到 Max 上限或过期自动释放。`, 'warn');
                  } else {
                    await addLog?.(`步骤 9：号码 ${latestActivation.phoneNumber}（ID ${latestActivation.activationId}）释放失败，且不足 5 分钟可等待，保留记录等待后续清理。`, 'warn');
                  }
                }
              } else {
                await moveActivationToFailedList(latestActivation, reason, failureText);
                await addLog?.(`步骤 9：已将号码 ${latestActivation.phoneNumber}（ID ${latestActivation.activationId}）记录到失败列表，2 分钟后自动清理。`, 'warn');
              }
            } catch (listErr) {
              await addLog?.(`步骤 9：处理失败号码时出错：${listErr.message}`, 'warn');
            }

            if (reason === 'hero_sms_wait_code_timeout') {
              const restartError = new Error('步骤 9：等待手机短信超过 3 分钟仍未收到验证码，已处理旧号码，准备回到步骤 7 重新执行后续流程并申请新号码。');
              restartError.code = 'hero_sms_timeout_restart_step7';
              restartError.errorText = restartError.message;
              throw restartError;
            }

            const recovery = resolveRecoveryAction(reason);
            try {
              if (recovery === 'retry_button') {
                const retryResult = await clickPhoneVerificationRetry(tabId);
                if (retryResult?.clicked) {
                  await addLog?.(
                    retryResult?.ready
                      ? '步骤 9：已点击页面"重试"按钮，页面已回到手机号填写阶段。'
                      : '步骤 9：已点击页面"重试"按钮，页面正在返回手机号填写阶段...',
                    'warn'
                  );
                } else {
                  await addLog?.('步骤 9：当前未找到可点击的"重试"按钮，将直接继续等待页面回到手机号填写阶段。', 'warn');
                }
              } else if (recovery === 'history_back') {
                const backResult = await goBackToPhoneNumberEntry(tabId);
                if (backResult?.ready) {
                  await addLog?.('步骤 9：已后退回手机号填写页，准备重新申请新号码。', 'warn');
                } else {
                  await addLog?.('步骤 9：已尝试后退回手机号填写页，但页面仍在切换，下一轮将继续申请新号码。', 'warn');
                }
              }
            } catch (retryErr) {
              await addLog?.(`步骤 9：页面恢复操作失败：${retryErr.message}`, 'warn');
            }

            if (attempt < HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT) {
              await sleepWithStop(800);
              state = await getState();
              continue;
            }
          }

          throw error;
        }
      }

      throw new Error(`步骤 9：连续 ${HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT} 次触发手机号不可用错误，未能申请到可用手机号。`);
    }

    async function finalizeAfterSuccessfulFlow() {
      await syncRuntimeFromExtension();
      const runtimeState = runtime.getState();
      const currentActivation = runtime.getCurrentActivation(runtimeState);
      const pendingId = Number(runtimeState.heroSmsPendingSuccessActivationId) || 0;

      if (!currentActivation || pendingId !== currentActivation.activationId) {
        await setState({ heroSmsPendingSuccessActivationId: 0 });
        broadcastDataUpdate?.({ heroSmsPendingSuccessActivationId: 0 });
        return { ok: true, skipped: true };
      }

      const nextUseCount = currentActivation.useCount + 1;
      runtime.mergeCurrentActivation({ useCount: nextUseCount });
      await syncRuntimeToExtension();

      const updatedActivation = runtime.getCurrentActivation();
      const expired = runtime.getActivationRemainingMs(updatedActivation) <= 0;

      await setState({ heroSmsPendingSuccessActivationId: 0 });
      broadcastDataUpdate?.({ heroSmsPendingSuccessActivationId: 0 });

      if (nextUseCount >= HERO_SMS_NUMBER_MAX_USES || expired) {
        await addLog?.(
          `HeroSMS：号码 ${updatedActivation.phoneNumber} 已成功使用 ${nextUseCount}/${HERO_SMS_NUMBER_MAX_USES} 次，准备${nextUseCount >= HERO_SMS_NUMBER_MAX_USES ? '完成激活' : '释放号码'}。`,
          'ok'
        );
        return finalizeActivation({
          preferComplete: nextUseCount >= HERO_SMS_NUMBER_MAX_USES,
          releaseReason: nextUseCount >= HERO_SMS_NUMBER_MAX_USES ? 'max_uses_reached' : 'expired_after_success',
          silent: false,
        });
      }

      await addLog?.(
        `HeroSMS：号码 ${updatedActivation.phoneNumber} 已累计成功注册 ${nextUseCount}/${HERO_SMS_NUMBER_MAX_USES} 次，剩余 ${HERO_SMS_NUMBER_MAX_USES - nextUseCount} 次可复用。`,
        'ok'
      );
      return { ok: true, released: false, useCount: nextUseCount };
    }

    async function onAlarm(alarm) {
      if (!String(alarm?.name || '').startsWith(HERO_SMS_FAILED_ACTIVATION_ALARM_PREFIX)) {
        return false;
      }
      const activationId = Number(String(alarm.name).slice(HERO_SMS_FAILED_ACTIVATION_ALARM_PREFIX.length));
      if (!Number.isInteger(activationId) || activationId <= 0) {
        return true;
      }
      await cleanupFailedActivation(activationId);
      return true;
    }

    async function handleRuntimeMessage(message) {
      switch (message.type) {
        case 'HERO_SMS_RESEND_CODE': {
          const result = await requestResendForCurrentActivation({ silent: false });
          return {
            ok: true,
            response: result?.response || '',
            activation: result?.activation || null,
          };
        }
        case 'HERO_SMS_RELEASE_NUMBER': {
          const result = await finalizeActivation({
            preferComplete: Boolean(message.payload?.preferComplete),
            releaseReason: message.payload?.releaseReason || '',
            silent: false,
          });
          return { ok: true, ...result };
        }
        case 'HERO_SMS_REFRESH_ACTIVE_ACTIVATIONS': {
          const activations = await syncActiveActivations({ fetchedAt: Date.now() });
          return {
            ok: true,
            activations,
            fetchedAt: Date.now(),
          };
        }
        default:
          return null;
      }
    }

    return {
      DEFAULT_HERO_SMS_BASE_URL,
      HERO_SMS_NUMBER_MAX_USES,
      HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT,
      HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS,
      syncRuntimeFromExtension,
      syncRuntimeToExtension,
      handlePhonePageDuringStep8,
      finalizeAfterSuccessfulFlow,
      finalizeActivation,
      requestResendForCurrentActivation,
      syncActiveActivations,
      reconcileFailedActivationCleanupAlarms,
      handleRuntimeMessage,
      onAlarm,
    };
  }

  return { createHeroSmsManager };
});
