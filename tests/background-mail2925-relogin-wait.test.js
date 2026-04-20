const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const mail2925Utils = require('../mail2925-utils.js');

test('ensureMail2925MailboxSession waits 3 seconds before and after opening login page on force relogin', async () => {
  const source = fs.readFileSync('background/mail-2925-session.js', 'utf8');
  const globalScope = {};
  const api = new Function('self', `${source}; return self.MultiPageBackgroundMail2925Session;`)(globalScope);

  let currentState = {
    autoRunning: false,
    mail2925Accounts: mail2925Utils.normalizeMail2925Accounts([
      { id: 'acc-1', email: 'acc1@2925.com', password: 'p1', enabled: true, lastUsedAt: 10 },
    ]),
    currentMail2925AccountId: 'acc-1',
  };
  const events = {
    sleeps: [],
  };

  const manager = api.createMail2925SessionManager({
    addLog: async () => {},
    broadcastDataUpdate: () => {},
    chrome: {
      cookies: {
        getAll: async () => [],
        remove: async () => ({ ok: true }),
      },
      browsingData: {
        removeCookies: async () => {},
      },
    },
    findMail2925Account: mail2925Utils.findMail2925Account,
    getMail2925AccountStatus: mail2925Utils.getMail2925AccountStatus,
    getState: async () => currentState,
    isAutoRunLockedState: () => false,
    isMail2925AccountAvailable: mail2925Utils.isMail2925AccountAvailable,
    MAIL2925_LIMIT_COOLDOWN_MS: mail2925Utils.MAIL2925_LIMIT_COOLDOWN_MS,
    normalizeMail2925Account: mail2925Utils.normalizeMail2925Account,
    normalizeMail2925Accounts: mail2925Utils.normalizeMail2925Accounts,
    pickMail2925AccountForRun: mail2925Utils.pickMail2925AccountForRun,
    requestStop: async () => {},
    reuseOrCreateTab: async () => 1,
    sendToMailContentScriptResilient: async () => ({ loggedIn: true }),
    setPersistentSettings: async (payload) => {
      currentState = { ...currentState, ...payload };
    },
    setState: async (updates) => {
      currentState = { ...currentState, ...updates };
    },
    sleepWithStop: async (ms) => {
      events.sleeps.push(ms);
    },
    throwIfStopped: () => {},
    upsertMail2925AccountInList: mail2925Utils.upsertMail2925AccountInList,
  });

  await manager.ensureMail2925MailboxSession({
    accountId: 'acc-1',
    forceRelogin: true,
    actionLabel: '步骤 4：确认 2925 邮箱登录态',
  });

  assert.deepStrictEqual(events.sleeps, [3000, 3000]);
});
