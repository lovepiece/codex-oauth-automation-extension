(function attachBackgroundStep7(root, factory) {
  root.MultiPageBackgroundStep7 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep7Module() {
  function createStep7Executor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      getErrorMessage,
      getLoginAuthStateLabel,
      getOAuthFlowStepTimeoutMs,
      getState,
      isStep6RecoverableResult,
      isStep6SuccessResult,
      refreshOAuthUrlBeforeStep6,
      reuseOrCreateTab,
      sendToContentScriptResilient,
      startOAuthFlowTimeoutWindow,
      STEP6_MAX_ATTEMPTS,
      throwIfStopped,
    } = deps;

    function isAddPhoneAuthFailure(error) {
      const message = String(typeof error === 'string' ? error : error?.message || '');
      return /https:\/\/auth\.openai\.com\/add-phone(?:[/?#]|$)|add-phone|手机号页面|手机号码|手机号|phone\s+number|telephone/i.test(message);
    }

    async function executeStep7(state) {
      if (!state.email) {
        throw new Error('缺少邮箱地址，请先完成步骤 3。');
      }

      let attempt = 0;
      let lastError = null;

      while (attempt < STEP6_MAX_ATTEMPTS) {
        throwIfStopped();
        attempt += 1;
        try {
          const currentState = attempt === 1 ? state : await getState();
          const password = currentState.password || currentState.customPassword || '';
          const oauthUrl = await refreshOAuthUrlBeforeStep6(currentState);
          if (typeof startOAuthFlowTimeoutWindow === 'function') {
            await startOAuthFlowTimeoutWindow({ step: 7, oauthUrl });
          }
          const loginTimeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
            ? await getOAuthFlowStepTimeoutMs(180000, {
              step: 7,
              actionLabel: 'OAuth 登录并进入验证码页',
            })
            : 180000;

          if (attempt === 1) {
            await addLog('步骤 7：正在打开最新 OAuth 链接并登录...');
          } else {
            await addLog(`步骤 7：上一轮失败后，正在进行第 ${attempt} 次尝试（最多 ${STEP6_MAX_ATTEMPTS} 次）...`, 'warn');
          }

          await reuseOrCreateTab('signup-page', oauthUrl);

          const result = await sendToContentScriptResilient(
            'signup-page',
            {
              type: 'EXECUTE_STEP',
              step: 7,
              source: 'background',
              payload: {
                email: currentState.email,
                password,
              },
            },
            {
              timeoutMs: loginTimeoutMs,
              responseTimeoutMs: loginTimeoutMs,
              retryDelayMs: 700,
              logMessage: '步骤 7：认证页正在切换，等待页面重新就绪后继续登录...',
            }
          );

          if (result?.error) {
            throw new Error(result.error);
          }

          if (isStep6SuccessResult(result)) {
            await completeStepFromBackground(7, {
              loginVerificationRequestedAt: result.loginVerificationRequestedAt || null,
            });
            return;
          }

          if (isStep6RecoverableResult(result)) {
            const reasonMessage = result.message
              || `当前停留在${getLoginAuthStateLabel(result.state)}，准备重新执行步骤 7。`;
            throw new Error(reasonMessage);
          }

          throw new Error('步骤 7：认证页未返回可识别的登录结果。');
        } catch (err) {
          throwIfStopped(err);
          if (isAddPhoneAuthFailure(err)) {
            throw err;
          }
          lastError = err;
          if (attempt >= STEP6_MAX_ATTEMPTS) {
            break;
          }

          await addLog(`步骤 7：第 ${attempt} 次尝试失败，原因：${getErrorMessage(err)}；准备重试...`, 'warn');
        }
      }

      throw new Error(`步骤 7：判断失败后已重试 ${STEP6_MAX_ATTEMPTS - 1} 次，仍未成功。最后原因：${getErrorMessage(lastError)}`);
    }

    return { executeStep7 };
  }

  return { createStep7Executor };
});
