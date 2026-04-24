(function attachBackgroundStep10(root, factory) {
  root.MultiPageBackgroundStep10 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep10Module() {
  function createStep10Executor(deps = {}) {
    const {
      addLog,
      chrome,
      cleanupStep8NavigationListeners,
      clickWithDebugger,
      completeStepFromBackground,
      ensureStep8SignupPageReady,
      getOAuthFlowStepTimeoutMs,
      getStep8CallbackUrlFromNavigation,
      getStep8CallbackUrlFromTabUpdate,
      getStep8EffectLabel,
      getTabId,
      isTabAlive,
      prepareStep8DebuggerClick,
      reloadStep8ConsentPage,
      reuseOrCreateTab,
      sleepWithStop,
      STEP8_CLICK_RETRY_DELAY_MS,
      STEP8_MAX_ROUNDS,
      STEP8_READY_WAIT_TIMEOUT_MS,
      STEP8_STRATEGIES,
      throwIfStep8SettledOrStopped,
      triggerStep8ContentStrategy,
      waitForStep8ClickEffect,
      waitForStep8Ready,
      setWebNavListener,
      setWebNavCommittedListener,
      setStep8PendingReject,
      setStep8TabUpdatedListener,
    } = deps;

    async function executeStep10(state) {
      if (!state.oauthUrl) {
        throw new Error('缺少登录用 OAuth 链接，请先完成步骤 7。');
      }

      await addLog('步骤 10：正在监听 localhost 回调地址...');

      const callbackTimeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
        ? await getOAuthFlowStepTimeoutMs(120000, {
          step: 10,
          actionLabel: 'OAuth localhost 回调',
        })
        : 120000;

      return new Promise((resolve, reject) => {
        let resolved = false;
        let signupTabId = null;

        const cleanupListener = () => {
          cleanupStep8NavigationListeners();
          setStep8PendingReject(null);
        };

        const rejectStep10 = (error) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          cleanupListener();
          reject(error);
        };

        const finalizeStep10Callback = (callbackUrl) => {
          if (resolved || !callbackUrl) return;

          resolved = true;
          cleanupListener();
          clearTimeout(timeout);

          addLog(`步骤 10：已捕获 localhost 地址：${callbackUrl}`, 'ok').then(() => {
            return completeStepFromBackground(10, { localhostUrl: callbackUrl });
          }).then(() => {
            resolve();
          }).catch((err) => {
            reject(err);
          });
        };

        const timeout = setTimeout(() => {
          rejectStep10(new Error('120 秒内未捕获到 localhost 回调跳转，步骤 10 的点击可能被拦截了。'));
        }, callbackTimeoutMs);

        setStep8PendingReject((error) => {
          rejectStep10(error);
        });

        setWebNavListener((details) => {
          const callbackUrl = getStep8CallbackUrlFromNavigation(details, signupTabId);
          finalizeStep10Callback(callbackUrl);
        });

        setWebNavCommittedListener((details) => {
          const callbackUrl = getStep8CallbackUrlFromNavigation(details, signupTabId);
          finalizeStep10Callback(callbackUrl);
        });

        setStep8TabUpdatedListener((tabId, changeInfo, tab) => {
          const callbackUrl = getStep8CallbackUrlFromTabUpdate(tabId, changeInfo, tab, signupTabId);
          finalizeStep10Callback(callbackUrl);
        });

        (async () => {
          try {
            throwIfStep8SettledOrStopped(resolved);
            signupTabId = await getTabId('signup-page');
            throwIfStep8SettledOrStopped(resolved);

            if (signupTabId && await isTabAlive('signup-page')) {
              await chrome.tabs.update(signupTabId, { active: true });
              await addLog('步骤 10：已切回认证页，正在准备调试器点击...');
            } else {
              signupTabId = await reuseOrCreateTab('signup-page', state.oauthUrl);
              await addLog('步骤 10：已重新打开认证页，正在准备调试器点击...');
            }

            throwIfStep8SettledOrStopped(resolved);
            chrome.webNavigation.onBeforeNavigate.addListener(deps.getWebNavListener());
            chrome.webNavigation.onCommitted.addListener(deps.getWebNavCommittedListener());
            chrome.tabs.onUpdated.addListener(deps.getStep8TabUpdatedListener());
            await ensureStep8SignupPageReady(signupTabId, {
              timeoutMs: typeof getOAuthFlowStepTimeoutMs === 'function'
                ? await getOAuthFlowStepTimeoutMs(15000, {
                  step: 10,
                  actionLabel: '等待 OAuth 同意页内容脚本就绪',
                })
                : 15000,
              logMessage: '步骤 10：认证页内容脚本尚未就绪，正在等待页面恢复...',
            });

            for (let round = 1; round <= STEP8_MAX_ROUNDS && !resolved; round++) {
              throwIfStep8SettledOrStopped(resolved);
              const pageState = await waitForStep8Ready(
                signupTabId,
                typeof getOAuthFlowStepTimeoutMs === 'function'
                  ? await getOAuthFlowStepTimeoutMs(STEP8_READY_WAIT_TIMEOUT_MS, {
                    step: 10,
                    actionLabel: '等待 OAuth 同意页出现',
                  })
                  : STEP8_READY_WAIT_TIMEOUT_MS
              );

              if (!pageState?.consentReady) {
                await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
                continue;
              }

              const strategy = STEP8_STRATEGIES[Math.min(round - 1, STEP8_STRATEGIES.length - 1)];

              await addLog(`步骤 10：第 ${round}/${STEP8_MAX_ROUNDS} 轮尝试点击"继续"（${strategy.label}）...`);

              if (strategy.mode === 'debugger') {
                const clickActionTimeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
                  ? await getOAuthFlowStepTimeoutMs(15000, {
                    step: 10,
                    actionLabel: '定位 OAuth 同意页继续按钮',
                  })
                  : 15000;
                const clickTarget = await prepareStep8DebuggerClick(signupTabId, {
                  timeoutMs: clickActionTimeoutMs,
                  responseTimeoutMs: clickActionTimeoutMs,
                });
                throwIfStep8SettledOrStopped(resolved);
                await clickWithDebugger(signupTabId, clickTarget?.rect);
              } else {
                const clickActionTimeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
                  ? await getOAuthFlowStepTimeoutMs(15000, {
                    step: 10,
                    actionLabel: '点击 OAuth 同意页继续按钮',
                  })
                  : 15000;
                await triggerStep8ContentStrategy(signupTabId, strategy.strategy, {
                  timeoutMs: clickActionTimeoutMs,
                  responseTimeoutMs: clickActionTimeoutMs,
                });
              }

              if (resolved) {
                return;
              }

              const effect = await waitForStep8ClickEffect(
                signupTabId,
                pageState.url,
                typeof getOAuthFlowStepTimeoutMs === 'function'
                  ? await getOAuthFlowStepTimeoutMs(15000, {
                    step: 10,
                    actionLabel: '等待 OAuth 同意页点击生效',
                  })
                  : 15000
              );
              if (resolved) {
                return;
              }

              if (effect.progressed) {
                await addLog(`步骤 10：检测到本次点击已生效，${getStep8EffectLabel(effect)}，继续等待 localhost 回调...`, 'info');
                break;
              }

              if (round >= STEP8_MAX_ROUNDS) {
                throw new Error(`步骤 10：连续 ${STEP8_MAX_ROUNDS} 轮点击"继续"后页面仍无反应。`);
              }

              await addLog(`步骤 10：${strategy.label} 本轮点击后页面无反应，正在刷新认证页后重试（下一轮 ${round + 1}/${STEP8_MAX_ROUNDS}）...`, 'warn');
              await reloadStep8ConsentPage(
                signupTabId,
                typeof getOAuthFlowStepTimeoutMs === 'function'
                  ? await getOAuthFlowStepTimeoutMs(30000, {
                    step: 10,
                    actionLabel: '刷新 OAuth 同意页',
                  })
                  : 30000
              );
              await sleepWithStop(STEP8_CLICK_RETRY_DELAY_MS);
            }
          } catch (err) {
            rejectStep10(err);
          }
        })();
      });
    }

    return { executeStep10 };
  }

  return { createStep10Executor };
});
