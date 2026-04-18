const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/message-router.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundMessageRouter;`)(globalScope);

function createRouter(overrides = {}) {
  const events = {
    logs: [],
    stepStatuses: [],
    emailStates: [],
    finalizePayloads: [],
    notifyCompletions: [],
    notifyErrors: [],
    securityBlocks: [],
  };

  const router = api.createMessageRouter({
    addLog: async (message, level) => {
      events.logs.push({ message, level });
    },
    appendAccountRunRecord: async () => null,
    batchUpdateLuckmailPurchases: async () => {},
    buildLocalhostCleanupPrefix: () => '',
    buildLuckmailSessionSettingsPayload: () => ({}),
    buildPersistentSettingsPayload: () => ({}),
    broadcastDataUpdate: () => {},
    cancelScheduledAutoRun: async () => {},
    checkIcloudSession: async () => {},
    clearAutoRunTimerAlarm: async () => {},
    clearLuckmailRuntimeState: async () => {},
    clearStopRequest: () => {},
    closeLocalhostCallbackTabs: async () => {},
    closeTabsByUrlPrefix: async () => {},
    deleteHotmailAccount: async () => {},
    deleteHotmailAccounts: async () => {},
    deleteIcloudAlias: async () => {},
    deleteUsedIcloudAliases: async () => {},
    disableUsedLuckmailPurchases: async () => {},
    doesStepUseCompletionSignal: () => false,
    ensureManualInteractionAllowed: async () => ({}),
    executeStep: async () => {},
    executeStepViaCompletionSignal: async () => {},
    exportSettingsBundle: async () => ({}),
    fetchGeneratedEmail: async () => '',
    finalizeStep3Completion: overrides.finalizeStep3Completion || (async (payload) => {
      events.finalizePayloads.push(payload);
    }),
    finalizeIcloudAliasAfterSuccessfulFlow: async () => {},
    findHotmailAccount: async () => null,
    flushCommand: async () => {},
    getCurrentLuckmailPurchase: () => null,
    getPendingAutoRunTimerPlan: () => null,
    getSourceLabel: () => '',
    getState: async () => overrides.state || { stepStatuses: { 3: 'pending' } },
    getStopRequested: () => false,
    handleAutoRunLoopUnhandledError: async () => {},
    handleCloudflareSecurityBlocked: overrides.handleCloudflareSecurityBlocked || (async (error) => {
      const message = typeof error === 'string' ? error : error?.message || '';
      events.securityBlocks.push(message);
      return message.replace(/^CF_SECURITY_BLOCKED::/, '') || message;
    }),
    importSettingsBundle: async () => {},
    invalidateDownstreamAfterStepRestart: async () => {},
    isCloudflareSecurityBlockedError: overrides.isCloudflareSecurityBlockedError || ((error) => /^CF_SECURITY_BLOCKED::/.test(typeof error === 'string' ? error : error?.message || '')),
    isAutoRunLockedState: () => false,
    isHotmailProvider: () => false,
    isLocalhostOAuthCallbackUrl: () => true,
    isLuckmailProvider: () => false,
    isStopError: () => false,
    launchAutoRunTimerPlan: async () => {},
    listIcloudAliases: async () => [],
    listLuckmailPurchasesForManagement: async () => [],
    normalizeHotmailAccounts: (items) => items,
    normalizeRunCount: (value) => value,
    AUTO_RUN_TIMER_KIND_SCHEDULED_START: 'scheduled',
    notifyStepComplete: (step, payload) => {
      events.notifyCompletions.push({ step, payload });
    },
    notifyStepError: (step, error) => {
      events.notifyErrors.push({ step, error });
    },
    patchHotmailAccount: async () => {},
    registerTab: async () => {},
    requestStop: async () => {},
    resetState: async () => {},
    resumeAutoRun: async () => {},
    scheduleAutoRun: async () => {},
    selectLuckmailPurchase: async () => {},
    setCurrentHotmailAccount: async () => {},
    setEmailState: async (email) => {
      events.emailStates.push(email);
    },
    setEmailStateSilently: async () => {},
    setIcloudAliasPreservedState: async () => {},
    setIcloudAliasUsedState: async () => {},
    setLuckmailPurchaseDisabledState: async () => {},
    setLuckmailPurchasePreservedState: async () => {},
    setLuckmailPurchaseUsedState: async () => {},
    setPersistentSettings: async () => {},
    setState: async () => {},
    setStepStatus: async (step, status) => {
      events.stepStatuses.push({ step, status });
    },
    skipAutoRunCountdown: async () => false,
    skipStep: async () => {},
    startAutoRunLoop: async () => {},
    syncHotmailAccounts: async () => {},
    testHotmailAccountMailAccess: async () => {},
    upsertHotmailAccount: async () => {},
    verifyHotmailAccount: async () => {},
  });

  return { router, events };
}

test('message router skips step 3 when step 2 lands on verification page', async () => {
  const { router, events } = createRouter({
    state: { stepStatuses: { 3: 'pending' } },
  });

  await router.handleStepData(2, {
    email: 'user@example.com',
    skippedPasswordStep: true,
  });

  assert.deepStrictEqual(events.emailStates, ['user@example.com']);
  assert.deepStrictEqual(events.stepStatuses, [{ step: 3, status: 'skipped' }]);
  assert.equal(events.logs[0]?.message, '步骤 2：提交邮箱后页面直接进入邮箱验证码页，已自动跳过步骤 3。');
});

test('message router does not overwrite a completed step 3 when step 2 is replayed', async () => {
  const { router, events } = createRouter({
    state: { stepStatuses: { 3: 'completed' } },
  });

  await router.handleStepData(2, {
    skippedPasswordStep: true,
  });

  assert.deepStrictEqual(events.stepStatuses, []);
});

test('message router finalizes step 3 before marking it completed', async () => {
  const { router, events } = createRouter();

  const response = await router.handleMessage({
    type: 'STEP_COMPLETE',
    step: 3,
    source: 'signup-page',
    payload: {
      email: 'user@example.com',
      signupVerificationRequestedAt: 123,
    },
  }, {});

  assert.deepStrictEqual(events.finalizePayloads, [
    {
      email: 'user@example.com',
      signupVerificationRequestedAt: 123,
    },
  ]);
  assert.deepStrictEqual(events.stepStatuses, [{ step: 3, status: 'completed' }]);
  assert.deepStrictEqual(events.emailStates, ['user@example.com']);
  assert.deepStrictEqual(events.notifyCompletions, [
    {
      step: 3,
      payload: {
        email: 'user@example.com',
        signupVerificationRequestedAt: 123,
      },
    },
  ]);
  assert.deepStrictEqual(response, { ok: true });
});

test('message router marks step 3 failed when post-submit finalize fails', async () => {
  const { router, events } = createRouter({
    finalizeStep3Completion: async () => {
      throw new Error('步骤 3 提交后仍停留在密码页。');
    },
  });

  const response = await router.handleMessage({
    type: 'STEP_COMPLETE',
    step: 3,
    source: 'signup-page',
    payload: {
      email: 'user@example.com',
    },
  }, {});

  assert.deepStrictEqual(events.stepStatuses, [{ step: 3, status: 'failed' }]);
  assert.deepStrictEqual(events.notifyErrors, [
    {
      step: 3,
      error: '步骤 3 提交后仍停留在密码页。',
    },
  ]);
  assert.equal(events.logs.some(({ message }) => /步骤 3 失败：步骤 3 提交后仍停留在密码页。/.test(message)), true);
  assert.deepStrictEqual(response, { ok: true, error: '步骤 3 提交后仍停留在密码页。' });
});

test('message router stops the flow and surfaces cloudflare security block errors', async () => {
  const { router, events } = createRouter();

  const response = await router.handleMessage({
    type: 'STEP_ERROR',
    step: 7,
    source: 'signup-page',
    payload: {},
    error: 'CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统',
  }, {});

  assert.deepStrictEqual(events.securityBlocks, ['CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统']);
  assert.deepStrictEqual(events.notifyErrors, [
    {
      step: 7,
      error: '流程已被用户停止。',
    },
  ]);
  assert.deepStrictEqual(response, {
    ok: true,
    error: '您已触发Cloudflare 安全防护系统',
  });
});
