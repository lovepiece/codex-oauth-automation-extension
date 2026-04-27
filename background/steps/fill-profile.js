(function attachBackgroundStep5(root, factory) {
  root.MultiPageBackgroundStep5 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep5Module() {
  function createStep5Executor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      generateRandomBirthday,
      generateRandomName,
      getTabId,
      isSignupEntryHost,
      sendToContentScript,
    } = deps;

    function isChatGptEntryUrl(rawUrl = '') {
      try {
        const parsed = new URL(String(rawUrl || ''));
        if (typeof isSignupEntryHost === 'function') {
          return isSignupEntryHost(parsed.hostname);
        }
        return ['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname);
      } catch {
        return false;
      }
    }

    async function getSignupTabUrl() {
      if (typeof getTabId !== 'function' || !chrome?.tabs?.get) {
        return '';
      }

      const tabId = await getTabId('signup-page');
      if (!tabId) {
        return '';
      }

      const tab = await chrome.tabs.get(tabId).catch(() => null);
      return String(tab?.url || '').trim();
    }

    async function executeStep5() {
      const currentUrl = await getSignupTabUrl();
      if (isChatGptEntryUrl(currentUrl)) {
        await addLog(
          `步骤 5：注册验证码完成后已进入 ChatGPT 页面（${currentUrl}），无需填写姓名和生日，已自动跳过。`,
          'warn'
        );
        if (typeof completeStepFromBackground === 'function') {
          await completeStepFromBackground(5, {
            skipped: true,
            reason: 'already_on_chatgpt',
            url: currentUrl,
          });
          return;
        }
      }

      const { firstName, lastName } = generateRandomName();
      const { year, month, day } = generateRandomBirthday();

      await addLog(`步骤 5：已生成姓名 ${firstName} ${lastName}，生日 ${year}-${month}-${day}`);

      await sendToContentScript('signup-page', {
        type: 'EXECUTE_STEP',
        step: 5,
        source: 'background',
        payload: { firstName, lastName, year, month, day },
      });
    }

    return { executeStep5 };
  }

  return { createStep5Executor };
});
