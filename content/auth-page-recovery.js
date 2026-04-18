(function authPageRecoveryModule(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }

  root.MultiPageAuthPageRecovery = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createAuthPageRecoveryModule() {
  function createAuthPageRecovery(deps = {}) {
    const {
      detailPattern = null,
      getActionText,
      getPageTextSnapshot,
      humanPause,
      isActionEnabled,
      isVisibleElement,
      log,
      simulateClick,
      sleep,
      throwIfStopped,
      titlePattern = null,
    } = deps;

    function matchesPathPatterns(pathname, pathPatterns = []) {
      if (!Array.isArray(pathPatterns) || !pathPatterns.length) {
        return true;
      }
      return pathPatterns.some((pattern) => pattern instanceof RegExp && pattern.test(pathname));
    }

    function getAuthRetryButton(options = {}) {
      const { allowDisabled = false } = options;
      const direct = document.querySelector('button[data-dd-action-name="Try again"]');
      if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
        return direct;
      }

      const candidates = document.querySelectorAll('button, [role="button"]');
      return Array.from(candidates).find((element) => {
        if (!isVisibleElement(element) || (!allowDisabled && !isActionEnabled(element))) {
          return false;
        }
        const text = typeof getActionText === 'function' ? getActionText(element) : '';
        return /重试|try\s+again/i.test(text);
      }) || null;
    }

    function getAuthTimeoutErrorPageState(options = {}) {
      const { pathPatterns = [] } = options;
      const pathname = location.pathname || '';
      if (!matchesPathPatterns(pathname, pathPatterns)) {
        return null;
      }

      const retryButton = getAuthRetryButton({ allowDisabled: true });
      if (!retryButton) {
        return null;
      }

      const text = typeof getPageTextSnapshot === 'function' ? getPageTextSnapshot() : '';
      const title = typeof document !== 'undefined' ? String(document.title || '') : '';
      const titleMatched = titlePattern instanceof RegExp
        ? titlePattern.test(text) || titlePattern.test(title)
        : false;
      const detailMatched = detailPattern instanceof RegExp
        ? detailPattern.test(text)
        : false;
      const maxCheckAttemptsBlocked = /max_check_attempts/i.test(text);

      if (!titleMatched && !detailMatched && !maxCheckAttemptsBlocked) {
        return null;
      }

      return {
        path: pathname,
        url: location.href,
        retryButton,
        retryEnabled: isActionEnabled(retryButton),
        titleMatched,
        detailMatched,
        maxCheckAttemptsBlocked,
      };
    }

    async function waitForRetryPageRecoveryAfterClick(options = {}) {
      const {
        pathPatterns = [],
        pollIntervalMs = 250,
        settleAfterClickMs = 3000,
      } = options;
      const startedAt = Date.now();

      while (Date.now() - startedAt < settleAfterClickMs) {
        if (typeof throwIfStopped === 'function') {
          throwIfStopped();
        }

        const retryState = getAuthTimeoutErrorPageState({ pathPatterns });
        if (!retryState) {
          return {
            recovered: true,
            elapsedMs: Date.now() - startedAt,
          };
        }

        await sleep(pollIntervalMs);
      }

      return {
        recovered: false,
        elapsedMs: Date.now() - startedAt,
      };
    }

    async function recoverAuthRetryPage(options = {}) {
      const {
        logLabel = '',
        pathPatterns = [],
        pollIntervalMs = 250,
        step = null,
        timeoutMs = 12000,
        waitAfterClickMs = 3000,
      } = options;
      const start = Date.now();
      let clickCount = 0;

      while (Date.now() - start < timeoutMs) {
        if (typeof throwIfStopped === 'function') {
          throwIfStopped();
        }

        const retryState = getAuthTimeoutErrorPageState({ pathPatterns });
        if (!retryState) {
          return {
            recovered: clickCount > 0,
            clickCount,
            url: location.href,
          };
        }

        if (retryState.maxCheckAttemptsBlocked) {
          throw new Error(
            'CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统，已完全停止流程，请不要短时间内多次进行重新发送验证码，连续刷新、反复点击重试会加重风控；请先关闭页面等待 15-30 分钟，让系统的临时限制自动解除。或者更换浏览器'
          );
        }

        if (retryState.retryButton && retryState.retryEnabled) {
          clickCount += 1;
          if (typeof log === 'function') {
            const prefix = logLabel || `步骤 ${step || '?'}：检测到重试页，正在点击“重试”恢复`;
            log(`${prefix}（第 ${clickCount} 次）...`, 'warn');
          }
          if (typeof humanPause === 'function') {
            await humanPause(300, 800);
          }
          simulateClick(retryState.retryButton);
          const recoveryResult = await waitForRetryPageRecoveryAfterClick({
            pathPatterns,
            pollIntervalMs,
            settleAfterClickMs: waitAfterClickMs,
          });
          if (recoveryResult.recovered) {
            return {
              recovered: true,
              clickCount,
              url: location.href,
            };
          }
          continue;
        }

        await sleep(pollIntervalMs);
      }

      throw new Error(
        `${logLabel || `步骤 ${step || '?'}：重试页恢复`}超时。URL: ${location.href}`
      );
    }

    return {
      getAuthRetryButton,
      getAuthTimeoutErrorPageState,
      recoverAuthRetryPage,
    };
  }

  return {
    createAuthPageRecovery,
  };
});
