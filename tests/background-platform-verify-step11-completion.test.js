const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('background/steps/platform-verify.js', 'utf8');

test('platform verify step 11 completes after CPA panel succeeds', async () => {
  const api = new Function('self', `${source}; return self.MultiPageBackgroundStep11;`)({});
  const completed = [];
  const logs = [];

  const executor = api.createStep11Executor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    closeConflictingTabsForSource: async () => {},
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    getPanelMode: () => 'cpa',
    getTabId: async () => 88,
    isLocalhostOAuthCallbackUrl: (value) => String(value || '').includes('/auth/callback?code='),
    isTabAlive: async () => true,
    normalizeCodex2ApiUrl: (value) => value,
    normalizeSub2ApiUrl: (value) => value,
    rememberSourceLastUrl: async () => {},
    reuseOrCreateTab: async () => 88,
    sendToContentScript: async () => ({}),
    sendToContentScriptResilient: async () => ({
      verifiedStatus: '认证成功！',
    }),
    shouldBypassStep9ForLocalCpa: () => false,
    SUB2API_STEP9_RESPONSE_TIMEOUT_MS: 120000,
  });

  await executor.executeStep11({
    panelMode: 'cpa',
    localhostUrl: 'http://localhost:1455/auth/callback?code=callback-code&state=oauth-state',
    vpsUrl: 'https://cpa.example.com/admin',
    vpsPassword: 'secret',
  });

  assert.deepStrictEqual(logs, [
    { message: '步骤 11：正在打开 CPA 面板...', level: 'info' },
    { message: '步骤 11：正在填写回调地址...', level: 'info' },
  ]);
  assert.deepStrictEqual(completed, [
    {
      step: 11,
      payload: {
        localhostUrl: 'http://localhost:1455/auth/callback?code=callback-code&state=oauth-state',
        verifiedStatus: '认证成功！',
      },
    },
  ]);
});

test('platform verify step 11 completes after SUB2API succeeds', async () => {
  const api = new Function('self', `${source}; return self.MultiPageBackgroundStep11;`)({});
  const completed = [];
  const logs = [];

  const executor = api.createStep11Executor({
    addLog: async (message, level = 'info') => {
      logs.push({ message, level });
    },
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    closeConflictingTabsForSource: async () => {},
    completeStepFromBackground: async (step, payload) => {
      completed.push({ step, payload });
    },
    ensureContentScriptReadyOnTab: async () => {},
    getPanelMode: () => 'sub2api',
    getTabId: async () => 99,
    isLocalhostOAuthCallbackUrl: (value) => String(value || '').includes('/auth/callback?code='),
    isTabAlive: async () => true,
    normalizeCodex2ApiUrl: (value) => value,
    normalizeSub2ApiUrl: (value) => value,
    rememberSourceLastUrl: async () => {},
    reuseOrCreateTab: async () => 99,
    sendToContentScript: async () => ({}),
    sendToContentScriptResilient: async () => ({}),
    shouldBypassStep9ForLocalCpa: () => false,
    SUB2API_STEP9_RESPONSE_TIMEOUT_MS: 120000,
  });

  await executor.executeStep11({
    panelMode: 'sub2api',
    localhostUrl: 'http://localhost:1455/auth/callback?code=callback-code&state=oauth-state',
    sub2apiUrl: 'https://sub.example/admin/accounts',
    sub2apiEmail: 'admin@example.com',
    sub2apiPassword: 'secret',
    sub2apiGroupName: 'codex',
    sub2apiDefaultProxyName: '',
    sub2apiProxyId: null,
    sub2apiSessionId: 'session-1',
    sub2apiOAuthState: 'oauth-state',
    sub2apiGroupId: 5,
    sub2apiDraftName: 'flow@example.com',
  });

  assert.deepStrictEqual(logs, [
    { message: '步骤 11：正在打开 SUB2API 后台...', level: 'info' },
    { message: '步骤 11：正在向 SUB2API 提交回调并创建账号...', level: 'info' },
  ]);
  assert.deepStrictEqual(completed, [
    {
      step: 11,
      payload: {
        localhostUrl: 'http://localhost:1455/auth/callback?code=callback-code&state=oauth-state',
        verifiedStatus: 'SUB2API OAuth 账号添加成功',
      },
    },
  ]);
});
