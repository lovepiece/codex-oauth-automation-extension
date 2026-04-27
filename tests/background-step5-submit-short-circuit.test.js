const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/fill-profile.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundStep5;`)(globalScope);

test('step 5 forwards generated profile data and relies on completion signal flow', async () => {
  const events = {
    logs: [],
    messages: [],
  };

  const executor = api.createStep5Executor({
    addLog: async (message, level) => {
      events.logs.push({ message, level: level || 'info' });
    },
    generateRandomBirthday: () => ({ year: 2003, month: 6, day: 19 }),
    generateRandomName: () => ({ firstName: 'Test', lastName: 'User' }),
    sendToContentScript: async (source, message) => {
      events.messages.push({ source, message });
      return { accepted: true };
    },
  });

  await executor.executeStep5();

  assert.deepStrictEqual(events.messages, [
    {
      source: 'signup-page',
      message: {
        type: 'EXECUTE_STEP',
        step: 5,
        source: 'background',
        payload: {
          firstName: 'Test',
          lastName: 'User',
          year: 2003,
          month: 6,
          day: 19,
        },
      },
    },
  ]);
  assert.ok(events.logs.some(({ message }) => /已生成姓名 Test User/.test(message)));
});

test('step 5 skips profile form when signup tab already reached ChatGPT', async () => {
  const events = {
    completions: [],
    logs: [],
    messages: [],
  };

  const executor = api.createStep5Executor({
    addLog: async (message, level) => {
      events.logs.push({ message, level: level || 'info' });
    },
    chrome: {
      tabs: {
        get: async () => ({ url: 'https://chatgpt.com/' }),
      },
    },
    completeStepFromBackground: async (step, payload) => {
      events.completions.push({ step, payload });
    },
    generateRandomBirthday: () => {
      throw new Error('birthday should not be generated when step 5 is skipped');
    },
    generateRandomName: () => {
      throw new Error('name should not be generated when step 5 is skipped');
    },
    getTabId: async () => 123,
    isSignupEntryHost: (hostname) => ['chatgpt.com', 'chat.openai.com'].includes(hostname),
    sendToContentScript: async (source, message) => {
      events.messages.push({ source, message });
    },
  });

  await executor.executeStep5();

  assert.deepStrictEqual(events.messages, []);
  assert.deepStrictEqual(events.completions, [
    {
      step: 5,
      payload: {
        skipped: true,
        reason: 'already_on_chatgpt',
        url: 'https://chatgpt.com/',
      },
    },
  ]);
  assert.ok(events.logs.some(({ message }) => /无需填写姓名和生日/.test(message)));
});
