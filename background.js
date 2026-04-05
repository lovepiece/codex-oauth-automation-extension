// background.js — Service Worker: orchestration, state, tab management, message routing

importScripts('data/names.js');

const LOG_PREFIX = '[MultiPage:bg]';

// ============================================================
// State Management (chrome.storage.session)
// ============================================================

const DEFAULT_STATE = {
  currentStep: 0,
  stepStatuses: {
    1: 'pending', 2: 'pending', 3: 'pending', 4: 'pending', 5: 'pending',
    6: 'pending', 7: 'pending', 8: 'pending', 9: 'pending',
  },
  oauthUrl: null,
  email: null,
  password: 'mimashisha0.0',
  lastEmailTimestamp: null,
  localhostUrl: null,
  flowStartTime: null,
  tabRegistry: {},
  logs: [],
  vpsUrl: 'http://154.26.182.181:8317/management.html#/oauth',
  mailProvider: '163', // 'qq' or '163'
};

async function getState() {
  const state = await chrome.storage.session.get(null);
  return { ...DEFAULT_STATE, ...state };
}

async function setState(updates) {
  console.log(LOG_PREFIX, 'storage.set:', JSON.stringify(updates).slice(0, 200));
  await chrome.storage.session.set(updates);
}

async function resetState() {
  console.log(LOG_PREFIX, 'Resetting all state');
  await chrome.storage.session.clear();
  await chrome.storage.session.set({ ...DEFAULT_STATE });
}

// ============================================================
// Tab Registry
// ============================================================

async function getTabRegistry() {
  const state = await getState();
  return state.tabRegistry || {};
}

async function registerTab(source, tabId) {
  const registry = await getTabRegistry();
  registry[source] = { tabId, ready: true };
  await setState({ tabRegistry: registry });
  console.log(LOG_PREFIX, `Tab registered: ${source} -> ${tabId}`);
}

async function isTabAlive(source) {
  const registry = await getTabRegistry();
  const entry = registry[source];
  if (!entry) return false;
  try {
    await chrome.tabs.get(entry.tabId);
    return true;
  } catch {
    // Tab no longer exists — clean up registry
    registry[source] = null;
    await setState({ tabRegistry: registry });
    return false;
  }
}

async function getTabId(source) {
  const registry = await getTabRegistry();
  return registry[source]?.tabId || null;
}

// ============================================================
// Command Queue (for content scripts not yet ready)
// ============================================================

const pendingCommands = new Map(); // source -> { message, resolve, reject, timer }

function queueCommand(source, message, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(source);
      const err = `Content script on ${source} did not respond in ${timeout / 1000}s. Try refreshing the tab and retry.`;
      console.error(LOG_PREFIX, err);
      reject(new Error(err));
    }, timeout);
    pendingCommands.set(source, { message, resolve, reject, timer });
    console.log(LOG_PREFIX, `Command queued for ${source} (waiting for ready)`);
  });
}

function flushCommand(source, tabId) {
  const pending = pendingCommands.get(source);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(source);
    chrome.tabs.sendMessage(tabId, pending.message).then(pending.resolve).catch(pending.reject);
    console.log(LOG_PREFIX, `Flushed queued command to ${source} (tab ${tabId})`);
  }
}

// ============================================================
// Send command to content script (with readiness check)
// ============================================================

async function sendToContentScript(source, message) {
  const registry = await getTabRegistry();
  const entry = registry[source];

  if (!entry || !entry.ready) {
    console.log(LOG_PREFIX, `${source} not ready, queuing command`);
    return queueCommand(source, message);
  }

  // Verify tab is still alive
  const alive = await isTabAlive(source);
  if (!alive) {
    // Tab was closed — queue the command, it will be sent when tab is reopened
    console.log(LOG_PREFIX, `${source} tab was closed, queuing command`);
    return queueCommand(source, message);
  }

  console.log(LOG_PREFIX, `Sending to ${source} (tab ${entry.tabId}):`, message.type);
  return chrome.tabs.sendMessage(entry.tabId, message);
}

// ============================================================
// Logging
// ============================================================

async function addLog(message, level = 'info') {
  const state = await getState();
  const logs = state.logs || [];
  const entry = { message, level, timestamp: Date.now() };
  logs.push(entry);
  // Keep last 500 logs
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await setState({ logs });
  // Broadcast to side panel
  chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: entry }).catch(() => {});
}

// ============================================================
// Step Status Management
// ============================================================

async function setStepStatus(step, status) {
  const state = await getState();
  const statuses = { ...state.stepStatuses };
  statuses[step] = status;
  await setState({ stepStatuses: statuses, currentStep: step });
  // Broadcast to side panel
  chrome.runtime.sendMessage({
    type: 'STEP_STATUS_CHANGED',
    payload: { step, status },
  }).catch(() => {});
}

// ============================================================
// Message Handler (central router)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(LOG_PREFIX, `Received: ${message.type} from ${message.source || 'sidepanel'}`, message);

  handleMessage(message, sender).then(response => {
    sendResponse(response);
  }).catch(err => {
    console.error(LOG_PREFIX, 'Handler error:', err);
    sendResponse({ error: err.message });
  });

  return true; // async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CONTENT_SCRIPT_READY': {
      const tabId = sender.tab?.id;
      if (tabId && message.source) {
        await registerTab(message.source, tabId);
        flushCommand(message.source, tabId);
        await addLog(`Content script ready: ${message.source} (tab ${tabId})`);
      }
      return { ok: true };
    }

    case 'LOG': {
      const { message: msg, level } = message.payload;
      await addLog(`[${message.source}] ${msg}`, level);
      return { ok: true };
    }

    case 'STEP_COMPLETE': {
      await setStepStatus(message.step, 'completed');
      await addLog(`Step ${message.step} completed`, 'ok');
      await handleStepData(message.step, message.payload);
      notifyStepComplete(message.step, message.payload);
      return { ok: true };
    }

    case 'STEP_ERROR': {
      await setStepStatus(message.step, 'failed');
      await addLog(`Step ${message.step} failed: ${message.error}`, 'error');
      notifyStepError(message.step, message.error);
      return { ok: true };
    }

    case 'GET_STATE': {
      return await getState();
    }

    case 'RESET': {
      await resetState();
      await addLog('Flow reset', 'info');
      return { ok: true };
    }

    case 'EXECUTE_STEP': {
      const step = message.payload.step;
      // Save email if provided (from side panel step 3)
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      await executeStep(step);
      return { ok: true };
    }

    case 'AUTO_RUN': {
      const totalRuns = message.payload?.totalRuns || 1;
      autoRunLoop(totalRuns);  // fire-and-forget
      return { ok: true };
    }

    case 'RESUME_AUTO_RUN': {
      if (message.payload.email) {
        await setState({ email: message.payload.email });
      }
      resumeAutoRun();  // fire-and-forget
      return { ok: true };
    }

    case 'SAVE_SETTING': {
      const updates = {};
      if (message.payload.vpsUrl !== undefined) updates.vpsUrl = message.payload.vpsUrl;
      if (message.payload.mailProvider !== undefined) updates.mailProvider = message.payload.mailProvider;
      await setState(updates);
      return { ok: true };
    }

    // Side panel data updates
    case 'SAVE_EMAIL': {
      await setState({ email: message.payload.email });
      return { ok: true };
    }

    default:
      console.warn(LOG_PREFIX, `Unknown message type: ${message.type}`);
      return { error: `Unknown message type: ${message.type}` };
  }
}

// ============================================================
// Step Data Handlers
// ============================================================

async function handleStepData(step, payload) {
  switch (step) {
    case 1:
      if (payload.oauthUrl) {
        await setState({ oauthUrl: payload.oauthUrl });
        // Broadcast OAuth URL to side panel
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { oauthUrl: payload.oauthUrl },
        }).catch(() => {});
      }
      break;
    case 3:
      if (payload.email) await setState({ email: payload.email });
      break;
    case 4:
      if (payload.emailTimestamp) await setState({ lastEmailTimestamp: payload.emailTimestamp });
      break;
    case 8:
      if (payload.localhostUrl) {
        await setState({ localhostUrl: payload.localhostUrl });
        chrome.runtime.sendMessage({
          type: 'DATA_UPDATED',
          payload: { localhostUrl: payload.localhostUrl },
        }).catch(() => {});
      }
      break;
  }
}

// ============================================================
// Step Completion Waiting
// ============================================================

// Map of step -> { resolve, reject } for waiting on step completion
const stepWaiters = new Map();

function waitForStepComplete(step, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stepWaiters.delete(step);
      reject(new Error(`Step ${step} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    stepWaiters.set(step, {
      resolve: (data) => { clearTimeout(timer); stepWaiters.delete(step); resolve(data); },
      reject: (err) => { clearTimeout(timer); stepWaiters.delete(step); reject(err); },
    });
  });
}

function notifyStepComplete(step, payload) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.resolve(payload);
}

function notifyStepError(step, error) {
  const waiter = stepWaiters.get(step);
  if (waiter) waiter.reject(new Error(error));
}

// ============================================================
// Step Execution
// ============================================================

async function executeStep(step) {
  console.log(LOG_PREFIX, `Executing step ${step}`);
  await setStepStatus(step, 'running');
  await addLog(`Step ${step} started`);

  const state = await getState();

  // Set flow start time on first step
  if (step === 1 && !state.flowStartTime) {
    await setState({ flowStartTime: Date.now() });
  }

  try {
    switch (step) {
      case 1: await executeStep1(state); break;
      case 2: await executeStep2(state); break;
      case 3: await executeStep3(state); break;
      case 4: await executeStep4(state); break;
      case 5: await executeStep5(state); break;
      case 6: await executeStep6(state); break;
      case 7: await executeStep7(state); break;
      case 8: await executeStep8(state); break;
      case 9: await executeStep9(state); break;
      default:
        throw new Error(`Unknown step: ${step}`);
    }
  } catch (err) {
    await setStepStatus(step, 'failed');
    await addLog(`Step ${step} failed: ${err.message}`, 'error');
  }
}

/**
 * Execute a step and wait for it to complete before returning.
 * @param {number} step
 * @param {number} delayAfter - ms to wait after completion (for page transitions)
 */
async function executeStepAndWait(step, delayAfter = 2000) {
  const promise = waitForStepComplete(step, 120000);
  await executeStep(step);
  await promise;
  // Extra delay for page transitions / DOM updates
  if (delayAfter > 0) {
    await new Promise(r => setTimeout(r, delayAfter));
  }
}

// ============================================================
// Auto Run Flow
// ============================================================

let autoRunActive = false;
let autoRunCurrentRun = 0;
let autoRunTotalRuns = 1;

// Outer loop: runs the full flow N times
async function autoRunLoop(totalRuns) {
  if (autoRunActive) {
    await addLog('Auto run already in progress', 'warn');
    return;
  }

  autoRunActive = true;
  autoRunTotalRuns = totalRuns;
  await setState({ autoRunning: true });

  for (let run = 1; run <= totalRuns; run++) {
    autoRunCurrentRun = run;

    if (run > 1) {
      // Reset state for next run (keep vpsUrl, mailProvider settings)
      await addLog(`=== Resetting for run ${run}/${totalRuns} ===`, 'info');
      const state = await getState();
      const keepSettings = { vpsUrl: state.vpsUrl, mailProvider: state.mailProvider };
      await resetState();
      await setState(keepSettings);
      // Broadcast reset to side panel
      chrome.runtime.sendMessage({ type: 'AUTO_RUN_RESET' }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
    }

    await addLog(`=== Auto Run ${run}/${totalRuns} — Phase 1: Get OAuth link & open signup ===`, 'info');
    const status = (phase) => ({ type: 'AUTO_RUN_STATUS', payload: { phase, currentRun: run, totalRuns } });

    try {
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepAndWait(1, 2000);
      await executeStepAndWait(2, 2000);

      // Pause for email
      await addLog(`=== Run ${run}/${totalRuns} PAUSED: Paste DuckDuckGo email, click Continue ===`, 'warn');
      chrome.runtime.sendMessage(status('waiting_email')).catch(() => {});

      // Wait for RESUME_AUTO_RUN — sets a promise that resumeAutoRun resolves
      await waitForResume();

      const state = await getState();
      if (!state.email) {
        await addLog('Cannot resume: no email address.', 'error');
        break;
      }

      await addLog(`=== Run ${run}/${totalRuns} — Phase 2: Register, verify, login, complete ===`, 'info');
      chrome.runtime.sendMessage(status('running')).catch(() => {});

      await executeStepAndWait(3, 3000);
      await executeStepAndWait(4, 2000);
      await executeStepAndWait(5, 3000);
      await executeStepAndWait(6, 3000);
      await executeStepAndWait(7, 2000);
      await executeStepAndWait(8, 2000);
      await executeStepAndWait(9, 1000);

      await addLog(`=== Run ${run}/${totalRuns} COMPLETE! ===`, 'ok');

    } catch (err) {
      await addLog(`Run ${run}/${totalRuns} failed: ${err.message}`, 'error');
      chrome.runtime.sendMessage(status('stopped')).catch(() => {});
      break; // Stop on error
    }
  }

  await addLog(`=== All ${autoRunTotalRuns} runs finished ===`, 'ok');
  chrome.runtime.sendMessage({ type: 'AUTO_RUN_STATUS', payload: { phase: 'complete', currentRun: autoRunCurrentRun, totalRuns: autoRunTotalRuns } }).catch(() => {});
  autoRunActive = false;
  await setState({ autoRunning: false });
}

// Promise-based pause/resume mechanism
let resumeResolver = null;

function waitForResume() {
  return new Promise((resolve) => {
    resumeResolver = resolve;
  });
}

async function resumeAutoRun() {
  const state = await getState();
  if (!state.email) {
    await addLog('Cannot resume: no email address. Paste email in Side Panel first.', 'error');
    return;
  }
  if (resumeResolver) {
    resumeResolver();
    resumeResolver = null;
  }
}

// ============================================================
// Step 1: Get OAuth Link (via vps-panel.js)
// ============================================================

async function executeStep1(state) {
  const vpsUrl = state.vpsUrl;
  if (!vpsUrl) {
    throw new Error('No VPS URL configured. Enter VPS address in Side Panel first.');
  }

  // Ensure VPS panel tab is open
  const alive = await isTabAlive('vps-panel');
  if (!alive) {
    await addLog(`Step 1: Opening VPS panel: ${vpsUrl.slice(0, 60)}...`);
    const tab = await chrome.tabs.create({ url: vpsUrl, active: true });
    // Dynamically inject content scripts since VPS URL is configurable
    // Wait for page to load, then inject
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/utils.js', 'content/vps-panel.js'],
    });
  } else {
    const tabId = await getTabId('vps-panel');
    if (tabId) await chrome.tabs.update(tabId, { active: true });
  }

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 1,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 2: Open Signup Page (Background opens tab, signup-page.js clicks Register)
// ============================================================

async function executeStep2(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  await addLog(`Step 2: Opening auth URL in new tab: ${state.oauthUrl.slice(0, 80)}...`);
  const tab = await chrome.tabs.create({ url: state.oauthUrl, active: true });
  // signup-page.js will auto-inject via manifest content_scripts
  // Queue the command — it will flush when script sends READY signal
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 2,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Step 3: Fill Email & Password (via signup-page.js)
// ============================================================

async function executeStep3(state) {
  if (!state.email) {
    throw new Error('No email address. Paste email in Side Panel first.');
  }
  await addLog(`Step 3: Filling email ${state.email} and password`);
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 3,
    source: 'background',
    payload: { email: state.email },
  });
}

// ============================================================
// Step 4: Get Signup Verification Code (qq-mail.js polls, then fills in signup-page.js)
// ============================================================

function getMailConfig(state) {
  const provider = state.mailProvider || 'qq';
  if (provider === '163') {
    return { source: 'mail-163', url: 'https://mail.163.com/js6/main.jsp?df=mail163_letter#module=mbox.ListModule%7C%7B%22fid%22%3A1%2C%22order%22%3A%22date%22%2C%22desc%22%3Atrue%7D', label: '163 Mail' };
  }
  return { source: 'qq-mail', url: 'https://wx.mail.qq.com/', label: 'QQ Mail' };
}

async function executeStep4(state) {
  const mail = getMailConfig(state);

  const alive = await isTabAlive(mail.source);
  if (!alive) {
    await addLog(`Step 4: Opening ${mail.label}...`);
    await chrome.tabs.create({ url: mail.url, active: true });
  } else {
    const tabId = await getTabId(mail.source);
    if (tabId) await chrome.tabs.update(tabId, { active: true });
  }

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step: 4,
    source: 'background',
    payload: {
      filterAfterTimestamp: state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm'],
      maxAttempts: 20,
      intervalMs: 3000,
    },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  if (result && result.code) {
    await setState({ lastEmailTimestamp: result.emailTimestamp });
    await addLog(`Step 4: Got verification code: ${result.code}`);

    // Switch to signup tab and fill code
    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 4,
        source: 'background',
        payload: { code: result.code },
      });
    } else {
      throw new Error('Signup page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 5: Fill Name & Birthday (via signup-page.js)
// ============================================================

async function executeStep5(state) {
  const { firstName, lastName } = generateRandomName();
  const { year, month, day } = generateRandomBirthday();

  await addLog(`Step 5: Generated name: ${firstName} ${lastName}, Birthday: ${year}-${month}-${day}`);

  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 5,
    source: 'background',
    payload: { firstName, lastName, year, month, day },
  });
}

// ============================================================
// Step 6: Login ChatGPT (Background opens tab, chatgpt.js handles login)
// ============================================================

async function executeStep6(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }
  if (!state.email) {
    throw new Error('No email. Complete step 3 first.');
  }

  // Open the OAuth URL again in a new tab to start the login flow
  // Close the old signup tab first (it's on add-phone page, not needed)
  const oldSignupTabId = await getTabId('signup-page');
  if (oldSignupTabId) {
    try { await chrome.tabs.remove(oldSignupTabId); } catch {}
  }

  await addLog(`Step 6: Opening OAuth URL for login: ${state.oauthUrl.slice(0, 60)}...`);
  await chrome.tabs.create({ url: state.oauthUrl, active: true });

  // signup-page.js will inject (same auth.openai.com domain) and handle login
  await sendToContentScript('signup-page', {
    type: 'EXECUTE_STEP',
    step: 6,
    source: 'background',
    payload: { email: state.email, password: state.password || 'mimashisha0.0' },
  });
}

// ============================================================
// Step 7: Get Login Verification Code (qq-mail.js polls, then fills in chatgpt.js)
// ============================================================

async function executeStep7(state) {
  const mail = getMailConfig(state);

  const alive = await isTabAlive(mail.source);
  if (!alive) {
    await addLog(`Step 7: Opening ${mail.label}...`);
    await chrome.tabs.create({ url: mail.url, active: true });
  } else {
    const tabId = await getTabId(mail.source);
    if (tabId) await chrome.tabs.update(tabId, { active: true });
  }

  const result = await sendToContentScript(mail.source, {
    type: 'POLL_EMAIL',
    step: 7,
    source: 'background',
    payload: {
      filterAfterTimestamp: state.lastEmailTimestamp || state.flowStartTime || 0,
      senderFilters: ['openai', 'noreply', 'verify', 'auth', 'chatgpt'],
      subjectFilters: ['verify', 'verification', 'code', '验证', 'confirm', 'login'],
      maxAttempts: 20,
      intervalMs: 3000,
    },
  });

  if (result && result.error) {
    throw new Error(result.error);
  }

  if (result && result.code) {
    await addLog(`Step 7: Got login verification code: ${result.code}`);

    // Switch to signup/auth tab and fill code
    const signupTabId = await getTabId('signup-page');
    if (signupTabId) {
      await chrome.tabs.update(signupTabId, { active: true });
      await sendToContentScript('signup-page', {
        type: 'FILL_CODE',
        step: 7,
        source: 'background',
        payload: { code: result.code },
      });
    } else {
      throw new Error('Auth page tab was closed. Cannot fill verification code.');
    }
  }
}

// ============================================================
// Step 8: Complete OAuth (webNavigation listener + chatgpt.js navigates)
// ============================================================

let webNavListener = null;

async function executeStep8(state) {
  if (!state.oauthUrl) {
    throw new Error('No OAuth URL. Complete step 1 first.');
  }

  await addLog('Step 8: Setting up localhost redirect listener...');

  // Register webNavigation listener (scoped to this step)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (webNavListener) {
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
      }
      setStepStatus(8, 'failed');
      addLog('Step 8: Localhost redirect not captured after 30s. Check if OAuth authorization completed.', 'error');
      reject(new Error('Localhost redirect not captured after 30s. Check if OAuth authorization completed.'));
    }, 30000);

    webNavListener = (details) => {
      if (details.url.startsWith('http://localhost')) {
        console.log(LOG_PREFIX, `Captured localhost redirect: ${details.url}`);
        chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
        webNavListener = null;
        clearTimeout(timeout);

        setState({ localhostUrl: details.url }).then(() => {
          addLog(`Step 8: Captured localhost URL: ${details.url}`, 'ok');
          setStepStatus(8, 'completed');
          notifyStepComplete(8, { localhostUrl: details.url });
          chrome.runtime.sendMessage({
            type: 'DATA_UPDATED',
            payload: { localhostUrl: details.url },
          }).catch(() => {});
          resolve();
        });
      }
    };

    chrome.webNavigation.onBeforeNavigate.addListener(webNavListener);

    // After step 7, the auth page shows a consent screen ("使用 ChatGPT 登录到 Codex")
    // with a "继续" button. We need to click it, which triggers the localhost redirect.
    (async () => {
      try {
        const signupTabId = await getTabId('signup-page');
        if (signupTabId) {
          await chrome.tabs.update(signupTabId, { active: true });
          await addLog('Step 8: Switching to auth page, clicking "继续" to complete OAuth...');
          await sendToContentScript('signup-page', {
            type: 'EXECUTE_STEP',
            step: 8,
            source: 'background',
            payload: {},
          });
        } else {
          // Auth tab was closed, reopen OAuth URL
          await chrome.tabs.create({ url: state.oauthUrl, active: true });
          await addLog('Step 8: Auth tab closed, reopening OAuth URL...');
          await sendToContentScript('signup-page', {
            type: 'EXECUTE_STEP',
            step: 8,
            source: 'background',
            payload: {},
          });
        }
      } catch (err) {
        clearTimeout(timeout);
        if (webNavListener) {
          chrome.webNavigation.onBeforeNavigate.removeListener(webNavListener);
          webNavListener = null;
        }
        reject(err);
      }
    })();
  });
}

// ============================================================
// Step 9: VPS Verify (via vps-panel.js)
// ============================================================

async function executeStep9(state) {
  if (!state.localhostUrl) {
    throw new Error('No localhost URL. Complete step 8 first.');
  }

  const vpsUrl = state.vpsUrl || 'http://154.26.182.181:8317/management.html#/oauth';

  // Switch to VPS panel tab
  const alive = await isTabAlive('vps-panel');
  if (!alive) {
    await addLog('Step 9: Opening VPS panel...');
    const tab = await chrome.tabs.create({ url: vpsUrl, active: true });
    await new Promise(resolve => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/utils.js', 'content/vps-panel.js'],
    });
  } else {
    const tabId = await getTabId('vps-panel');
    if (tabId) await chrome.tabs.update(tabId, { active: true });
  }

  await sendToContentScript('vps-panel', {
    type: 'EXECUTE_STEP',
    step: 9,
    source: 'background',
    payload: {},
  });
}

// ============================================================
// Open Side Panel on extension icon click
// ============================================================

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
