(function attachBackgroundStep9(root, factory) {
  root.MultiPageBackgroundStep9 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep9Module() {
  function createStep9Executor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      ensureStep8SignupPageReady,
      getOAuthFlowStepTimeoutMs,
      getStep8PageState,
      getTabId,
      handlePhonePageDuringStep8,
      isTabAlive,
      sleepWithStop,
      throwIfStopped,
      CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX,
      CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE,
    } = deps;

    const POLL_INTERVAL_MS = 250;

    async function waitForPhoneOrConsentPage(tabId, timeoutMs) {
      const start = Date.now();
      let recovered = false;

      while (Date.now() - start < timeoutMs) {
        throwIfStopped?.();
        const pageState = await getStep8PageState(tabId);

        if (pageState?.maxCheckAttemptsBlocked) {
          throw new Error(`${CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX}${CLOUDFLARE_SECURITY_BLOCK_USER_MESSAGE}`);
        }
        if (pageState?.addPhonePage) {
          return pageState;
        }
        if (pageState?.consentReady) {
          return pageState;
        }
        if (pageState?.retryPage) {
          return pageState;
        }

        if (pageState === null && !recovered) {
          recovered = true;
          await ensureStep8SignupPageReady(tabId, {
            timeoutMs: Math.min(10000, timeoutMs - (Date.now() - start)),
            logMessage: '步骤 9：认证页内容脚本已失联，正在等待页面重新就绪...',
          });
          continue;
        }
        recovered = false;
        await sleepWithStop(POLL_INTERVAL_MS);
      }

      return null;
    }

    async function executeStep9(state) {
      if (!state.oauthUrl) {
        throw new Error('缺少登录用 OAuth 链接，请先完成步骤 7。');
      }

      await addLog('步骤 9：检查是否需要手机号验证...');

      const timeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(30000, {
          step: 9,
          actionLabel: '等待手机号验证页面',
        })
        : 30000;

      const signupTabId = await getTabId('signup-page');
      if (!signupTabId || !(await isTabAlive('signup-page'))) {
        await addLog('步骤 9：未找到认证页面，跳过手机号验证。', 'info');
        await completeStepFromBackground(9, {});
        return;
      }

      const pageState = await waitForPhoneOrConsentPage(signupTabId, timeoutMs);

      if (pageState?.addPhonePage) {
        if (typeof handlePhonePageDuringStep8 === 'function') {
          await addLog('步骤 9：检测到手机号验证页面，正在使用 HeroSMS 自动完成验证...', 'info');
          await handlePhonePageDuringStep8(signupTabId);
          await addLog('步骤 9：手机号验证完成。', 'ok');
        } else {
          throw new Error('步骤 9：检测到手机号页面但未配置 HeroSMS，无法继续。');
        }
      } else if (pageState?.consentReady) {
        await addLog('步骤 9：页面已进入 OAuth 同意页，无需手机号验证，跳过。', 'info');
      } else if (pageState?.retryPage) {
        await addLog('步骤 9：检测到重试页面，无需手机号验证，跳过。', 'info');
      } else {
        await addLog('步骤 9：等待超时，未检测到手机号验证页面，跳过。', 'info');
      }

      await completeStepFromBackground(9, {});
    }

    return { executeStep9 };
  }

  return { createStep9Executor };
});
