(function attachBackgroundStep1(root, factory) {
  root.MultiPageBackgroundStep1 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep1Module() {
  function createStep1Executor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      openSignupEntryTab,
      runPreStep6CookieCleanup,
    } = deps;

    async function executeStep1() {
      if (typeof runPreStep6CookieCleanup === 'function') {
        await runPreStep6CookieCleanup({
          delayMs: 0,
          stepLabel: '步骤 1',
          finalMessage: '准备打开 ChatGPT 官网。',
        });
      }
      await addLog('步骤 1：正在打开 ChatGPT 官网...');
      await openSignupEntryTab(1);
      await completeStepFromBackground(1, {});
    }

    return { executeStep1 };
  }

  return { createStep1Executor };
});
