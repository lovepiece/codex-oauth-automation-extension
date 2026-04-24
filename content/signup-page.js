// content/signup-page.js — Content script for ChatGPT signup entry + OpenAI auth pages
// Injected on: auth0.openai.com, auth.openai.com, accounts.openai.com
// Dynamically injected on: chatgpt.com

console.log('[MultiPage:signup-page] Content script loaded on', location.href);

const SIGNUP_PAGE_LISTENER_SENTINEL = 'data-multipage-signup-page-listener';

if (document.documentElement.getAttribute(SIGNUP_PAGE_LISTENER_SENTINEL) !== '1') {
  document.documentElement.setAttribute(SIGNUP_PAGE_LISTENER_SENTINEL, '1');

  // Listen for commands from Background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message.type === 'EXECUTE_STEP'
      || message.type === 'FILL_CODE'
      || message.type === 'STEP8_FIND_AND_CLICK'
      || message.type === 'STEP8_GET_STATE'
      || message.type === 'STEP8_TRIGGER_CONTINUE'
      || message.type === 'GET_LOGIN_AUTH_STATE'
      || message.type === 'PREPARE_SIGNUP_VERIFICATION'
      || message.type === 'RECOVER_AUTH_RETRY_PAGE'
      || message.type === 'RESEND_VERIFICATION_CODE'
      || message.type === 'ENSURE_SIGNUP_ENTRY_READY'
      || message.type === 'ENSURE_SIGNUP_PASSWORD_PAGE_READY'
    ) {
      resetStopState();
      handleCommand(message).then((result) => {
        sendResponse({ ok: true, ...(result || {}) });
      }).catch(err => {
        if (isStopError(err)) {
          if (message.step) {
            log(`步骤 ${message.step || 8}：已被用户停止。`, 'warn');
          }
          sendResponse({ stopped: true, error: err.message });
          return;
        }

        if (message.type === 'STEP8_FIND_AND_CLICK') {
          log(`步骤 9：${err.message}`, 'error');
          sendResponse({ error: err.message });
          return;
        }

        if (message.step) {
          reportError(message.step, err.message);
        }
        sendResponse({ error: err.message });
      });
      return true;
    }
  });
} else {
  console.log('[MultiPage:signup-page] 消息监听已存在，跳过重复注册');
}

async function handleCommand(message) {
  switch (message.type) {
    case 'EXECUTE_STEP':
      switch (message.step) {
        case 2: return await step2_clickRegister(message.payload);
        case 3: return await step3_fillEmailPassword(message.payload);
        case 5: return await step5_fillNameBirthday(message.payload);
        case 7: return await step6_login(message.payload);
        case 9: return await step8_findAndClick();
        default: throw new Error(`signup-page.js 不处理步骤 ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'GET_LOGIN_AUTH_STATE':
      return serializeLoginAuthState(inspectLoginAuthState());
    case 'PREPARE_SIGNUP_VERIFICATION':
      return await prepareSignupVerificationFlow(message.payload);
    case 'RECOVER_AUTH_RETRY_PAGE':
      return await recoverCurrentAuthRetryPage(message.payload);
    case 'RESEND_VERIFICATION_CODE':
      return await resendVerificationCode(message.step);
    case 'ENSURE_SIGNUP_ENTRY_READY':
      return await ensureSignupEntryReady();
    case 'ENSURE_SIGNUP_PASSWORD_PAGE_READY':
      return await ensureSignupPasswordPageReady();
    case 'GET_PHONE_VERIFICATION_STATE':
      return serializePhoneVerificationState(inspectPhoneVerificationState());
    case 'SUBMIT_PHONE_NUMBER':
      return await submitPhoneNumber(message.payload);
    case 'FILL_PHONE_VERIFICATION_CODE':
      return await fillPhoneVerificationCode(message.payload);
    case 'RESEND_PHONE_VERIFICATION_CODE':
      return await resendPhoneVerificationCode();
    case 'CLICK_PHONE_VERIFICATION_RETRY':
      return await clickPhoneVerificationRetry(message.payload);
    case 'GO_BACK_TO_PHONE_NUMBER_ENTRY':
      return await goBackToPhoneNumberEntry(message.payload);
    case 'STEP8_FIND_AND_CLICK':
      return await step8_findAndClick();
    case 'STEP8_GET_STATE':
      return getStep8State();
    case 'STEP8_TRIGGER_CONTINUE':
      return await step8_triggerContinue(message.payload);
  }
}

const VERIFICATION_CODE_INPUT_SELECTOR = [
  'input[name="code"]',
  'input[name="otp"]',
  'input[autocomplete="one-time-code"]',
  'input[type="text"][maxlength="6"]',
  'input[type="tel"][maxlength="6"]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[inputmode="numeric"]',
].join(', ');

const ONE_TIME_CODE_LOGIN_PATTERN = /使用一次性验证码登录|改用(?:一次性)?验证码(?:登录)?|使用验证码登录|一次性验证码|验证码登录|one[-\s]*time\s*(?:passcode|password|code)|use\s+(?:a\s+)?one[-\s]*time\s*(?:passcode|password|code)(?:\s+instead)?|use\s+(?:a\s+)?code(?:\s+instead)?|sign\s+in\s+with\s+(?:email|code)|email\s+(?:me\s+)?(?:a\s+)?code/i;

const RESEND_VERIFICATION_CODE_PATTERN = /重新发送(?:验证码)?|再次发送(?:验证码)?|重发(?:验证码)?|未收到(?:验证码|邮件)|resend(?:\s+code)?|send\s+(?:a\s+)?new\s+code|send\s+(?:it\s+)?again|request\s+(?:a\s+)?new\s+code|didn'?t\s+receive/i;

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && rect.width > 0
    && rect.height > 0;
}

function getVisibleSplitVerificationInputs() {
  return Array.from(document.querySelectorAll('input[maxlength="1"]'))
    .filter(isVisibleElement);
}

function getVerificationCodeTarget() {
  const splitInputs = getVisibleSplitVerificationInputs();
  const codeInput = document.querySelector(VERIFICATION_CODE_INPUT_SELECTOR);
  if (codeInput && isVisibleElement(codeInput)) {
    const maxLength = Number(codeInput.getAttribute?.('maxlength') || codeInput.maxLength || 0);
    if (maxLength === 1 && splitInputs.length >= 6) {
      return { type: 'split', elements: splitInputs };
    }
    return { type: 'single', element: codeInput };
  }

  if (splitInputs.length >= 6) {
    return { type: 'split', elements: splitInputs };
  }

  return null;
}

function getActionText(el) {
  return [
    el?.textContent,
    el?.value,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isActionEnabled(el) {
  return Boolean(el)
    && !el.disabled
    && el.getAttribute('aria-disabled') !== 'true';
}

function findOneTimeCodeLoginTrigger() {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );

  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;

    const text = [
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text && ONE_TIME_CODE_LOGIN_PATTERN.test(text)) {
      return el;
    }
  }

  return null;
}

function findResendVerificationCodeTrigger({ allowDisabled = false } = {}) {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );

  for (const el of candidates) {
    if (!isVisibleElement(el)) continue;
    if (!allowDisabled && !isActionEnabled(el)) continue;

    const text = getActionText(el);
    if (text && RESEND_VERIFICATION_CODE_PATTERN.test(text)) {
      return el;
    }
  }

  return null;
}

function isEmailVerificationPage() {
  return /\/email-verification(?:[/?#]|$)/i.test(location.pathname || '');
}

async function resendVerificationCode(step, timeout = 45000) {
  if (step === 8) {
    await waitForLoginVerificationPageReady();
  }

  const start = Date.now();
  let action = null;
  let loggedWaiting = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();

    // Check for 405 error page and recover by clicking "Try again"
    if (is405MethodNotAllowedPage()) {
      await handle405ResendError(step, timeout - (Date.now() - start));
      // After recovery, loop back to find the resend button again
      loggedWaiting = false;
      continue;
    }

    action = findResendVerificationCodeTrigger({ allowDisabled: true });

    if (action && isActionEnabled(action)) {
      log(`步骤 ${step}：重新发送验证码按钮已可用。`);
      await humanPause(350, 900);
      simulateClick(action);
      await sleep(1200);

      // After clicking resend, check if 405 error appeared
      if (is405MethodNotAllowedPage()) {
        log(`步骤 ${step}：点击重新发送后出现 405 错误，正在恢复...`, 'warn');
        await handle405ResendError(step, timeout - (Date.now() - start));
        loggedWaiting = false;
        continue;
      }

      return {
        resent: true,
        buttonText: getActionText(action),
      };
    }

    if (action && !loggedWaiting) {
      loggedWaiting = true;
      log(`步骤 ${step}：正在等待重新发送验证码按钮变为可点击...`);
    }

    await sleep(250);
  }

  throw new Error('无法点击重新发送验证码按钮。URL: ' + location.href);
}

function is405MethodNotAllowedPage() {
  const pageText = document.body?.textContent || '';
  return AUTH_ROUTE_ERROR_PATTERN.test(pageText);
}

async function handle405ResendError(step, remainingTimeout = 30000) {
  await recoverCurrentAuthRetryPage({
    logLabel: `步骤 ${step}：检测到 405 错误页面，正在点击“重试”恢复`,
    pathPatterns: [],
    step,
    timeoutMs: Math.max(1000, remainingTimeout),
  });
  log(`步骤 ${step}：405 错误已恢复，页面已返回验证码页面。`);
}

// ============================================================
// Signup Entry Helpers
// ============================================================

const SIGNUP_ENTRY_TRIGGER_PATTERN = /免费注册|立即注册|注册|sign\s*up|register|create\s*account|create\s+account/i;
const SIGNUP_EMAIL_INPUT_SELECTOR = 'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i]';

function getSignupEmailInput() {
  const input = document.querySelector(SIGNUP_EMAIL_INPUT_SELECTOR);
  return input && isVisibleElement(input) ? input : null;
}

function getSignupEmailContinueButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    return /continue|next|submit|继续|下一步/i.test(getActionText(el));
  }) || null;
}

function findSignupEntryTrigger() {
  const candidates = document.querySelectorAll('a, button, [role="button"], [role="link"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || !isActionEnabled(el)) return false;
    return SIGNUP_ENTRY_TRIGGER_PATTERN.test(getActionText(el));
  }) || null;
}

function getSignupPasswordDisplayedEmail() {
  const text = (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig);
  return matches?.[0] ? String(matches[0]).trim().toLowerCase() : '';
}

function inspectSignupEntryState() {
  const passwordInput = getSignupPasswordInput();
  if (isSignupPasswordPage() && passwordInput) {
    return {
      state: 'password_page',
      passwordInput,
      submitButton: getSignupPasswordSubmitButton({ allowDisabled: true }),
      displayedEmail: getSignupPasswordDisplayedEmail(),
      url: location.href,
    };
  }

  const emailInput = getSignupEmailInput();
  if (emailInput) {
    return {
      state: 'email_entry',
      emailInput,
      continueButton: getSignupEmailContinueButton({ allowDisabled: true }),
      url: location.href,
    };
  }

  const signupTrigger = findSignupEntryTrigger();
  if (signupTrigger) {
    return {
      state: 'entry_home',
      signupTrigger,
      url: location.href,
    };
  }

  return {
    state: 'unknown',
    url: location.href,
  };
}

function getSignupEntryStateSummary(snapshot = inspectSignupEntryState()) {
  const summary = {
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    hasEmailInput: Boolean(snapshot?.emailInput || getSignupEmailInput()),
    hasPasswordInput: Boolean(snapshot?.passwordInput || getSignupPasswordInput()),
  };

  if (snapshot?.displayedEmail) {
    summary.displayedEmail = snapshot.displayedEmail;
  }

  if (snapshot?.signupTrigger) {
    summary.signupTrigger = {
      tag: (snapshot.signupTrigger.tagName || '').toLowerCase(),
      text: getActionText(snapshot.signupTrigger).slice(0, 80),
    };
  }

  if (snapshot?.continueButton) {
    summary.continueButton = {
      tag: (snapshot.continueButton.tagName || '').toLowerCase(),
      text: getActionText(snapshot.continueButton).slice(0, 80),
      enabled: isActionEnabled(snapshot.continueButton),
    };
  }

  return summary;
}

function getSignupEntryDiagnostics() {
  const view = typeof window !== 'undefined' ? window : globalThis;
  const safeGetComputedStyle = (el) => {
    if (!el || typeof view?.getComputedStyle !== 'function') {
      return null;
    }
    try {
      return view.getComputedStyle(el);
    } catch {
      return null;
    }
  };
  const buildRectSummary = (el) => {
    const rect = typeof el?.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : null;
    return rect
      ? {
          width: Math.round(rect.width || 0),
          height: Math.round(rect.height || 0),
        }
      : null;
  };
  const buildVisibilityMeta = (el) => {
    const style = safeGetComputedStyle(el);
    return {
      className: String(el?.className || '').slice(0, 200),
      hidden: Boolean(el?.hidden),
      ariaHidden: el?.getAttribute?.('aria-hidden') || '',
      inert: typeof el?.hasAttribute === 'function' ? el.hasAttribute('inert') : false,
      display: style?.display || '',
      visibility: style?.visibility || '',
      opacity: style?.opacity || '',
      pointerEvents: style?.pointerEvents || '',
    };
  };
  const findBlockingAncestor = (el) => {
    let current = el?.parentElement || null;
    while (current) {
      const style = safeGetComputedStyle(current);
      const rect = buildRectSummary(current);
      const hidden = Boolean(current.hidden);
      const ariaHidden = current.getAttribute?.('aria-hidden') || '';
      const inert = typeof current.hasAttribute === 'function' ? current.hasAttribute('inert') : false;
      const blockedByStyle = Boolean(
        style
        && (
          style.display === 'none'
          || style.visibility === 'hidden'
          || style.opacity === '0'
          || style.pointerEvents === 'none'
        )
      );
      const blockedByRect = Boolean(rect && (rect.width === 0 || rect.height === 0));
      if (hidden || ariaHidden === 'true' || inert || blockedByStyle || blockedByRect) {
        return {
          tag: (current.tagName || '').toLowerCase(),
          id: current.id || '',
          className: String(current.className || '').slice(0, 200),
          hidden,
          ariaHidden,
          inert,
          display: style?.display || '',
          visibility: style?.visibility || '',
          opacity: style?.opacity || '',
          pointerEvents: style?.pointerEvents || '',
          rect,
        };
      }
      current = current.parentElement;
    }
    return null;
  };
  const actionCandidates = document.querySelectorAll(
    'a, button, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  const allActions = Array.from(actionCandidates).map((el) => {
    const text = getActionText(el);
    return {
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      text: text.slice(0, 80),
      visible: isVisibleElement(el),
      enabled: isActionEnabled(el),
      rect: buildRectSummary(el),
    };
  });
  const visibleActions = Array.from(actionCandidates)
    .filter(isVisibleElement)
    .slice(0, 12)
    .map((el) => ({
      tag: (el.tagName || '').toLowerCase(),
      type: el.getAttribute?.('type') || '',
      text: getActionText(el).slice(0, 80),
      enabled: isActionEnabled(el),
    }))
    .filter((item) => item.text);
  const signupLikeActions = Array.from(actionCandidates)
    .map((el) => {
      const text = getActionText(el);
      return {
        tag: (el.tagName || '').toLowerCase(),
        type: el.getAttribute?.('type') || '',
        text: text.slice(0, 80),
        visible: isVisibleElement(el),
        enabled: isActionEnabled(el),
        rect: buildRectSummary(el),
        ...buildVisibilityMeta(el),
        blockingAncestor: findBlockingAncestor(el),
      };
    })
    .filter((item) => item.text && SIGNUP_ENTRY_TRIGGER_PATTERN.test(item.text))
    .slice(0, 12);

  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState || '',
    viewport: {
      innerWidth: Math.round(Number(view?.innerWidth) || 0),
      innerHeight: Math.round(Number(view?.innerHeight) || 0),
      outerWidth: Math.round(Number(view?.outerWidth) || 0),
      outerHeight: Math.round(Number(view?.outerHeight) || 0),
      devicePixelRatio: Number(view?.devicePixelRatio) || 0,
    },
    hasEmailInput: Boolean(getSignupEmailInput()),
    hasPasswordInput: Boolean(getSignupPasswordInput()),
    bodyContainsSignupText: SIGNUP_ENTRY_TRIGGER_PATTERN.test(getPageTextSnapshot()),
    signupLikeActionCounts: {
      total: signupLikeActions.length,
      visible: signupLikeActions.filter((item) => item.visible).length,
      hidden: signupLikeActions.filter((item) => !item.visible).length,
    },
    signupLikeActions,
    visibleActions,
    bodyTextPreview: getPageTextSnapshot().slice(0, 240),
  };
}

function getSignupPasswordDiagnostics() {
  const view = typeof window !== 'undefined' ? window : globalThis;
  const safeGetComputedStyle = (el) => {
    if (!el || typeof view?.getComputedStyle !== 'function') {
      return null;
    }
    try {
      return view.getComputedStyle(el);
    } catch {
      return null;
    }
  };
  const buildRectSummary = (el) => {
    const rect = typeof el?.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : null;
    return rect
      ? {
          width: Math.round(rect.width || 0),
          height: Math.round(rect.height || 0),
        }
      : null;
  };
  const buildInputSummary = (el) => {
    const style = safeGetComputedStyle(el);
    return {
      tag: (el?.tagName || '').toLowerCase(),
      type: el?.getAttribute?.('type') || el?.type || '',
      name: el?.getAttribute?.('name') || el?.name || '',
      id: el?.id || '',
      autocomplete: el?.getAttribute?.('autocomplete') || '',
      placeholder: String(el?.getAttribute?.('placeholder') || '').slice(0, 80),
      visible: isVisibleElement(el),
      enabled: isActionEnabled(el),
      valueLength: String(el?.value || '').length,
      rect: buildRectSummary(el),
      className: String(el?.className || '').slice(0, 200),
      display: style?.display || '',
      visibility: style?.visibility || '',
      opacity: style?.opacity || '',
      pointerEvents: style?.pointerEvents || '',
      formAction: el?.form?.action || '',
    };
  };
  const buildActionSummary = (el) => {
    const style = safeGetComputedStyle(el);
    return {
      tag: (el?.tagName || '').toLowerCase(),
      type: el?.getAttribute?.('type') || el?.type || '',
      role: el?.getAttribute?.('role') || '',
      text: getActionText(el).slice(0, 120),
      visible: isVisibleElement(el),
      enabled: isActionEnabled(el),
      rect: buildRectSummary(el),
      className: String(el?.className || '').slice(0, 200),
      display: style?.display || '',
      visibility: style?.visibility || '',
      opacity: style?.opacity || '',
      pointerEvents: style?.pointerEvents || '',
      dataDdActionName: el?.getAttribute?.('data-dd-action-name') || '',
      formAction: el?.form?.action || '',
    };
  };
  const passwordInputs = Array.from(document.querySelectorAll(
    'input[type="password"], input[name*="password" i], input[autocomplete="new-password"], input[autocomplete="current-password"]'
  ))
    .map(buildInputSummary)
    .slice(0, 8);
  const actionCandidates = Array.from(document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  ))
    .map(buildActionSummary)
    .filter((item) => item.text)
    .slice(0, 16);
  const visibleActions = actionCandidates.filter((item) => item.visible).slice(0, 12);
  const submitButton = getSignupPasswordSubmitButton({ allowDisabled: true });
  const oneTimeCodeTrigger = findOneTimeCodeLoginTrigger();
  const retryState = getSignupPasswordTimeoutErrorPageState();

  return {
    url: location.href,
    title: document.title || '',
    readyState: document.readyState || '',
    displayedEmail: getSignupPasswordDisplayedEmail(),
    hasVisiblePasswordInput: Boolean(getSignupPasswordInput()),
    passwordInputCount: passwordInputs.length,
    visiblePasswordInputCount: passwordInputs.filter((item) => item.visible).length,
    passwordInputs,
    submitButton: submitButton ? buildActionSummary(submitButton) : null,
    oneTimeCodeTrigger: oneTimeCodeTrigger ? buildActionSummary(oneTimeCodeTrigger) : null,
    retryPage: Boolean(retryState),
    retryEnabled: Boolean(retryState?.retryEnabled),
    userAlreadyExistsBlocked: Boolean(retryState?.userAlreadyExistsBlocked),
    visibleActions,
    bodyTextPreview: getPageTextSnapshot().slice(0, 240),
  };
}

function logSignupPasswordDiagnostics(context, level = 'warn') {
  try {
    log(`${context}：密码页诊断快照：${JSON.stringify(getSignupPasswordDiagnostics())}`, level);
  } catch (error) {
    console.warn('[MultiPage:signup-page] failed to build signup password diagnostics:', error?.message || error);
  }
}

async function waitForSignupEntryState(options = {}) {
  const {
    timeout = 15000,
    autoOpenEntry = false,
    step = 2,
    logDiagnostics = false,
  } = options;
  const start = Date.now();
  let lastTriggerClickAt = 0;
  let clickAttempts = 0;
  let lastState = '';
  let slowSnapshotLogged = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectSignupEntryState();

    if (logDiagnostics && snapshot.state !== lastState) {
      lastState = snapshot.state;
      log(`步骤 ${step}：注册入口状态切换为 ${snapshot.state}，状态快照：${JSON.stringify(getSignupEntryStateSummary(snapshot))}`);
    }

    if (snapshot.state === 'password_page' || snapshot.state === 'email_entry') {
      return snapshot;
    }

    if (snapshot.state === 'entry_home') {
      if (!autoOpenEntry) {
        return snapshot;
      }

      if (Date.now() - lastTriggerClickAt >= 1500) {
        lastTriggerClickAt = Date.now();
        clickAttempts += 1;
        if (logDiagnostics) {
          log(`步骤 ${step}：正在点击官网注册入口（第 ${clickAttempts} 次）："${getActionText(snapshot.signupTrigger).slice(0, 80)}"`);
        }
        log('步骤 2：正在点击官网注册入口...');
        await humanPause(350, 900);
        simulateClick(snapshot.signupTrigger);
      }
    }

    if (logDiagnostics && !slowSnapshotLogged && Date.now() - start >= 5000) {
      slowSnapshotLogged = true;
      log(`步骤 ${step}：等待注册入口超过 5 秒，页面诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
    }

    await sleep(250);
  }

  const finalSnapshot = inspectSignupEntryState();
  if (logDiagnostics) {
    log(`步骤 ${step}：等待注册入口状态超时，最终状态快照：${JSON.stringify(getSignupEntryStateSummary(finalSnapshot))}`, 'warn');
  }
  return finalSnapshot;
}

async function ensureSignupEntryReady(timeout = 15000) {
  const snapshot = await waitForSignupEntryState({ timeout, autoOpenEntry: false });
  if (snapshot.state === 'entry_home' || snapshot.state === 'email_entry' || snapshot.state === 'password_page') {
    return {
      ready: true,
      state: snapshot.state,
      url: snapshot.url || location.href,
    };
  }

  log(`注册入口识别失败，诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
  throw new Error('当前页面没有可用的注册入口，也不在邮箱/密码页。URL: ' + location.href);
}

async function ensureSignupPasswordPageReady(timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const passwordInput = getSignupPasswordInput();
    if (isSignupPasswordPage() && passwordInput) {
      return {
        ready: true,
        state: 'password_page',
        url: location.href,
      };
    }
    await sleep(200);
  }

  throw new Error('等待进入密码页超时。URL: ' + location.href);
}

async function fillSignupEmailAndContinue(email, step) {
  if (!email) throw new Error(`未提供邮箱地址，步骤 ${step} 无法继续。`);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const snapshot = await waitForSignupEntryState({
    timeout: 20000,
    autoOpenEntry: true,
    step,
    logDiagnostics: step === 2,
  });

  if (snapshot.state === 'password_page') {
    if (snapshot.displayedEmail && snapshot.displayedEmail !== normalizedEmail) {
      throw new Error(`步骤 ${step}：当前密码页邮箱为 ${snapshot.displayedEmail}，与目标邮箱 ${email} 不一致，请先回到步骤 1 重新开始。`);
    }
    log(`步骤 ${step}：当前已在密码页，无需重复提交邮箱。`);
    return {
      alreadyOnPasswordPage: true,
      url: snapshot.url || location.href,
    };
  }

  if (snapshot.state !== 'email_entry' || !snapshot.emailInput) {
    if (step === 2) {
      log(`步骤 ${step}：未进入邮箱输入页，最终页面诊断快照：${JSON.stringify(getSignupEntryDiagnostics())}`, 'warn');
    }
    throw new Error(`步骤 ${step}：未找到可用的邮箱输入入口。URL: ${location.href}`);
  }

  log(`步骤 ${step}：正在填写邮箱：${email}`);
  await humanPause(500, 1400);
  fillInput(snapshot.emailInput, email);
  log(`步骤 ${step}：邮箱已填写`);

  const continueButton = snapshot.continueButton || getSignupEmailContinueButton({ allowDisabled: true });
  if (!continueButton || !isActionEnabled(continueButton)) {
    throw new Error(`步骤 ${step}：未找到可点击的“继续”按钮。URL: ${location.href}`);
  }

  log(`步骤 ${step}：邮箱已准备提交，正在前往密码页...`);
  window.setTimeout(() => {
    try {
      throwIfStopped();
      simulateClick(continueButton);
    } catch (error) {
      if (!isStopError(error)) {
        console.error('[MultiPage:signup-page] deferred signup email submit failed:', error?.message || error);
      }
    }
  }, 120);

  return {
    submitted: true,
    email,
    url: location.href,
  };
}

// ============================================================
// Step 2: Click Register, fill email, then continue to password page
// ============================================================

async function step2_clickRegister(payload = {}) {
  const { email } = payload;
  return fillSignupEmailAndContinue(email, 2);
}

// ============================================================
// Step 3: Fill Password
// ============================================================

async function step3_fillEmailPassword(payload) {
  const { email, password } = payload;
  if (!password) throw new Error('未提供密码，步骤 3 需要可用密码。');
  const normalizedEmail = String(email || '').trim().toLowerCase();

  let snapshot = inspectSignupEntryState();
  if (snapshot.state === 'entry_home') {
    throw new Error('当前仍停留在 ChatGPT 官网首页，请先完成步骤 2。');
  }

  if (snapshot.state === 'email_entry') {
    const transition = await fillSignupEmailAndContinue(email, 3);
    if (!transition.alreadyOnPasswordPage) {
      await sleep(1200);
      await ensureSignupPasswordPageReady();
    }
    snapshot = inspectSignupEntryState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    await ensureSignupPasswordPageReady();
    snapshot = inspectSignupEntryState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    logSignupPasswordDiagnostics('步骤 3：未能识别可填写的密码输入框');
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    throw new Error('在密码页未找到密码输入框。URL: ' + location.href);
  }
  if (normalizedEmail && snapshot.displayedEmail && snapshot.displayedEmail !== normalizedEmail) {
    throw new Error(`当前密码页邮箱为 ${snapshot.displayedEmail}，与目标邮箱 ${email} 不一致，请先回到步骤 1 重新开始。`);
  }

  await humanPause(600, 1500);
  fillInput(snapshot.passwordInput, password);
  log('步骤 3：密码已填写');

  const submitBtn = snapshot.submitButton
    || getSignupPasswordSubmitButton({ allowDisabled: true })
    || await waitForElementByText('button', /continue|sign\s*up|submit|注册|创建|create/i, 5000).catch(() => null);

  if (!submitBtn) {
    logSignupPasswordDiagnostics('步骤 3：未找到可提交的密码页按钮');
  } else if (typeof findOneTimeCodeLoginTrigger === 'function' && findOneTimeCodeLoginTrigger()) {
    logSignupPasswordDiagnostics('步骤 3：当前密码页同时存在一次性验证码入口', 'info');
  }

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  const signupVerificationRequestedAt = submitBtn ? Date.now() : null;
  const completionPayload = {
    email,
    signupVerificationRequestedAt,
    deferredSubmit: Boolean(submitBtn),
  };
  reportComplete(3, completionPayload);

  if (submitBtn) {
    window.setTimeout(async () => {
      try {
        throwIfStopped();
        await sleep(500);
        await humanPause(500, 1300);
        simulateClick(submitBtn);
        log('步骤 3：表单已提交');
      } catch (error) {
        if (!isStopError(error)) {
          console.error('[MultiPage:signup-page] deferred step 3 submit failed:', error?.message || error);
        }
      }
    }, 120);
  }

  return completionPayload;
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

const INVALID_VERIFICATION_CODE_PATTERN = /代码不正确|验证码不正确|验证码错误|code\s+(?:is\s+)?incorrect|invalid\s+code|incorrect\s+code|try\s+again/i;
const VERIFICATION_PAGE_PATTERN = /检查您的收件箱|输入我们刚刚向|重新发送电子邮件|重新发送验证码|代码不正确|email\s+verification|check\s+your\s+inbox|enter\s+the\s+code|we\s+just\s+sent|we\s+emailed|resend/i;
const OAUTH_CONSENT_PAGE_PATTERN = /使用\s*ChatGPT\s*登录到\s*Codex|sign\s+in\s+to\s+codex(?:\s+with\s+chatgpt)?|login\s+to\s+codex|log\s+in\s+to\s+codex|authorize|授权/i;
const OAUTH_CONSENT_FORM_SELECTOR = 'form[action*="/sign-in-with-chatgpt/" i][action*="/consent" i]';
const CONTINUE_ACTION_PATTERN = /继续|continue/i;
const ADD_PHONE_PAGE_PATTERN = /add[\s-]*phone|添加手机号|手机号码|手机号|phone\s+number|telephone/i;
const PHONE_VERIFICATION_PAGE_PATTERN = /查看你的手机|输入我们刚刚向|重新发送短信|phone\s+verification|verify\s+your\s+phone|texted\s+you\s+a\s+code/i;
const PHONE_MAX_USAGE_EXCEEDED_PATTERN = /phone_max_usage_exceeded/i;
const PHONE_RESEND_RATE_LIMIT_PATTERN = /尝试重新发送的次数过多。?\s*请稍后重试。?|too\s+many\s+(?:times\s+to\s+)?resend|too\s+many\s+resend\s+attempts?/i;
const PHONE_SMS_UNAVAILABLE_PATTERN = /无法向此电话号码发送短信|unable\s+to\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number|cannot\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number/i;
const STEP5_SUBMIT_ERROR_PATTERN = /无法根据该信息创建帐户|请重试|unable\s+to\s+create\s+(?:your\s+)?account|couldn'?t\s+create\s+(?:your\s+)?account|something\s+went\s+wrong|invalid\s+(?:birthday|birth|date)|生日|出生日期/i;
const AUTH_TIMEOUT_ERROR_TITLE_PATTERN = /糟糕，出错了|something\s+went\s+wrong|oops/i;
const AUTH_TIMEOUT_ERROR_DETAIL_PATTERN = /operation\s+timed\s+out|timed\s+out|请求超时|操作超时/i;
const AUTH_ROUTE_ERROR_PATTERN = /405\s+method\s+not\s+allowed|route\s+error.*405/i;
const SIGNUP_USER_ALREADY_EXISTS_ERROR_PREFIX = 'SIGNUP_USER_ALREADY_EXISTS::';
const SIGNUP_EMAIL_EXISTS_PATTERN = /与此电子邮件地址相关联的帐户已存在|account\s+associated\s+with\s+this\s+email\s+address\s+already\s+exists|email\s+address.*already\s+exists/i;

const authPageRecovery = self.MultiPageAuthPageRecovery?.createAuthPageRecovery?.({
  detailPattern: AUTH_TIMEOUT_ERROR_DETAIL_PATTERN,
  getActionText,
  getPageTextSnapshot,
  humanPause,
  isActionEnabled,
  isVisibleElement,
  log,
  routeErrorPattern: AUTH_ROUTE_ERROR_PATTERN,
  simulateClick,
  sleep,
  throwIfStopped,
  titlePattern: AUTH_TIMEOUT_ERROR_TITLE_PATTERN,
}) || null;

function getVerificationErrorText() {
  const messages = [];
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[data-invalid="true"] + *',
    '[aria-invalid="true"] + *',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        messages.push(text);
      }
    });
  }

  const invalidInput = document.querySelector(`${VERIFICATION_CODE_INPUT_SELECTOR}[aria-invalid="true"], ${VERIFICATION_CODE_INPUT_SELECTOR}[data-invalid="true"]`);
  if (invalidInput) {
    const wrapper = invalidInput.closest('form, [data-rac], ._root_18qcl_51, div');
    if (wrapper) {
      const text = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) {
        messages.push(text);
      }
    }
  }

  return messages.find((text) => INVALID_VERIFICATION_CODE_PATTERN.test(text)) || '';
}

function createSignupUserAlreadyExistsError() {
  return new Error(
    `${SIGNUP_USER_ALREADY_EXISTS_ERROR_PREFIX}步骤 4：检测到 user_already_exists，说明当前用户已存在，当前轮将直接停止。`
  );
}

function isStep5Ready() {
  return Boolean(
    document.querySelector('input[name="name"], input[autocomplete="name"], input[name="birthday"], input[name="age"], [role="spinbutton"][data-type="year"]')
  );
}

function getPageTextSnapshot() {
  return (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getLoginVerificationDisplayedEmail() {
  const pageText = getPageTextSnapshot();
  const matches = pageText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return matches[0] ? String(matches[0]).trim().toLowerCase() : '';
}

function getOAuthConsentForm() {
  return document.querySelector(OAUTH_CONSENT_FORM_SELECTOR);
}

function getPrimaryContinueButton() {
  const consentForm = getOAuthConsentForm();
  if (consentForm) {
    const formButtons = Array.from(
      consentForm.querySelectorAll('button[type="submit"], input[type="submit"], [role="button"]')
    );

    const formContinueButton = formButtons.find((el) => {
      if (!isVisibleElement(el)) return false;

      const ddActionName = el.getAttribute?.('data-dd-action-name') || '';
      return ddActionName === 'Continue' || CONTINUE_ACTION_PATTERN.test(getActionText(el));
    });
    if (formContinueButton) {
      return formContinueButton;
    }

    const firstVisibleSubmit = formButtons.find(isVisibleElement);
    if (firstVisibleSubmit) {
      return firstVisibleSubmit;
    }
  }

  const continueBtn = document.querySelector(
    `${OAUTH_CONSENT_FORM_SELECTOR} button[type="submit"], button[type="submit"][data-dd-action-name="Continue"], button[type="submit"]._primary_3rdp0_107`
  );
  if (continueBtn && isVisibleElement(continueBtn)) {
    return continueBtn;
  }

  const buttons = document.querySelectorAll('button, [role="button"]');
  return Array.from(buttons).find((el) => {
    if (!isVisibleElement(el)) return false;

    const ddActionName = el.getAttribute?.('data-dd-action-name') || '';
    return ddActionName === 'Continue' || CONTINUE_ACTION_PATTERN.test(getActionText(el));
  }) || null;
}

function isOAuthConsentPage() {
  const pageText = getPageTextSnapshot();
  if (OAUTH_CONSENT_PAGE_PATTERN.test(pageText)) {
    return true;
  }

  if (getOAuthConsentForm()) {
    return true;
  }

  return /\bcodex\b/i.test(pageText) && /\bchatgpt\b/i.test(pageText) && Boolean(getPrimaryContinueButton());
}

function isVerificationPageStillVisible() {
  if (getCurrentAuthRetryPageState('signup_password') || getCurrentAuthRetryPageState('login')) {
    return false;
  }
  if (getVerificationCodeTarget()) return true;
  if (findResendVerificationCodeTrigger({ allowDisabled: true })) return true;
  if (document.querySelector('form[action*="email-verification" i]')) return true;

  if (!isEmailVerificationPage()) {
    return false;
  }

  return VERIFICATION_PAGE_PATTERN.test(getPageTextSnapshot());
}

function getPhoneVerificationErrorText() {
  const genericErrorText = getVerificationErrorText();
  if (genericErrorText) {
    return genericErrorText;
  }

  const pageText = getPageTextSnapshot();
  const resendLimitMatch = pageText.match(/尝试重新发送的次数过多。?\s*请稍后重试。?|too\s+many\s+(?:times\s+to\s+)?resend|too\s+many\s+resend\s+attempts?/i);
  if (resendLimitMatch) {
    return resendLimitMatch[0];
  }

  const smsUnavailableMatch = pageText.match(/无法向此电话号码发送短信|unable\s+to\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number|cannot\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number/i);
  if (smsUnavailableMatch) {
    return smsUnavailableMatch[0];
  }

  if (PHONE_MAX_USAGE_EXCEEDED_PATTERN.test(pageText)) {
    const match = pageText.match(/验证过程中出错\s*\(\s*phone_max_usage_exceeded\s*\)\s*。?\s*请重试。?|phone_max_usage_exceeded/i);
    return match ? match[0] : 'phone_max_usage_exceeded';
  }

  return '';
}

function isPhoneVerificationFreshNumberErrorText(text = '') {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    return false;
  }

  return PHONE_MAX_USAGE_EXCEEDED_PATTERN.test(normalizedText)
    || PHONE_RESEND_RATE_LIMIT_PATTERN.test(normalizedText)
    || PHONE_SMS_UNAVAILABLE_PATTERN.test(normalizedText);
}

function isAddPhonePageReady() {
  const path = `${location.pathname || ''} ${location.href || ''}`;
  if (/\/(?:add-phone|phone-verification)(?:[/?#]|$)/i.test(path)) return true;

  const phoneInput = document.querySelector(
    'input[type="tel"]:not([maxlength="6"]), input[name*="phone" i], input[id*="phone" i], input[autocomplete="tel"]'
  );
  if (phoneInput && isVisibleElement(phoneInput)) {
    return true;
  }

  if (getVerificationCodeTarget()) {
    return true;
  }

  if (findResendVerificationCodeTrigger({ allowDisabled: true })) {
    return true;
  }

  const pageText = getPageTextSnapshot();
  return ADD_PHONE_PAGE_PATTERN.test(pageText) || PHONE_VERIFICATION_PAGE_PATTERN.test(pageText);
}

function isPhoneNumberEntryPageUrl(url = location.href) {
  return /\/add-phone(?:[/?#]|$)/i.test(String(url || ''));
}

function isPhoneVerificationCodePageUrl(url = location.href) {
  return /\/phone-verification(?:[/?#]|$)/i.test(String(url || ''));
}


const PHONE_NUMBER_INPUT_SELECTOR = [
  '#tel',
  '.PhoneInputInput input',
  'input[name="__reservedForPhoneNumberInput_tel"]',
  'input[name*="phoneNumberInput" i]',
  'input[aria-label*="国家号码" i]',
  'input[aria-label*="phone number" i]',
  'input[placeholder*="电话号码" i]',
  'input[placeholder*="phone" i]',
  'input[autocomplete="tel"]',
  'input[type="tel"]:not([maxlength="6"])',
  'input[name*="phone" i]',
  'input[id*="phone" i]',
].join(', ');
const FIXED_PHONE_COUNTRY_FALLBACK = {
  key: 'TH',
  dialCode: '66',
  name: '泰国',
};

function getPhoneNumberInput() {
  const candidates = Array.from(document.querySelectorAll(PHONE_NUMBER_INPUT_SELECTOR));
  return candidates.find((input) => {
    if (!(input instanceof HTMLInputElement)) {
      return false;
    }
    if ((input.type || '').toLowerCase() === 'hidden') {
      return false;
    }
    return isVisibleElement(input);
  }) || null;
}

function getPhoneNumberHiddenInput() {
  const hiddenInput = document.querySelector(
    'input[type="hidden"][name="phoneNumber"], input[type="hidden"][id$="-phoneNumber"], input[type="hidden"][name*="phoneNumber" i]'
  );
  return hiddenInput || null;
}

function getPhoneCountrySelectButton() {
  const button = document.querySelector(
    '.react-aria-Select button[aria-haspopup="listbox"], button[aria-haspopup="listbox"], [aria-label*="国家代码" i]'
  );
  return button && isVisibleElement(button) ? button : null;
}

function getPhoneDigits(phoneNumber = '') {
  return String(phoneNumber || '').replace(/\D/g, '');
}

function buildInternationalPhoneValue(phoneNumber = '', country = null) {
  const rawValue = String(phoneNumber || '').trim();
  if (!rawValue) {
    return '';
  }

  if (rawValue.startsWith('+')) {
    const normalizedPrefixed = `+${rawValue.slice(1).replace(/\D/g, '')}`;
    return normalizedPrefixed === '+' ? rawValue : normalizedPrefixed;
  }

  const digits = getPhoneDigits(rawValue);
  if (!digits) {
    return rawValue;
  }

  const target = normalizePhoneCountryTarget(country);
  const normalizedDigits = target.dialCode && !digits.startsWith(target.dialCode)
    ? `${target.dialCode}${digits}`
    : digits;

  return `+${normalizedDigits}`;
}

function buildFixedPhoneCountryFallbackValue(phoneNumber = '', country = FIXED_PHONE_COUNTRY_FALLBACK) {
  const rawValue = String(phoneNumber || '').trim();
  const digits = getPhoneDigits(rawValue);
  const dialCode = String(country?.dialCode || FIXED_PHONE_COUNTRY_FALLBACK.dialCode || '').replace(/\D/g, '') || '66';
  if (!digits) {
    return rawValue;
  }

  const normalizedDigits = digits.startsWith(dialCode) ? digits : `${dialCode}${digits}`;
  return `+${normalizedDigits}`;
}

function getPhoneCountryOptionDialCode(option) {
  if (!option) {
    return '';
  }

  const text = `${getActionText(option) || ''} ${option.textContent || ''}`.replace(/\s+/g, ' ').trim();
  const match = text.match(/\+(\d{1,4})/);
  return match ? match[1] : '';
}

function getPhoneCountryOptionMatchText(option) {
  if (!option) {
    return '';
  }

  const fragments = [
    getActionText(option) || '',
    option.textContent || '',
    option.getAttribute?.('aria-label') || '',
    option.getAttribute?.('data-key') || '',
  ];

  const imageNodes = option.querySelectorAll?.('img[alt]') || [];
  for (const imageNode of Array.from(imageNodes)) {
    fragments.push(imageNode.getAttribute?.('alt') || imageNode.alt || '');
  }

  return normalizePhoneCountryMatchText(fragments.join(' '));
}

function getPhoneCountryOptionKey(option) {
  if (!option) {
    return '';
  }

  const dataKey = String(option.getAttribute?.('data-key') || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(dataKey)) {
    return dataKey;
  }

  const id = String(option.id || '');
  const match = id.match(/option-([A-Z]{2})$/);
  return match ? match[1] : '';
}

function getPhoneCountryHiddenSelect() {
  const select = document.querySelector(
    '[data-testid="hidden-select-container"] select, .react-aria-Select select, fieldset select'
  );
  return select instanceof HTMLSelectElement ? select : null;
}

function setPhoneCountryHiddenSelectValue(countryKey = '') {
  const normalizedKey = String(countryKey || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalizedKey)) {
    return false;
  }

  const select = getPhoneCountryHiddenSelect();
  if (!select) {
    return false;
  }

  const optionExists = Array.from(select.options || []).some((option) => option.value === normalizedKey);
  if (!optionExists) {
    return false;
  }

  select.value = normalizedKey;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function getSelectedPhoneCountryKey() {
  const select = getPhoneCountryHiddenSelect();
  if (!select) {
    return '';
  }

  const value = String(select.value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : '';
}

function normalizePhoneCountryMatchText(text = '') {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizePhoneCountryTarget(country = null) {
  if (!country || typeof country !== 'object' || Array.isArray(country)) {
    return {
      key: '',
      dialCode: '',
      name: '',
      names: [],
    };
  }

  const key = String(country.key || country.countryKey || '').trim().toUpperCase();
  const dialCode = String(country.dialCode || country.callingCode || '').replace(/\D/g, '');
  const rawNames = [
    country.name,
    country.chn,
    country.eng,
    country.rus,
    ...(Array.isArray(country.names) ? country.names : []),
  ];
  const names = [];
  const seen = new Set();
  for (const item of rawNames) {
    const normalized = String(item || '').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    const matchKey = normalizePhoneCountryMatchText(normalized);
    if (!matchKey || seen.has(matchKey)) continue;
    seen.add(matchKey);
    names.push(normalized);
  }

  return {
    key: /^[A-Z]{2}$/.test(key) ? key : '',
    dialCode,
    name: names[0] || '',
    names,
  };
}

function findPhoneCountryOptionForNumber(phoneNumber = '') {
  const digits = getPhoneDigits(phoneNumber);
  if (!digits) {
    return null;
  }

  const options = Array.from(document.querySelectorAll('[role="option"]'))
    .filter((option) => option.getAttribute('aria-disabled') !== 'true');
  if (!options.length) {
    return null;
  }

  const matches = options
    .map((option) => ({
      option,
      dialCode: getPhoneCountryOptionDialCode(option),
    }))
    .filter(({ dialCode }) => dialCode && digits.startsWith(dialCode))
    .sort((left, right) => right.dialCode.length - left.dialCode.length);

  return matches[0]?.option || null;
}

function findPhoneCountryOptionByTarget(country = null) {
  const target = normalizePhoneCountryTarget(country);
  const options = Array.from(document.querySelectorAll('[role="option"]'))
    .filter((option) => option.getAttribute('aria-disabled') !== 'true');
  if (!options.length) {
    return null;
  }

  if (target.key) {
    const keyMatchedOption = options.find((option) => getPhoneCountryOptionKey(option) === target.key);
    if (keyMatchedOption) {
      return keyMatchedOption;
    }
  }

  if (target.names.length) {
    const nameMatchedOption = options.find((option) => {
      const optionText = getPhoneCountryOptionMatchText(option);
      return target.names.some((name) => optionText.includes(normalizePhoneCountryMatchText(name)));
    });
    if (nameMatchedOption) {
      return nameMatchedOption;
    }
  }

  if (target.dialCode) {
    return options.find((option) => {
      const text = `${getActionText(option) || ''} ${option.textContent || ''}`.replace(/\s+/g, ' ').trim();
      return text.includes(`+${target.dialCode}`) || text.includes(`+(${target.dialCode})`);
    }) || null;
  }

  return null;
}

function getPhoneCountryListBox() {
  const listBox = document.querySelector('[role="listbox"]');
  return listBox && isVisibleElement(listBox) ? listBox : null;
}

function scrollPhoneCountryListBox(listBox, direction = 'down') {
  if (!listBox) {
    return false;
  }

  const maxScrollTop = Math.max(0, (Number(listBox.scrollHeight) || 0) - (Number(listBox.clientHeight) || 0));
  if (maxScrollTop <= 0) {
    return false;
  }

  const viewportHeight = Math.max(40, Number(listBox.clientHeight) || 0);
  const nextStep = Math.max(80, Math.floor(viewportHeight * 0.85));
  const currentTop = Number(listBox.scrollTop) || 0;
  const targetTop = direction === 'up'
    ? Math.max(0, currentTop - nextStep)
    : Math.min(maxScrollTop, currentTop + nextStep);

  if (targetTop === currentTop) {
    return false;
  }

  if (typeof listBox.scrollTo === 'function') {
    listBox.scrollTo({ top: targetTop, behavior: 'auto' });
  } else {
    listBox.scrollTop = targetTop;
  }
  return true;
}

async function findPhoneCountryOption(targetCountry = null, phoneNumber = '', timeoutMs = 5000) {
  const start = Date.now();
  const listBox = getPhoneCountryListBox();
  const seenScrollTops = new Set();
  let direction = 'down';

  while (Date.now() - start < timeoutMs) {
    throwIfStopped();
    const option = findPhoneCountryOptionByTarget(targetCountry) || findPhoneCountryOptionForNumber(phoneNumber);
    if (option) {
      return option;
    }

    if (!listBox) {
      await sleep(120);
      continue;
    }

    const currentTop = Math.round(Number(listBox.scrollTop) || 0);
    const directionKey = `${direction}:${currentTop}`;
    if (seenScrollTops.has(directionKey)) {
      if (direction === 'down') {
        direction = 'up';
      } else {
        break;
      }
    }
    seenScrollTops.add(directionKey);

    const moved = scrollPhoneCountryListBox(listBox, direction);
    if (!moved) {
      if (direction === 'down') {
        direction = 'up';
        if (currentTop > 0) {
          if (typeof listBox.scrollTo === 'function') {
            listBox.scrollTo({ top: 0, behavior: 'auto' });
          } else {
            listBox.scrollTop = 0;
          }
          await sleep(120);
          continue;
        }
      }
      break;
    }

    await sleep(120);
  }

  return null;
}

async function ensurePhoneCountryMatchesNumber(phoneNumber = '', country = null) {
  const targetCountry = normalizePhoneCountryTarget(country);
  const currentCountryKey = getSelectedPhoneCountryKey();
  const currentDialCode = getSelectedPhoneCountryDialCode();
  if (targetCountry.key && currentCountryKey === targetCountry.key) {
    return {
      matched: true,
      changed: false,
      dialCode: currentDialCode,
      countryKey: currentCountryKey,
      countryName: targetCountry.name,
    };
  }
  if (targetCountry.dialCode && currentDialCode === targetCountry.dialCode) {
    return {
      matched: true,
      changed: false,
      dialCode: currentDialCode,
      countryKey: currentCountryKey,
      countryName: targetCountry.name,
    };
  }

  const hiddenSelectChanged = targetCountry.key ? setPhoneCountryHiddenSelectValue(targetCountry.key) : false;
  if (hiddenSelectChanged) {
    await sleep(250);
    const selectedCountryKey = getSelectedPhoneCountryKey();
    const selectedDialCode = getSelectedPhoneCountryDialCode();
    if ((targetCountry.key && selectedCountryKey === targetCountry.key)
      || (targetCountry.dialCode && selectedDialCode === targetCountry.dialCode)) {
      return {
        matched: true,
        changed: currentCountryKey !== selectedCountryKey || currentDialCode !== selectedDialCode,
        dialCode: selectedDialCode,
        countryKey: selectedCountryKey,
        countryName: targetCountry.name,
      };
    }
  }

  const selectButton = getPhoneCountrySelectButton();
  if (!selectButton || !isActionEnabled(selectButton)) {
    return { matched: false, changed: false, dialCode: currentDialCode || '' };
  }

  await humanPause(200, 500);
  simulateClick(selectButton);

  const option = await findPhoneCountryOption(targetCountry, phoneNumber, 5000);

  if (!option) {
    await humanPause(100, 200);
    simulateClick(selectButton);
    return { matched: false, changed: false, dialCode: currentDialCode || '' };
  }

  const matchedDialCode = getPhoneCountryOptionDialCode(option) || targetCountry.dialCode;
  const matchedCountryKey = getPhoneCountryOptionKey(option) || targetCountry.key;
  log(
    `手机号验证：已定位到国家选项 ${getActionText(option) || option.textContent || targetCountry.name || matchedCountryKey || matchedDialCode}`,
    'info'
  );

  option.scrollIntoView?.({ block: 'center' });
  await humanPause(150, 350);
  const optionHiddenSelectChanged = matchedCountryKey ? setPhoneCountryHiddenSelectValue(matchedCountryKey) : false;
  if (isVisibleElement(option)) {
    simulateClick(option);
  }

  const waitSelectionStart = Date.now();
  while (Date.now() - waitSelectionStart < 2000) {
    throwIfStopped();
    const selectedCountryKey = getSelectedPhoneCountryKey();
    const selectedDialCode = getSelectedPhoneCountryDialCode();
    if ((matchedCountryKey && selectedCountryKey === matchedCountryKey)
      || (matchedDialCode && selectedDialCode === matchedDialCode)) {
      return {
        matched: true,
        changed: currentCountryKey !== selectedCountryKey || currentDialCode !== selectedDialCode,
        dialCode: matchedDialCode,
        countryKey: matchedCountryKey,
        countryName: targetCountry.name,
      };
    }
    await sleep(120);
  }

  if (optionHiddenSelectChanged || hiddenSelectChanged) {
    await sleep(250);
    const selectedCountryKey = getSelectedPhoneCountryKey();
    const selectedDialCode = getSelectedPhoneCountryDialCode();
    if ((matchedCountryKey && selectedCountryKey === matchedCountryKey)
      || (matchedDialCode && selectedDialCode === matchedDialCode)) {
      return {
        matched: true,
        changed: currentCountryKey !== selectedCountryKey || currentDialCode !== selectedDialCode,
        dialCode: matchedDialCode,
        countryKey: matchedCountryKey,
        countryName: targetCountry.name,
      };
    }
  }

  return {
    matched: false,
    changed: false,
    dialCode: currentDialCode || matchedDialCode || '',
    countryKey: matchedCountryKey,
  };
}

function getSelectedPhoneCountryDialCode() {
  const candidates = [
    document.querySelector('button[aria-haspopup="listbox"] .react-aria-SelectValue'),
    document.querySelector('[class*="SelectValue"]'),
    document.querySelector('span[class*="inputDecorationCountryCode"]'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const text = (candidate.textContent || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/\+(\d{1,4})/);
    if (match) {
      return match[1];
    }
  }

  return '';
}

function normalizePhoneNumberForDialCode(phoneNumber = '', dialCode = '') {
  const raw = String(phoneNumber || '').trim();
  if (!raw) {
    return '';
  }

  let normalized = raw.replace(/[^\d+]/g, '');
  const normalizedDialCode = String(dialCode || '').replace(/\D/g, '');
  if (normalized.startsWith('+')) {
    normalized = normalized.slice(1);
  }
  if (normalizedDialCode && normalized.startsWith(normalizedDialCode)) {
    normalized = normalized.slice(normalizedDialCode.length);
  }

  return normalized.replace(/\D/g, '');
}

function normalizePhoneNumberForOpenAiForm(phoneNumber = '') {
  return normalizePhoneNumberForDialCode(phoneNumber, getSelectedPhoneCountryDialCode());
}

async function tryAutoSelectPhoneCountryByTyping(phoneInput, hiddenPhoneInput, phoneNumber = '', phoneCountry = null) {
  if (!phoneInput) {
    return {
      matched: false,
      autoSelected: false,
      phoneInputValue: '',
      hiddenValue: '',
    };
  }

  const internationalValue = buildInternationalPhoneValue(phoneNumber, phoneCountry);
  if (!internationalValue) {
    return {
      matched: false,
      autoSelected: false,
      phoneInputValue: '',
      hiddenValue: '',
    };
  }

  const targetCountry = normalizePhoneCountryTarget(phoneCountry);
  const fallbackDialCodeMatch = internationalValue.match(/^\+(\d{1,4})/);
  const fallbackDialCode = fallbackDialCodeMatch ? fallbackDialCodeMatch[1] : '';

  fillInput(phoneInput, internationalValue);
  if (hiddenPhoneInput) {
    fillInput(hiddenPhoneInput, internationalValue);
  }

  const start = Date.now();
  while (Date.now() - start < 1800) {
    throwIfStopped();
    const selectedCountryKey = getSelectedPhoneCountryKey();
    const selectedDialCode = getSelectedPhoneCountryDialCode();
    const matched = (targetCountry.key && selectedCountryKey === targetCountry.key)
      || (targetCountry.dialCode && selectedDialCode === targetCountry.dialCode)
      || (selectedDialCode && getPhoneDigits(internationalValue).startsWith(selectedDialCode))
      || (fallbackDialCode && selectedDialCode === fallbackDialCode);
    if (matched) {
      return {
        matched: true,
        autoSelected: true,
        dialCode: selectedDialCode || targetCountry.dialCode || fallbackDialCode,
        countryKey: selectedCountryKey || targetCountry.key || '',
        countryName: targetCountry.name,
        phoneInputValue: internationalValue,
        hiddenValue: internationalValue,
      };
    }
    await sleep(120);
  }

  return {
    matched: false,
    autoSelected: false,
    dialCode: getSelectedPhoneCountryDialCode() || targetCountry.dialCode || fallbackDialCode,
    countryKey: getSelectedPhoneCountryKey() || targetCountry.key || '',
    countryName: targetCountry.name,
    phoneInputValue: internationalValue,
    hiddenValue: internationalValue,
  };
}

function getPhoneVerificationActionButton({ allowDisabled = false } = {}) {
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  const codeTarget = getVerificationCodeTarget();
  const pattern = codeTarget
    ? /verify|confirm|submit|continue|next|确认|验证|继续|下一步/i
    : /send|sms|text|code|verify|continue|next|submit|发送|短信|验证码|继续|下一步/i;

  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    if (!text) return false;
    if (RESEND_VERIFICATION_CODE_PATTERN.test(text)) return false;
    return pattern.test(text);
  }) || null;
}

function dispatchReactAriaPress(el) {
  if (!el) {
    throw new Error('无法触发空元素。');
  }

  const rect = typeof el.getBoundingClientRect === 'function'
    ? el.getBoundingClientRect()
    : { left: 0, top: 0, width: 0, height: 0 };
  const clientX = rect.left + Math.min(Math.max(rect.width / 2, 1), Math.max(rect.width - 1, 1));
  const clientY = rect.top + Math.min(Math.max(rect.height / 2, 1), Math.max(rect.height - 1, 1));
  const baseInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY,
    button: 0,
    buttons: 1,
    detail: 1,
  };

  if (typeof el.focus === 'function') {
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }

  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent('pointerdown', {
      ...baseInit,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
  }
  el.dispatchEvent(new MouseEvent('mousedown', baseInit));

  if (typeof PointerEvent === 'function') {
    el.dispatchEvent(new PointerEvent('pointerup', {
      ...baseInit,
      buttons: 0,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    }));
  }
  el.dispatchEvent(new MouseEvent('mouseup', {
    ...baseInit,
    buttons: 0,
  }));

  if (typeof el.click === 'function') {
    el.click();
    return 'reactPress';
  }

  el.dispatchEvent(new MouseEvent('click', {
    ...baseInit,
    buttons: 0,
  }));
  return 'reactPressFallback';
}

function inspectPhoneVerificationState() {
  const addPhonePage = isAddPhonePageReady();
  const phoneNumberEntryPage = isPhoneNumberEntryPageUrl();
  const phoneVerificationPage = isPhoneVerificationCodePageUrl();
  const phoneInput = addPhonePage ? getPhoneNumberInput() : null;
  const codeTarget = addPhonePage ? getVerificationCodeTarget() : null;
  const actionButton = addPhonePage ? getPhoneVerificationActionButton({ allowDisabled: true }) : null;
  const resendButton = addPhonePage ? findResendVerificationCodeTrigger({ allowDisabled: true }) : null;
  const retryButton = addPhonePage ? getAuthRetryButton({ allowDisabled: true }) : null;
  const errorText = addPhonePage ? getPhoneVerificationErrorText() : '';

  return {
    addPhonePage,
    phoneNumberEntryPage,
    phoneVerificationPage,
    phoneInput,
    codeTarget,
    actionButton,
    resendButton,
    retryButton,
    errorText,
    url: location.href,
  };
}

function serializePhoneVerificationState(snapshot) {
  return {
    addPhonePage: Boolean(snapshot?.addPhonePage),
    phoneNumberEntryPage: Boolean(snapshot?.phoneNumberEntryPage),
    phoneVerificationPage: Boolean(snapshot?.phoneVerificationPage),
    hasPhoneInput: Boolean(snapshot?.phoneInput),
    hasCodeTarget: Boolean(snapshot?.codeTarget),
    hasActionButton: Boolean(snapshot?.actionButton),
    hasResendButton: Boolean(snapshot?.resendButton),
    hasRetryButton: Boolean(snapshot?.retryButton),
    errorText: snapshot?.errorText || '',
    url: snapshot?.url || location.href,
  };
}

async function waitForPhoneVerificationPageReady(timeout = 15000) {
  const start = Date.now();
  let snapshot = inspectPhoneVerificationState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectPhoneVerificationState();
    if (snapshot.addPhonePage) {
      return snapshot;
    }
    await sleep(200);
  }

  throw new Error('当前未进入手机号验证页面。URL: ' + location.href);
}

async function waitForPhoneCodeEntryReady(timeout = 15000) {
  const start = Date.now();
  let snapshot = inspectPhoneVerificationState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectPhoneVerificationState();
    if (!snapshot.addPhonePage) {
      return { success: true, leftPhonePage: true, url: snapshot.url || location.href };
    }
    if (snapshot.errorText && isPhoneVerificationFreshNumberErrorText(snapshot.errorText)) {
      return { success: false, errorText: snapshot.errorText, url: snapshot.url || location.href };
    }
    if (snapshot.phoneVerificationPage && snapshot.codeTarget) {
      return {
        success: true,
        codeEntryReady: true,
        phoneVerificationPage: true,
        url: snapshot.url || location.href,
      };
    }
    if (snapshot.errorText) {
      return { success: false, errorText: snapshot.errorText, url: snapshot.url || location.href };
    }
    await sleep(200);
  }

  return {
    success: false,
    errorText: '提交手机号后未进入 https://auth.openai.com/phone-verification 短信验证码页面。',
    url: location.href,
  };
}

async function waitForPhoneNumberInputReady(timeout = 12000) {
  const start = Date.now();
  let loggedWaiting = false;
  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectPhoneVerificationState();
    if (!snapshot.addPhonePage) {
      throw new Error('当前未进入手机号验证页面。URL: ' + location.href);
    }
    if (snapshot.phoneVerificationPage && snapshot.codeTarget) {
      return { phoneInput: null, alreadyWaitingForCode: true, url: snapshot.url || location.href };
    }

    const phoneInput = getPhoneNumberInput();
    if (phoneInput) {
      return { phoneInput, url: snapshot.url || location.href };
    }
    if (!loggedWaiting) {
      loggedWaiting = true;
      const totalCandidates = document.querySelectorAll(PHONE_NUMBER_INPUT_SELECTOR).length;
      const hiddenPhoneInput = getPhoneNumberHiddenInput();
      log(
        `手机号验证：正在等待手机号输入框出现（候选元素 ${totalCandidates} 个，隐藏 phoneNumber 字段 ${hiddenPhoneInput ? '已找到' : '未找到'}）...`,
        'warn'
      );
    }
    await sleep(150);
  }

  throw new Error('手机号页面未找到手机号输入框。URL: ' + location.href);
}

async function waitForPhoneActionButtonEnabled(timeout = 8000) {
  const start = Date.now();
  let latestButton = null;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    latestButton = getPhoneVerificationActionButton({ allowDisabled: true });
    if (latestButton && isActionEnabled(latestButton)) {
      return latestButton;
    }
    await sleep(150);
  }

  return latestButton && isActionEnabled(latestButton) ? latestButton : null;
}

async function submitPhoneNumber(payload = {}) {
  const { phoneNumber, phoneCountry } = payload;
  if (!phoneNumber) {
    throw new Error('未提供手机号。');
  }

  const snapshot = await waitForPhoneVerificationPageReady();
  if (snapshot.phoneVerificationPage && snapshot.codeTarget) {
    return {
      alreadyWaitingForCode: true,
      codeEntryReady: true,
      phoneVerificationPage: true,
      url: snapshot.url || location.href,
    };
  }
  const phoneEntry = await waitForPhoneNumberInputReady();
  if (phoneEntry.alreadyWaitingForCode) {
    return {
      alreadyWaitingForCode: true,
      codeEntryReady: true,
      phoneVerificationPage: true,
      url: phoneEntry.url || location.href,
    };
  }
  const phoneInput = phoneEntry.phoneInput || snapshot.phoneInput || getPhoneNumberInput();
  if (!phoneInput) {
    throw new Error('手机号页面未找到手机号输入框。URL: ' + location.href);
  }

  const actionButton = snapshot.actionButton || getPhoneVerificationActionButton({ allowDisabled: true });
  if (!actionButton) {
    throw new Error('手机号页面未找到发送验证码按钮。URL: ' + location.href);
  }

  await humanPause(450, 1100);
  const hiddenPhoneInput = getPhoneNumberHiddenInput();
  const fullDigitsPhoneNumber = getPhoneDigits(phoneNumber);
  const directPhoneValue = buildInternationalPhoneValue(phoneNumber, null)
    || (fullDigitsPhoneNumber ? `+${fullDigitsPhoneNumber}` : String(phoneNumber || '').trim());
  const phoneInputValue = directPhoneValue;
  const hiddenValue = directPhoneValue;

  if (!phoneInputValue) {
    throw new Error('手机号页面无法生成可填写的号码。URL: ' + location.href);
  }

  const currentPhoneInputValue = String(phoneInput.value || '').trim();
  if (currentPhoneInputValue !== String(phoneInputValue || '').trim()) {
    fillInput(phoneInput, phoneInputValue);
  }
  if (hiddenPhoneInput) {
    const currentHiddenValue = String(hiddenPhoneInput.value || '').trim();
    if (currentHiddenValue !== String(hiddenValue || '').trim()) {
      fillInput(hiddenPhoneInput, hiddenValue);
    }
  }
  log(`手机号验证：已直接填写完整手机号 ${hiddenValue || phoneInputValue || fullDigitsPhoneNumber || phoneNumber}`);
  const latestActionButton = await waitForPhoneActionButtonEnabled(8000) || actionButton;
  if (!latestActionButton || !isActionEnabled(latestActionButton)) {
    throw new Error('手机号页面未找到可点击的继续按钮。URL: ' + location.href);
  }
  await humanPause(300, 800);
  const triggerMethod = dispatchReactAriaPress(latestActionButton);
  log(`手机号验证：已通过 ${triggerMethod} 提交手机号，正在等待短信验证码输入框...`);
  return waitForPhoneCodeEntryReady();
}

async function waitForPhoneCodeSubmitOutcome(timeout = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectPhoneVerificationState();
    if (!snapshot.addPhonePage || isStep8Ready()) {
      return { success: true, url: snapshot.url || location.href };
    }
    if (snapshot.errorText) {
      return { invalidCode: true, errorText: snapshot.errorText, url: snapshot.url || location.href };
    }
    await sleep(150);
  }

  const snapshot = inspectPhoneVerificationState();
  if (!snapshot.addPhonePage || isStep8Ready()) {
    return { success: true, url: snapshot.url || location.href, assumed: true };
  }

  return {
    invalidCode: true,
    errorText: snapshot.errorText || '提交短信验证码后仍停留在手机号页面。',
    url: snapshot.url || location.href,
  };
}

async function waitForPhoneCodeSubmitAttempt(timeout = 3500) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectPhoneVerificationState();
    if (!snapshot.addPhonePage || isStep8Ready()) {
      return { settled: true, success: true, url: snapshot.url || location.href };
    }
    if (snapshot.errorText) {
      return {
        settled: true,
        invalidCode: true,
        errorText: snapshot.errorText,
        url: snapshot.url || location.href,
      };
    }
    await sleep(150);
  }

  return {
    settled: false,
    url: location.href,
  };
}

async function fillPhoneVerificationCode(payload = {}) {
  const { code } = payload;
  if (!code) {
    throw new Error('未提供短信验证码。');
  }

  const snapshot = await waitForPhoneVerificationPageReady();
  const target = snapshot.codeTarget || getVerificationCodeTarget();
  if (!target) {
    throw new Error('手机号页面未找到短信验证码输入框。URL: ' + location.href);
  }

  log(`手机号验证：正在填写短信验证码 ${code}`);

  if (target.type === 'split' && Array.isArray(target.elements)) {
    for (let i = 0; i < Math.min(6, target.elements.length, code.length); i += 1) {
      fillInput(target.elements[i], code[i]);
      await sleep(80);
    }
  } else if (target.element) {
    fillInput(target.element, code);
  } else {
    throw new Error('手机号页面验证码输入框不可用。URL: ' + location.href);
  }

  await sleep(1200);
  const autoSubmitOutcome = await waitForPhoneCodeSubmitAttempt(4000);
  if (autoSubmitOutcome.settled) {
    if (autoSubmitOutcome.success) {
      log('手机号验证：页面已自动提交短信验证码。');
    }
    return autoSubmitOutcome;
  }

  const actionButton = getPhoneVerificationActionButton({ allowDisabled: true });
  if (actionButton && isActionEnabled(actionButton)) {
    await humanPause(300, 800);
    const triggerMethod = dispatchReactAriaPress(actionButton);
    log(`手机号验证：已通过 ${triggerMethod} 提交短信验证码。`);
  }

  return waitForPhoneCodeSubmitOutcome();
}

async function resendPhoneVerificationCode() {
  const snapshot = await waitForPhoneVerificationPageReady();
  const resendButton = snapshot.resendButton || findResendVerificationCodeTrigger({ allowDisabled: true });
  if (!resendButton || !isActionEnabled(resendButton)) {
    return {
      resent: false,
      reason: 'button_unavailable',
      errorText: snapshot.errorText || '',
      url: snapshot.url || location.href,
    };
  }

  await humanPause(300, 800);
  const triggerMethod = dispatchReactAriaPress(resendButton);
  log(`手机号验证：已通过 ${triggerMethod} 点击页面上的重新发送验证码按钮。`);
  await sleep(1200);
  const latestSnapshot = inspectPhoneVerificationState();
  return {
    resent: true,
    errorText: latestSnapshot.errorText || '',
    url: latestSnapshot.url || location.href,
  };
}

async function waitForPhoneEntryAfterRetry(timeout = 15000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectPhoneVerificationState();
    if (snapshot.phoneInput) {
      return {
        clicked: true,
        ready: true,
        hasPhoneInput: true,
        url: snapshot.url || location.href,
      };
    }
    if (snapshot.codeTarget) {
      return {
        clicked: true,
        ready: true,
        alreadyWaitingForCode: true,
        url: snapshot.url || location.href,
      };
    }
    await sleep(200);
  }

  const snapshot = inspectPhoneVerificationState();
  return {
    clicked: true,
    ready: false,
    hasPhoneInput: Boolean(snapshot.phoneInput),
    alreadyWaitingForCode: Boolean(snapshot.codeTarget),
    hasRetryButton: Boolean(snapshot.retryButton),
    errorText: snapshot.errorText || '',
    url: snapshot.url || location.href,
  };
}

async function clickPhoneVerificationRetry(_payload = {}) {
  const snapshot = await waitForPhoneVerificationPageReady();
  const retryButton = snapshot.retryButton || getAuthRetryButton({ allowDisabled: true });
  if (!retryButton || !isActionEnabled(retryButton)) {
    return {
      clicked: false,
      reason: 'button_unavailable',
      errorText: snapshot.errorText || '',
      url: snapshot.url || location.href,
    };
  }

  await humanPause(300, 800);
  const triggerMethod = dispatchReactAriaPress(retryButton);
  log(`手机号验证：已通过 ${triggerMethod} 点击“重试”按钮。`);
  await sleep(1200);
  return waitForPhoneEntryAfterRetry();
}

async function goBackToPhoneNumberEntry(_payload = {}) {
  const snapshot = inspectPhoneVerificationState();
  if (snapshot.phoneInput) {
    return {
      navigated: false,
      ready: true,
      hasPhoneInput: true,
      url: snapshot.url || location.href,
    };
  }

  history.back();
  log('手机号验证：已后退页面，正在返回手机号填写页。');
  await sleep(1200);

  const start = Date.now();
  while (Date.now() - start < 15000) {
    throwIfStopped();
    const latestSnapshot = inspectPhoneVerificationState();
    if (latestSnapshot.phoneInput) {
      return {
        navigated: true,
        ready: true,
        hasPhoneInput: true,
        url: latestSnapshot.url || location.href,
      };
    }
    await sleep(200);
  }

  const latestSnapshot = inspectPhoneVerificationState();
  return {
    navigated: true,
    ready: false,
    hasPhoneInput: Boolean(latestSnapshot.phoneInput),
    hasCodeTarget: Boolean(latestSnapshot.codeTarget),
    errorText: latestSnapshot.errorText || '',
    url: latestSnapshot.url || location.href,
  };
}

function isStep8Ready() {
  const continueBtn = getPrimaryContinueButton();
  if (!continueBtn) return false;
  if (isVerificationPageStillVisible()) return false;
  if (isAddPhonePageReady()) return false;

  return isOAuthConsentPage();
}

function normalizeInlineText(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function isStep5AllConsentText(text) {
  const normalizedText = normalizeInlineText(text).toLowerCase();
  if (!normalizedText) return false;

  return /i\s+agree\s+to\s+all\s+of\s+the\s+following/i.test(normalizedText)
    || normalizedText.includes('\u6211\u540c\u610f\u4ee5\u4e0b\u6240\u6709\u5404\u9879')
    || normalizedText.includes('\u540c\u610f\u4ee5\u4e0b\u6240\u6709\u5404\u9879')
    || normalizedText.includes('\u6211\u540c\u610f\u6240\u6709')
    || normalizedText.includes('\u5168\u90e8\u540c\u610f');
}

function findStep5AllConsentCheckbox() {
  const namedCandidates = Array.from(document.querySelectorAll('input[name="allCheckboxes"][type="checkbox"]'))
    .filter((el) => {
      const checkboxLabel = el.closest?.('label') || null;
      return isVisibleElement(el) || (checkboxLabel && isVisibleElement(checkboxLabel));
    });

  const namedMatch = namedCandidates.find((el) => {
    const checkboxLabel = el.closest?.('label') || null;
    const checkboxText = normalizeInlineText([
      checkboxLabel?.textContent || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.getAttribute?.('name') || '',
    ].filter(Boolean).join(' '));
    return isStep5AllConsentText(checkboxText);
  });
  if (namedMatch) {
    return namedMatch;
  }
  if (namedCandidates.length > 0) {
    return namedCandidates[0];
  }

  return Array.from(document.querySelectorAll('input[type="checkbox"]'))
    .find((el) => {
      const checkboxLabel = el.closest?.('label') || null;
      if (!isVisibleElement(el) && !(checkboxLabel && isVisibleElement(checkboxLabel))) {
        return false;
      }
      const checkboxText = normalizeInlineText([
        checkboxLabel?.textContent || '',
        el.getAttribute?.('aria-label') || '',
        el.getAttribute?.('title') || '',
        el.getAttribute?.('name') || '',
      ].filter(Boolean).join(' '));
      return isStep5AllConsentText(checkboxText);
    }) || null;
}

function isStep5CheckboxChecked(checkbox) {
  if (!checkbox) return false;
  if (checkbox.checked === true) return true;

  const ariaChecked = String(
    checkbox.getAttribute?.('aria-checked')
    || checkbox.closest?.('[role="checkbox"]')?.getAttribute?.('aria-checked')
    || ''
  ).toLowerCase();
  return ariaChecked === 'true';
}

function findBirthdayReactAriaSelect(labelText) {
  const normalizedLabel = normalizeInlineText(labelText);
  const roots = document.querySelectorAll('.react-aria-Select');

  for (const root of roots) {
    const labelEl = Array.from(root.querySelectorAll('span')).find((el) => normalizeInlineText(el.textContent) === normalizedLabel);
    if (!labelEl) continue;

    const item = root.closest('[class*="selectItem"], ._selectItem_ppsls_113') || root.parentElement;
    const nativeSelect = item?.querySelector('[data-testid="hidden-select-container"] select') || null;
    const button = root.querySelector('button[aria-haspopup="listbox"]') || null;
    const valueEl = root.querySelector('.react-aria-SelectValue') || null;

    return { root, item, labelEl, nativeSelect, button, valueEl };
  }

  return null;
}

async function setReactAriaBirthdaySelect(control, value) {
  if (!control?.nativeSelect) {
    throw new Error('未找到可写入的生日下拉框。');
  }

  const desiredValue = String(value);
  const option = Array.from(control.nativeSelect.options).find((item) => item.value === desiredValue);
  if (!option) {
    throw new Error(`生日下拉框中不存在值 ${desiredValue}。`);
  }

  control.nativeSelect.value = desiredValue;
  option.selected = true;
  control.nativeSelect.dispatchEvent(new Event('input', { bubbles: true }));
  control.nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
}

function getStep5ErrorText() {
  const messages = [];
  const selectors = [
    '.react-aria-FieldError',
    '[slot="errorMessage"]',
    '[id$="-error"]',
    '[id$="-errors"]',
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error"]',
  ];

  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!isVisibleElement(el)) return;
      const text = normalizeInlineText(el.textContent);
      if (text) {
        messages.push(text);
      }
    });
  }

  const invalidField = Array.from(document.querySelectorAll('[aria-invalid="true"], [data-invalid="true"]'))
    .find((el) => isVisibleElement(el));
  if (invalidField) {
    const wrapper = invalidField.closest('form, fieldset, [data-rac], div');
    if (wrapper) {
      const text = normalizeInlineText(wrapper.textContent);
      if (text) {
        messages.push(text);
      }
    }
  }

  return messages.find((text) => STEP5_SUBMIT_ERROR_PATTERN.test(text)) || '';
}


function isSignupPasswordPage() {
  return /\/create-account\/password(?:[/?#]|$)/i.test(location.pathname || '');
}

function getSignupPasswordInput() {
  const input = document.querySelector('input[type="password"]');
  return input && isVisibleElement(input) ? input : null;
}

function getSignupPasswordSubmitButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll('button, [role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    return /继续|continue|submit|创建|create/i.test(text);
  }) || null;
}

function getAuthRetryButton({ allowDisabled = false } = {}) {
  if (authPageRecovery?.getAuthRetryButton) {
    return authPageRecovery.getAuthRetryButton({ allowDisabled });
  }

  const direct = document.querySelector('button[data-dd-action-name="Try again"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll('button, [role="button"]');
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    return /重试|try\s+again/i.test(text);
  }) || null;
}

function getAuthTimeoutErrorPageState(options = {}) {
  if (authPageRecovery?.getAuthTimeoutErrorPageState) {
    return authPageRecovery.getAuthTimeoutErrorPageState(options);
  }

  const { pathPatterns = [] } = options;
  const path = location.pathname || '';
  if (pathPatterns.length && !pathPatterns.some((pattern) => pattern.test(path))) {
    return null;
  }

  const retryButton = getAuthRetryButton({ allowDisabled: true });
  if (!retryButton) {
    return null;
  }

  const text = getPageTextSnapshot();
  const titleMatched = AUTH_TIMEOUT_ERROR_TITLE_PATTERN.test(text)
    || AUTH_TIMEOUT_ERROR_TITLE_PATTERN.test(document.title || '');
  const detailMatched = AUTH_TIMEOUT_ERROR_DETAIL_PATTERN.test(text);
  const routeErrorMatched = AUTH_ROUTE_ERROR_PATTERN.test(text);
  const maxCheckAttemptsBlocked = /max_check_attempts/i.test(text);
  const userAlreadyExistsBlocked = /user_already_exists/i.test(text);

  if (!titleMatched && !detailMatched && !routeErrorMatched && !maxCheckAttemptsBlocked && !userAlreadyExistsBlocked) {
    return null;
  }

  return {
    path,
    url: location.href,
    retryButton,
    retryEnabled: isActionEnabled(retryButton),
    titleMatched,
    detailMatched,
    routeErrorMatched,
    maxCheckAttemptsBlocked,
    userAlreadyExistsBlocked,
  };
}

function getSignupAuthRetryPathPatterns() {
  return [
    /\/create-account\/password(?:[/?#]|$)/i,
    /\/email-verification(?:[/?#]|$)/i,
  ];
}

function getLoginAuthRetryPathPatterns() {
  return [
    /\/log-in(?:[/?#]|$)/i,
    /\/email-verification(?:[/?#]|$)/i,
  ];
}

function getAuthRetryPathPatternsForFlow(flow = 'auth') {
  switch (flow) {
    case 'signup':
    case 'signup_password':
      return getSignupAuthRetryPathPatterns();
    case 'login':
      return getLoginAuthRetryPathPatterns();
    default:
      return [];
  }
}

function getCurrentAuthRetryPageState(flow = 'auth') {
  return getAuthTimeoutErrorPageState({
    pathPatterns: getAuthRetryPathPatternsForFlow(flow),
  });
}

async function recoverCurrentAuthRetryPage(payload = {}) {
  const {
    flow = 'auth',
    logLabel = '',
    maxClickAttempts = 5,
    pathPatterns = null,
    step = null,
    timeoutMs = 12000,
    waitAfterClickMs = 3000,
  } = payload;
  const resolvedPathPatterns = Array.isArray(pathPatterns)
    ? pathPatterns
    : getAuthRetryPathPatternsForFlow(flow);
  if (authPageRecovery?.recoverAuthRetryPage) {
    return authPageRecovery.recoverAuthRetryPage({
      logLabel,
      maxClickAttempts,
      pathPatterns: resolvedPathPatterns,
      step,
      timeoutMs,
      waitAfterClickMs,
    });
  }

  const maxIdlePolls = timeoutMs > 0
    ? Math.max(1, Math.ceil(timeoutMs / Math.max(1, 250)))
    : Number.POSITIVE_INFINITY;
  let clickCount = 0;
  let idlePollCount = 0;
  while (clickCount < maxClickAttempts) {
    throwIfStopped();
    const retryState = getAuthTimeoutErrorPageState({ pathPatterns: resolvedPathPatterns });
    if (!retryState) {
      return {
        recovered: clickCount > 0,
        clickCount,
        url: location.href,
      };
    }

    if (retryState.maxCheckAttemptsBlocked) {
      throw new Error('CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统，已完全停止流程，请不要短时间内多次进行重新发送验证码，连续刷新、反复点击重试会加重风控；请先关闭页面等待 15-30 分钟，让系统的临时限制自动解除。或者更换浏览器');
    }
    if (retryState.userAlreadyExistsBlocked) {
      throw createSignupUserAlreadyExistsError();
    }
    if (retryState.retryButton && retryState.retryEnabled) {
      idlePollCount = 0;
      clickCount += 1;
      log(`${logLabel || `步骤 ${step || '?'}：检测到重试页，正在点击“重试”恢复`}（第 ${clickCount} 次）...`, 'warn');
      await humanPause(300, 800);
      simulateClick(retryState.retryButton);
      const settleStart = Date.now();
      while (Date.now() - settleStart < waitAfterClickMs) {
        throwIfStopped();
        if (!getAuthTimeoutErrorPageState({ pathPatterns: resolvedPathPatterns })) {
          return {
            recovered: true,
            clickCount,
            url: location.href,
          };
        }
        await sleep(250);
      }
      continue;
    }

    idlePollCount += 1;
    if (idlePollCount >= maxIdlePolls) {
      throw new Error(`${logLabel || `步骤 ${step || '?'}：重试页恢复`}超时：重试按钮长时间不可点击。URL: ${location.href}`);
    }

    await sleep(250);
  }

  const finalRetryState = getAuthTimeoutErrorPageState({ pathPatterns: resolvedPathPatterns });
  if (!finalRetryState) {
    return {
      recovered: clickCount > 0,
      clickCount,
      url: location.href,
    };
  }
  if (finalRetryState.maxCheckAttemptsBlocked) {
    throw new Error('CF_SECURITY_BLOCKED::您已触发Cloudflare 安全防护系统，已完全停止流程，请不要短时间内多次进行重新发送验证码，连续刷新、反复点击重试会加重风控；请先关闭页面等待 15-30 分钟，让系统的临时限制自动解除。或者更换浏览器');
  }
  if (finalRetryState.userAlreadyExistsBlocked) {
    throw createSignupUserAlreadyExistsError();
  }

  throw new Error(`${logLabel || `步骤 ${step || '?'}：重试页恢复`}失败：已连续点击“重试” ${maxClickAttempts} 次，页面仍未恢复。URL: ${location.href}`);
}

function getSignupPasswordTimeoutErrorPageState() {
  return getAuthTimeoutErrorPageState({
    pathPatterns: getSignupAuthRetryPathPatterns(),
  });
}

function getLoginTimeoutErrorPageState() {
  return getAuthTimeoutErrorPageState({
    pathPatterns: getLoginAuthRetryPathPatterns(),
  });
}

function getLoginEmailInput() {
  const input = document.querySelector(
    'input[type="email"], input[name="email"], input[name="username"], input[id*="email"], input[placeholder*="email" i], input[placeholder*="Email"]'
  );
  return input && isVisibleElement(input) ? input : null;
}

function getLoginPasswordInput() {
  const input = document.querySelector('input[type="password"]');
  return input && isVisibleElement(input) ? input : null;
}

function getLoginSubmitButton({ allowDisabled = false } = {}) {
  const direct = document.querySelector('button[type="submit"], input[type="submit"]');
  if (direct && isVisibleElement(direct) && (allowDisabled || isActionEnabled(direct))) {
    return direct;
  }

  const candidates = document.querySelectorAll(
    'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]'
  );
  return Array.from(candidates).find((el) => {
    if (!isVisibleElement(el) || (!allowDisabled && !isActionEnabled(el))) return false;
    const text = getActionText(el);
    if (!text || ONE_TIME_CODE_LOGIN_PATTERN.test(text)) return false;
    return /continue|next|submit|sign\s*in|log\s*in|继续|下一步|登录/i.test(text);
  }) || null;
}

function inspectLoginAuthState() {
  const retryState = getLoginTimeoutErrorPageState();
  const verificationTarget = getVerificationCodeTarget();
  const passwordInput = getLoginPasswordInput();
  const emailInput = getLoginEmailInput();
  const switchTrigger = findOneTimeCodeLoginTrigger();
  const submitButton = getLoginSubmitButton({ allowDisabled: true });
  const verificationVisible = isVerificationPageStillVisible();
  const addPhonePage = isAddPhonePageReady();
  const consentReady = isStep8Ready();
  const oauthConsentPage = isOAuthConsentPage();
  const baseState = {
    state: 'unknown',
    url: location.href,
    path: location.pathname || '',
    displayedEmail: getLoginVerificationDisplayedEmail(),
    retryButton: retryState?.retryButton || null,
    retryEnabled: Boolean(retryState?.retryEnabled),
    titleMatched: Boolean(retryState?.titleMatched),
    detailMatched: Boolean(retryState?.detailMatched),
    maxCheckAttemptsBlocked: Boolean(retryState?.maxCheckAttemptsBlocked),
    verificationTarget,
    passwordInput,
    emailInput,
    submitButton,
    switchTrigger,
    verificationVisible,
    addPhonePage,
    oauthConsentPage,
    consentReady,
  };

  if (retryState) {
    return {
      ...baseState,
      state: 'login_timeout_error_page',
    };
  }

  if (verificationTarget) {
    return {
      ...baseState,
      state: 'verification_page',
    };
  }

  if (addPhonePage) {
    return {
      ...baseState,
      state: 'add_phone_page',
    };
  }

  if (passwordInput || switchTrigger) {
    return {
      ...baseState,
      state: 'password_page',
    };
  }

  if (emailInput) {
    return {
      ...baseState,
      state: 'email_page',
    };
  }

  if (verificationVisible) {
    return {
      ...baseState,
      state: 'verification_page',
    };
  }

  return baseState;
}

function serializeLoginAuthState(snapshot) {
  return {
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    path: snapshot?.path || location.pathname || '',
    displayedEmail: snapshot?.displayedEmail || '',
    retryEnabled: Boolean(snapshot?.retryEnabled),
    titleMatched: Boolean(snapshot?.titleMatched),
    detailMatched: Boolean(snapshot?.detailMatched),
    maxCheckAttemptsBlocked: Boolean(snapshot?.maxCheckAttemptsBlocked),
    hasVerificationTarget: Boolean(snapshot?.verificationTarget),
    hasPasswordInput: Boolean(snapshot?.passwordInput),
    hasEmailInput: Boolean(snapshot?.emailInput),
    hasSubmitButton: Boolean(snapshot?.submitButton),
    hasSwitchTrigger: Boolean(snapshot?.switchTrigger),
    verificationVisible: Boolean(snapshot?.verificationVisible),
    addPhonePage: Boolean(snapshot?.addPhonePage),
    oauthConsentPage: Boolean(snapshot?.oauthConsentPage),
    consentReady: Boolean(snapshot?.consentReady),
  };
}

function getLoginAuthStateLabel(snapshot) {
  const state = snapshot?.state === 'oauth_consent_page' ? 'unknown' : snapshot?.state;
  switch (state) {
    case 'verification_page':
      return '登录验证码页';
    case 'password_page':
      return '密码页';
    case 'email_page':
      return '邮箱输入页';
    case 'login_timeout_error_page':
      return '登录超时报错页';
    case 'oauth_consent_page':
      return 'OAuth 授权页';
    case 'add_phone_page':
      return '手机号页';
    default:
      return '未知页面';
  }
}

async function waitForKnownLoginAuthState(timeout = 15000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
    if (snapshot.state !== 'unknown') {
      return snapshot;
    }
    await sleep(200);
  }

  return snapshot;
}

async function waitForLoginVerificationPageReady(timeout = 10000) {
  const start = Date.now();
  let snapshot = inspectLoginAuthState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectLoginAuthState();
    if (snapshot.state === 'verification_page') {
      return snapshot;
    }
    if (snapshot.state !== 'unknown') {
      break;
    }
    await sleep(200);
  }

  throw new Error(
    `当前未进入登录验证码页面，请先重新完成步骤 7。当前状态：${getLoginAuthStateLabel(snapshot)}。URL: ${snapshot?.url || location.href}`
  );
}

function createStep6SuccessResult(snapshot, options = {}) {
  return {
    step6Outcome: 'success',
    state: snapshot?.state || 'verification_page',
    url: snapshot?.url || location.href,
    via: options.via || '',
    loginVerificationRequestedAt: options.loginVerificationRequestedAt || null,
  };
}

function createStep6RecoverableResult(reason, snapshot, options = {}) {
  return {
    step6Outcome: 'recoverable',
    reason,
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    message: options.message || '',
    loginVerificationRequestedAt: options.loginVerificationRequestedAt || null,
  };
}

async function createStep6LoginTimeoutRecoveryTransition(reason, snapshot, message, options = {}) {
  const {
    loginVerificationRequestedAt = null,
    via = 'login_timeout_recovered',
  } = options;
  let resolvedSnapshot = normalizeStep6Snapshot(snapshot || inspectLoginAuthState());
  let recovered = false;
  if (resolvedSnapshot?.state === 'login_timeout_error_page') {
    try {
      const recoveryResult = await recoverCurrentAuthRetryPage({
        flow: 'login',
        logLabel: '步骤 7：检测到登录超时报错，正在点击“重试”恢复当前页面',
        step: 7,
        timeoutMs: 12000,
      });
      recovered = Boolean(recoveryResult?.recovered);
      if (recovered) {
        log('步骤 7：登录超时报错页已点击“重试”，正在按恢复后的页面状态继续当前流程。', 'warn');
      }
    } catch (error) {
      if (/CF_SECURITY_BLOCKED::/i.test(String(error?.message || error || ''))) {
        throw error;
      }
      log(`步骤 7：登录超时报错页自动点击“重试”失败：${error.message}`, 'warn');
    }
  }

  resolvedSnapshot = recovered
    ? normalizeStep6Snapshot(await waitForKnownLoginAuthState(4000))
    : normalizeStep6Snapshot(inspectLoginAuthState());

  if (resolvedSnapshot.state === 'verification_page') {
    return {
      action: 'done',
      result: createStep6SuccessResult(resolvedSnapshot, {
        via,
        loginVerificationRequestedAt,
      }),
    };
  }

  if (resolvedSnapshot.state === 'password_page') {
    log('步骤 7：登录超时报错页恢复后已进入密码页，继续当前登录流程。', 'warn');
    return { action: 'password', snapshot: resolvedSnapshot };
  }

  if (resolvedSnapshot.state === 'email_page') {
    log('步骤 7：登录超时报错页恢复后已回到邮箱输入页，继续当前登录流程。', 'warn');
    return { action: 'email', snapshot: resolvedSnapshot };
  }

  return {
    action: 'recoverable',
    result: createStep6RecoverableResult(reason, resolvedSnapshot, {
      message,
      loginVerificationRequestedAt,
    }),
  };
}

async function createStep6LoginTimeoutRecoverableResult(reason, snapshot, message) {
  const transition = await createStep6LoginTimeoutRecoveryTransition(reason, snapshot, message);
  if (transition?.action === 'done' || transition?.action === 'recoverable') {
    return transition.result;
  }

  return createStep6RecoverableResult(reason, transition?.snapshot || normalizeStep6Snapshot(inspectLoginAuthState()), {
    message,
  });
}

async function finalizeStep6VerificationReady(options = {}) {
  const {
    logLabel = '步骤 7 收尾',
    loginVerificationRequestedAt = null,
    timeout = 12000,
    via = 'verification_page_ready',
  } = options;
  const start = Date.now();
  const maxRounds = 3;
  const settleDelayMs = 3000;
  let round = 0;

  while (Date.now() - start < timeout && round < maxRounds) {
    throwIfStopped();
    round += 1;
    log(`${logLabel}：确认页面是否稳定停留在登录验证码阶段（第 ${round}/${maxRounds} 轮，先等待 3 秒）...`, 'info');
    await sleep(settleDelayMs);

    const rawSnapshot = inspectLoginAuthState();
    const snapshot = normalizeStep6Snapshot(rawSnapshot);

    if (snapshot.state === 'verification_page') {
      log(`${logLabel}：登录验证码页面已稳定就绪。`, 'ok');
      return createStep6SuccessResult(snapshot, {
        via,
        loginVerificationRequestedAt,
      });
    }

    if (snapshot.state === 'login_timeout_error_page') {
      log(`${logLabel}：页面进入登录超时报错页，准备自动恢复后重试步骤 7。`, 'warn');
      return createStep6LoginTimeoutRecoverableResult(
        'login_timeout_error_page',
        snapshot,
        '登录验证码页面准备就绪前进入登录超时报错页。'
      );
    }

    if (snapshot.state === 'password_page' || snapshot.state === 'email_page') {
      return createStep6RecoverableResult('verification_page_unstable', snapshot, {
        message: `页面曾进入登录验证码阶段，但又回到了${getLoginAuthStateLabel(snapshot)}，准备重新执行步骤 7。`,
        loginVerificationRequestedAt,
      });
    }

    if (snapshot.state === 'add_phone_page') {
      throw new Error(`登录验证码页面准备过程中页面进入手机号页面。URL: ${snapshot.url}`);
    }
  }

  const rawSnapshot = inspectLoginAuthState();
  const snapshot = normalizeStep6Snapshot(rawSnapshot);
  if (snapshot.state === 'verification_page') {
    log(`${logLabel}：登录验证码页面已稳定就绪。`, 'ok');
    return createStep6SuccessResult(snapshot, {
      via,
      loginVerificationRequestedAt,
    });
  }
  if (snapshot.state === 'login_timeout_error_page') {
    log(`${logLabel}：页面进入登录超时报错页，准备自动恢复后重试步骤 7。`, 'warn');
    return createStep6LoginTimeoutRecoverableResult(
      'login_timeout_error_page',
      snapshot,
      '登录验证码页面准备就绪前进入登录超时报错页。'
    );
  }
  if (snapshot.state === 'password_page' || snapshot.state === 'email_page') {
    return createStep6RecoverableResult('verification_page_unstable', snapshot, {
      message: `页面曾进入登录验证码阶段，但又回到了${getLoginAuthStateLabel(snapshot)}，准备重新执行步骤 7。`,
      loginVerificationRequestedAt,
    });
  }

  return createStep6RecoverableResult('verification_page_finalize_unknown', snapshot, {
    message: '登录验证码页面状态在收尾确认阶段未稳定，准备重新执行步骤 7。',
    loginVerificationRequestedAt,
  });
}

function normalizeStep6Snapshot(snapshot) {
  if (snapshot?.state !== 'oauth_consent_page') {
    return snapshot;
  }

  return {
    ...snapshot,
    state: 'unknown',
  };
}

function throwForStep6FatalState(snapshot) {
  snapshot = normalizeStep6Snapshot(snapshot);
  switch (snapshot?.state) {
    case 'oauth_consent_page':
      throw new Error(`当前页面已进入 OAuth 授权页，未经过登录验证码页，无法完成步骤 7。URL: ${snapshot.url}`);
    case 'add_phone_page':
      throw new Error(`当前页面已进入手机号页面，未经过登录验证码页，无法完成步骤 7。URL: ${snapshot.url}`);
    case 'unknown':
      throw new Error(`无法识别当前登录页面状态。URL: ${snapshot?.url || location.href}`);
    default:
      return;
  }
}

async function triggerLoginSubmitAction(button, fallbackField) {
  const form = button?.form || fallbackField?.form || button?.closest?.('form') || fallbackField?.closest?.('form') || null;

  await humanPause(400, 1100);
  if (button && isActionEnabled(button)) {
    simulateClick(button);
    return;
  }

  if (form && typeof form.requestSubmit === 'function') {
    if (button && button.form === form) {
      form.requestSubmit(button);
    } else {
      form.requestSubmit();
    }
    return;
  }

  if (button && typeof button.click === 'function') {
    button.click();
    return;
  }

  throw new Error('未找到可用的登录提交按钮。URL: ' + location.href);
}

function isSignupPasswordErrorPage() {
  return Boolean(getSignupPasswordTimeoutErrorPageState());
}

function isSignupEmailAlreadyExistsPage() {
  return isSignupPasswordPage() && SIGNUP_EMAIL_EXISTS_PATTERN.test(getPageTextSnapshot());
}

function inspectSignupVerificationState() {
  if (isStep5Ready()) {
    return { state: 'step5' };
  }

  if (isSignupPasswordErrorPage()) {
    const timeoutPage = getSignupPasswordTimeoutErrorPageState();
    return {
      state: 'error',
      retryButton: timeoutPage?.retryButton || null,
      userAlreadyExistsBlocked: Boolean(timeoutPage?.userAlreadyExistsBlocked),
    };
  }

  if (isVerificationPageStillVisible()) {
    return { state: 'verification' };
  }

  if (isSignupEmailAlreadyExistsPage()) {
    return { state: 'email_exists' };
  }

  const passwordInput = getSignupPasswordInput();
  if (passwordInput) {
    return {
      state: 'password',
      passwordInput,
      submitButton: getSignupPasswordSubmitButton({ allowDisabled: true }),
    };
  }

  return { state: 'unknown' };
}

async function waitForSignupVerificationTransition(timeout = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const snapshot = inspectSignupVerificationState();
    if (snapshot.state === 'step5' || snapshot.state === 'verification' || snapshot.state === 'error' || snapshot.state === 'email_exists') {
      return snapshot;
    }

    await sleep(200);
  }

  return inspectSignupVerificationState();
}

async function prepareSignupVerificationFlow(payload = {}, timeout = 30000) {
  const { password } = payload;
  const prepareSource = String(payload?.prepareSource || '').trim() || 'step4_execute';
  const prepareLogLabel = String(payload?.prepareLogLabel || '').trim()
    || (prepareSource === 'step3_finalize' ? '步骤 3 收尾' : '步骤 4 执行');
  const start = Date.now();
  let recoveryRound = 0;
  const maxRecoveryRounds = 3;
  let passwordPageDiagnosticsLogged = false;

  while (Date.now() - start < timeout && recoveryRound < maxRecoveryRounds) {
    throwIfStopped();

    const roundNo = recoveryRound + 1;
    log(`${prepareLogLabel}：等待页面进入验证码阶段（第 ${roundNo}/${maxRecoveryRounds} 轮，先等待 5 秒）...`, 'info');
    const snapshot = await waitForSignupVerificationTransition(5000);

    if (snapshot.state === 'step5') {
      log(`${prepareLogLabel}：页面已进入验证码后的下一阶段，本步骤按已完成处理。`, 'ok');
      return { ready: true, alreadyVerified: true, retried: recoveryRound, prepareSource };
    }

    if (snapshot.state === 'verification') {
      log(`${prepareLogLabel}：验证码页面已就绪${recoveryRound ? `（期间自动恢复 ${recoveryRound} 次）` : ''}。`, 'ok');
      return { ready: true, retried: recoveryRound, prepareSource };
    }

    if (snapshot.state === 'email_exists') {
      throw new Error('当前邮箱已存在，需要重新开始新一轮。');
    }

    recoveryRound += 1;

    if (snapshot.state === 'error') {
      if (snapshot.userAlreadyExistsBlocked) {
        throw createSignupUserAlreadyExistsError();
      }
      await recoverCurrentAuthRetryPage({
        flow: 'signup',
        logLabel: `${prepareLogLabel}：检测到注册认证重试页，正在点击“重试”恢复（第 ${recoveryRound}/${maxRecoveryRounds} 次）`,
        step: 4,
        timeoutMs: 12000,
      });
      continue;
    }

    if (snapshot.state === 'password') {
      if (!passwordPageDiagnosticsLogged) {
        passwordPageDiagnosticsLogged = true;
        logSignupPasswordDiagnostics(`${prepareLogLabel}：页面仍停留在密码页`);
      }
      if (!password) {
        throw new Error('当前回到了密码页，但没有可用密码，无法自动重新提交。');
      }

      if ((snapshot.passwordInput.value || '') !== password) {
        log(`${prepareLogLabel}：页面仍停留在密码页，正在重新填写密码...`, 'warn');
        await humanPause(450, 1100);
        fillInput(snapshot.passwordInput, password);
      }

      if (snapshot.submitButton && isActionEnabled(snapshot.submitButton)) {
        log(`${prepareLogLabel}：页面仍停留在密码页，正在重新点击“继续”（第 ${recoveryRound}/${maxRecoveryRounds} 次）...`, 'warn');
        await humanPause(350, 900);
        simulateClick(snapshot.submitButton);
        await sleep(1200);
        continue;
      }

      log(`${prepareLogLabel}：页面仍停留在密码页，但“继续”按钮暂不可用，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
      continue;
    }

    log(`${prepareLogLabel}：页面仍在切换中，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
  }

  throw new Error(`等待注册验证码页面就绪超时或自动恢复失败（已尝试 ${recoveryRound}/${maxRecoveryRounds} 轮）。URL: ${location.href}`);
}


async function waitForVerificationSubmitOutcome(step, timeout) {
  const resolvedTimeout = timeout ?? (step === 8 ? 30000 : 12000);
  const start = Date.now();
  let recoveryCount = 0;
  const maxRecoveryCount = 2;

  while (Date.now() - start < resolvedTimeout) {
    throwIfStopped();

    const retryFlow = step === 4 ? 'signup' : 'login';
    const retryState = getCurrentAuthRetryPageState(retryFlow);
    if (retryState?.userAlreadyExistsBlocked) {
      throw createSignupUserAlreadyExistsError();
    }
    if (retryState) {
      if (recoveryCount >= maxRecoveryCount) {
        throw new Error(`步骤 ${step}：验证码提交后连续进入认证重试页 ${maxRecoveryCount} 次，页面仍未恢复。URL: ${location.href}`);
      }
      recoveryCount += 1;
      log(`步骤 ${step}：验证码提交后进入认证重试页，正在自动恢复（${recoveryCount}/${maxRecoveryCount}）...`, 'warn');
      await recoverCurrentAuthRetryPage({
        flow: retryFlow,
        logLabel: `步骤 ${step}：验证码提交后检测到认证重试页，正在点击“重试”恢复`,
        step,
        timeoutMs: 12000,
      });
      continue;
    }

    const errorText = getVerificationErrorText();
    if (errorText) {
      return { invalidCode: true, errorText };
    }

    if (step === 4 && isStep5Ready()) {
      return { success: true };
    }

    if (step === 8 && isStep8Ready()) {
      return { success: true };
    }

    if (step === 8 && isAddPhonePageReady()) {
      return { success: true, addPhonePage: true, url: location.href };
    }

    await sleep(150);
  }

  if (step === 4) {
    const signupRetryState = getCurrentAuthRetryPageState('signup');
    if (signupRetryState?.userAlreadyExistsBlocked) {
      throw createSignupUserAlreadyExistsError();
    }
  }

  if (isVerificationPageStillVisible()) {
    return {
      invalidCode: true,
      errorText: getVerificationErrorText() || '提交后仍停留在验证码页面，准备重新发送验证码。',
    };
  }

  return { success: true, assumed: true };
}

function getVerificationSubmitButtonForTarget(codeInput, options = {}) {
  const { allowDisabled = false } = options;
  const form = codeInput?.form || codeInput?.closest?.('form') || null;
  const isUsableAction = (element) => {
    if (!element || !isVisibleElement(element)) return false;
    return allowDisabled || isActionEnabled(element);
  };

  const findSubmitInRoot = (root) => {
    if (!root?.querySelectorAll) return null;

    const directCandidates = root.querySelectorAll('button[type="submit"], input[type="submit"]');
    for (const element of directCandidates) {
      if (isUsableAction(element)) {
        return element;
      }
    }

    const textCandidates = root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
    return Array.from(textCandidates).find((element) => {
      if (!isUsableAction(element)) return false;
      const text = getActionText(element);
      return /verify|confirm|submit|continue|确认|验证|继续/i.test(text);
    }) || null;
  };

  return findSubmitInRoot(form) || findSubmitInRoot(document);
}

async function waitForVerificationSubmitButton(codeInput, timeout = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (is405MethodNotAllowedPage()) {
      throw new Error('当前页面处于 405 错误恢复流程中，暂时无法定位验证码提交按钮。');
    }

    const button = getVerificationSubmitButtonForTarget(codeInput, { allowDisabled: false });
    if (button) {
      return button;
    }

    await sleep(150);
  }

  return null;
}

async function waitForVerificationCodeTarget(timeout = 10000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (is405MethodNotAllowedPage()) {
      throw new Error('当前页面处于 405 错误恢复流程中，暂时无法定位验证码输入框。');
    }

    const target = getVerificationCodeTarget();
    if (target) {
      return target;
    }

    await sleep(150);
  }

  throw new Error('未找到验证码输入框。URL: ' + location.href);
}

async function waitForSplitVerificationInputsFilled(inputs, code, timeout = 2500) {
  const expected = String(code || '').slice(0, 6);
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const current = Array.from(inputs || [])
      .slice(0, expected.length)
      .map((input) => String(input?.value || '').trim())
      .join('');

    if (current === expected) {
      return true;
    }

    await sleep(100);
  }

  return false;
}

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('未提供验证码。');

  log(`步骤 ${step}：正在填写验证码：${code}`);

  if (step === 8) {
    await waitForLoginVerificationPageReady();
  }

  // Find code input — could be a single input or multiple separate inputs
  // Retry with 405 error recovery if needed
  const maxRetries = 3;
  let codeInput = null;
  let splitInputs = null;

  for (let retry = 0; retry <= maxRetries; retry++) {
    throwIfStopped();

    // Before looking for input, check if page is in 405 error state
    if (is405MethodNotAllowedPage()) {
      log(`步骤 ${step}：检测到 405 错误页面，正在恢复...`, 'warn');
      await handle405ResendError(step, 30000);
      continue;
    }

    try {
      const verificationTarget = await waitForVerificationCodeTarget(10000);
      if (verificationTarget.type === 'split') {
        splitInputs = verificationTarget.elements;
      } else {
        codeInput = verificationTarget.element;
      }
      break; // Found it
    } catch {
      // No input found — check if it's a 405 error and can be recovered
      if (is405MethodNotAllowedPage() && retry < maxRetries) {
        log(`步骤 ${step}：未找到验证码输入框且页面出现 405 错误，正在恢复...`, 'warn');
        await handle405ResendError(step, 30000);
        continue;
      }

      throw new Error('未找到验证码输入框。URL: ' + location.href);
    }
  }

  if (splitInputs?.length >= 6) {
    log(`步骤 ${step}：发现分开的单字符验证码输入框，正在逐个填写...`);
    for (let i = 0; i < 6 && i < splitInputs.length; i++) {
      const targetInput = splitInputs[i];
      try {
        targetInput.focus?.();
      } catch {}
      fillInput(splitInputs[i], code[i]);
      try {
        targetInput.dispatchEvent(new KeyboardEvent('keyup', { key: code[i], bubbles: true }));
      } catch {}
      await sleep(100);
    }
    const filled = await waitForSplitVerificationInputsFilled(splitInputs, code, 2500);
    if (!filled) {
      const current = Array.from(splitInputs)
        .slice(0, 6)
        .map((input) => String(input?.value || '').trim() || '_')
        .join('');
      log(`步骤 ${step}：分格验证码输入框未稳定呈现目标值，当前页面值为 ${current}，准备继续观察提交流程。`, 'warn');
    } else {
      log(`步骤 ${step}：分格验证码输入框已稳定显示 ${code}。`, 'info');
    }

    await sleep(800);
    const splitSubmitBtn = await waitForVerificationSubmitButton(splitInputs[0], 2000).catch(() => null);
    if (splitSubmitBtn) {
      await humanPause(450, 1200);
      simulateClick(splitSubmitBtn);
      log(`步骤 ${step}：分格验证码已提交`);
    } else {
      log(`步骤 ${step}：分格验证码页面未找到可点击提交按钮，继续等待页面自动推进。`, 'info');
    }

    const outcome = await waitForVerificationSubmitOutcome(step);
    if (outcome.invalidCode) {
      log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
    } else if (outcome.addPhonePage) {
      log(`步骤 ${step}：验证码提交后页面进入手机号页面，当前流程将停止自动授权。`, 'warn');
    } else {
      log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
    }
    return outcome;
  }

  if (!codeInput) {
    throw new Error('未找到验证码输入框。URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`步骤 ${step}：验证码已填写`);

  // Submit
  await sleep(800);
  const submitBtn = await waitForVerificationSubmitButton(codeInput, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`步骤 ${step}：验证码已提交`);
  } else {
    log(`步骤 ${step}：未找到可提交的验证码按钮，先等待页面自动推进或反馈结果。`, 'warn');
  }

  const outcome = await waitForVerificationSubmitOutcome(step);
  if (outcome.invalidCode) {
    log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
  } else if (outcome.addPhonePage) {
    log(`步骤 ${step}：验证码提交后页面进入手机号页面，当前流程将停止自动授权。`, 'warn');
  } else {
    log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
  }

  return outcome;
}

// ============================================================
// Step 7: Login with registered account (on OAuth auth page)
// ============================================================

async function waitForStep6EmailSubmitTransition(emailSubmittedAt, timeout = 12000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

    if (snapshot.state === 'verification_page') {
      return {
        action: 'done',
        result: createStep6SuccessResult(snapshot, {
          via: 'email_submit',
          loginVerificationRequestedAt: emailSubmittedAt,
        }),
      };
    }

    if (snapshot.state === 'password_page') {
      return { action: 'password', snapshot };
    }

    if (snapshot.state === 'login_timeout_error_page') {
      const transition = await createStep6LoginTimeoutRecoveryTransition(
        'login_timeout_error_page',
        snapshot,
        '提交邮箱后进入登录超时报错页。',
        {
          loginVerificationRequestedAt: emailSubmittedAt,
          via: 'email_submit_timeout_recovered',
        }
      );
      if (transition.action === 'done') {
        return {
          action: 'done',
          result: transition.result,
        };
      }
      if (transition.action === 'password') {
        return { action: 'password', snapshot: transition.snapshot };
      }
      if (transition.action === 'email') {
        return { action: 'email', snapshot: transition.snapshot };
      }
      return {
        action: 'recoverable',
        result: transition.result,
      };
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`提交邮箱后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      throw new Error(`提交邮箱后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    await sleep(250);
  }

  snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
  if (snapshot.state === 'verification_page') {
    return {
      action: 'done',
      result: createStep6SuccessResult(snapshot, {
        via: 'email_submit',
        loginVerificationRequestedAt: emailSubmittedAt,
      }),
    };
  }
  if (snapshot.state === 'password_page') {
    return { action: 'password', snapshot };
  }
  if (snapshot.state === 'login_timeout_error_page') {
    const transition = await createStep6LoginTimeoutRecoveryTransition(
      'login_timeout_error_page',
      snapshot,
      '提交邮箱后进入登录超时报错页。',
      {
        loginVerificationRequestedAt: emailSubmittedAt,
        via: 'email_submit_timeout_recovered',
      }
    );
    if (transition.action === 'done') {
      return {
        action: 'done',
        result: transition.result,
      };
    }
    if (transition.action === 'password') {
      return { action: 'password', snapshot: transition.snapshot };
    }
    if (transition.action === 'email') {
      return { action: 'email', snapshot: transition.snapshot };
    }
    return {
      action: 'recoverable',
      result: transition.result,
    };
  }
  if (snapshot.state === 'oauth_consent_page') {
    throw new Error(`提交邮箱后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'add_phone_page') {
    throw new Error(`提交邮箱后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
  }

  return {
    action: 'recoverable',
    result: createStep6RecoverableResult('email_submit_stalled', snapshot, {
      message: '提交邮箱后长时间未进入密码页或登录验证码页。',
    }),
  };
}

async function waitForStep6PasswordSubmitTransition(passwordSubmittedAt, timeout = 10000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

    if (snapshot.state === 'verification_page') {
      return {
        action: 'done',
        result: createStep6SuccessResult(snapshot, {
          via: 'password_submit',
          loginVerificationRequestedAt: passwordSubmittedAt,
        }),
      };
    }

    if (snapshot.state === 'login_timeout_error_page') {
      const transition = await createStep6LoginTimeoutRecoveryTransition(
        'login_timeout_error_page',
        snapshot,
        '提交密码后进入登录超时报错页。',
        {
          loginVerificationRequestedAt: passwordSubmittedAt,
          via: 'password_submit_timeout_recovered',
        }
      );
      if (transition.action === 'done') {
        return {
          action: 'done',
          result: transition.result,
        };
      }
      if (transition.action === 'password') {
        return { action: 'password', snapshot: transition.snapshot };
      }
      if (transition.action === 'email') {
        return { action: 'email', snapshot: transition.snapshot };
      }
      return {
        action: 'recoverable',
        result: transition.result,
      };
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`提交密码后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      throw new Error(`提交密码后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    await sleep(250);
  }

  snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
  if (snapshot.state === 'verification_page') {
    return {
      action: 'done',
      result: createStep6SuccessResult(snapshot, {
        via: 'password_submit',
        loginVerificationRequestedAt: passwordSubmittedAt,
      }),
    };
  }
  if (snapshot.state === 'login_timeout_error_page') {
    const transition = await createStep6LoginTimeoutRecoveryTransition(
      'login_timeout_error_page',
      snapshot,
      '提交密码后进入登录超时报错页。',
      {
        loginVerificationRequestedAt: passwordSubmittedAt,
        via: 'password_submit_timeout_recovered',
      }
    );
    if (transition.action === 'done') {
      return {
        action: 'done',
        result: transition.result,
      };
    }
    if (transition.action === 'password') {
      return { action: 'password', snapshot: transition.snapshot };
    }
    if (transition.action === 'email') {
      return { action: 'email', snapshot: transition.snapshot };
    }
    return {
      action: 'recoverable',
      result: transition.result,
    };
  }
  if (snapshot.state === 'oauth_consent_page') {
    throw new Error(`提交密码后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'add_phone_page') {
    throw new Error(`提交密码后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'password_page' && snapshot.switchTrigger) {
    return { action: 'switch', snapshot };
  }

  return {
    action: 'recoverable',
    result: createStep6RecoverableResult('password_submit_stalled', snapshot, {
      message: '提交密码后仍未进入登录验证码页。',
    }),
  };
}

async function waitForStep6SwitchTransition(loginVerificationRequestedAt, timeout = 10000) {
  const start = Date.now();
  let snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = normalizeStep6Snapshot(inspectLoginAuthState());

    if (snapshot.state === 'verification_page') {
      return createStep6SuccessResult(snapshot, {
        via: 'switch_to_one_time_code_login',
        loginVerificationRequestedAt,
      });
    }

    if (snapshot.state === 'login_timeout_error_page') {
      const transition = await createStep6LoginTimeoutRecoveryTransition(
        'login_timeout_error_page',
        snapshot,
        '切换到一次性验证码登录后进入登录超时报错页。',
        {
          loginVerificationRequestedAt,
          via: 'switch_to_one_time_code_timeout_recovered',
        }
      );
      if (transition.action === 'done') {
        return transition.result;
      }
      if (transition.action === 'password' || transition.action === 'email') {
        return transition;
      }
      return transition.result;
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`切换到一次性验证码登录后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      throw new Error(`切换到一次性验证码登录后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    await sleep(250);
  }

  snapshot = normalizeStep6Snapshot(inspectLoginAuthState());
  if (snapshot.state === 'verification_page') {
    return createStep6SuccessResult(snapshot, {
      via: 'switch_to_one_time_code_login',
      loginVerificationRequestedAt,
    });
  }
  if (snapshot.state === 'login_timeout_error_page') {
    const transition = await createStep6LoginTimeoutRecoveryTransition(
      'login_timeout_error_page',
      snapshot,
      '切换到一次性验证码登录后进入登录超时报错页。',
      {
        loginVerificationRequestedAt,
        via: 'switch_to_one_time_code_timeout_recovered',
      }
    );
    if (transition.action === 'done') {
      return transition.result;
    }
    if (transition.action === 'password' || transition.action === 'email') {
      return transition;
    }
    return transition.result;
  }
  if (snapshot.state === 'oauth_consent_page') {
    throw new Error(`切换到一次性验证码登录后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
  }
  if (snapshot.state === 'add_phone_page') {
    throw new Error(`切换到一次性验证码登录后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
  }

  return createStep6RecoverableResult('one_time_code_switch_stalled', snapshot, {
    message: '点击一次性验证码登录后仍未进入登录验证码页。',
  });
}

async function step6SwitchToOneTimeCodeLogin(payload, snapshot) {
  const switchTrigger = snapshot?.switchTrigger || findOneTimeCodeLoginTrigger();
  if (!switchTrigger || !isActionEnabled(switchTrigger)) {
    return createStep6RecoverableResult('missing_one_time_code_trigger', normalizeStep6Snapshot(inspectLoginAuthState()), {
      message: '当前登录页没有可用的一次性验证码登录入口。',
    });
  }

  log('步骤 7：已检测到一次性验证码登录入口，准备切换...');
  const loginVerificationRequestedAt = Date.now();
  await humanPause(350, 900);
  simulateClick(switchTrigger);
  log('步骤 7：已点击一次性验证码登录');
  await sleep(1200);
  const result = await waitForStep6SwitchTransition(loginVerificationRequestedAt);
  if (result?.step6Outcome === 'success') {
    return finalizeStep6VerificationReady({
      logLabel: '步骤 7 收尾',
      loginVerificationRequestedAt: result.loginVerificationRequestedAt || loginVerificationRequestedAt,
      via: result.via || 'switch_to_one_time_code_login',
    });
  }
  if (result?.action === 'password') {
    return step6LoginFromPasswordPage(payload, result.snapshot);
  }
  if (result?.action === 'email') {
    return step6LoginFromEmailPage(payload, result.snapshot);
  }
  return result;
}

async function step6LoginFromPasswordPage(payload, snapshot) {
  const currentSnapshot = normalizeStep6Snapshot(snapshot || inspectLoginAuthState());
  const hasPassword = Boolean(String(payload?.password || '').trim());

  if (currentSnapshot.passwordInput) {
    if (!hasPassword) {
      if (currentSnapshot.switchTrigger) {
        log('步骤 7：当前未提供密码，改走一次性验证码登录。', 'warn');
        return step6SwitchToOneTimeCodeLogin(payload, currentSnapshot);
      }

      return createStep6RecoverableResult('missing_password_and_one_time_code_trigger', currentSnapshot, {
        message: '登录时未提供密码，且当前页面没有可用的一次性验证码登录入口。',
      });
    }

    log('步骤 7：已进入密码页，准备填写密码...');
    await humanPause(550, 1450);
    fillInput(currentSnapshot.passwordInput, payload.password);
    log('步骤 7：已填写密码');

    await sleep(500);
    const passwordSubmittedAt = Date.now();
    await triggerLoginSubmitAction(currentSnapshot.submitButton, currentSnapshot.passwordInput);
    log('步骤 7：已提交密码');

    const transition = await waitForStep6PasswordSubmitTransition(passwordSubmittedAt);
    if (transition.action === 'done') {
      return finalizeStep6VerificationReady({
        logLabel: '步骤 7 收尾',
        loginVerificationRequestedAt: transition.result.loginVerificationRequestedAt || passwordSubmittedAt,
        via: transition.result.via || 'password_submit',
      });
    }
    if (transition.action === 'recoverable') {
      log(`步骤 7：${transition.result.message || '提交密码后仍未进入登录验证码页面，准备重新执行步骤 7。'}`, 'warn');
      return transition.result;
    }
    if (transition.action === 'password') {
      return step6LoginFromPasswordPage(payload, transition.snapshot);
    }
    if (transition.action === 'email') {
      return step6LoginFromEmailPage(payload, transition.snapshot);
    }
    if (transition.action === 'switch') {
      return step6SwitchToOneTimeCodeLogin(payload, transition.snapshot);
    }

    return createStep6RecoverableResult('password_submit_unknown', normalizeStep6Snapshot(inspectLoginAuthState()), {
      message: '提交密码后未得到可用的下一步状态。',
    });
  }

  if (currentSnapshot.switchTrigger) {
    return step6SwitchToOneTimeCodeLogin(payload, currentSnapshot);
  }

  return createStep6RecoverableResult('password_page_unactionable', currentSnapshot, {
    message: '当前停留在登录页，但没有可提交密码的输入框，也没有一次性验证码登录入口。',
  });
}

async function step6LoginFromEmailPage(payload, snapshot) {
  const currentSnapshot = normalizeStep6Snapshot(snapshot || inspectLoginAuthState());
  const emailInput = currentSnapshot.emailInput || getLoginEmailInput();
  if (!emailInput) {
    throw new Error('在登录页未找到邮箱输入框。URL: ' + location.href);
  }

  if ((emailInput.value || '').trim() !== payload.email) {
    await humanPause(500, 1400);
    fillInput(emailInput, payload.email);
    log('步骤 7：已填写邮箱');
  } else {
    log('步骤 7：邮箱已在输入框中，准备提交...');
  }

  await sleep(500);
  const emailSubmittedAt = Date.now();
  await triggerLoginSubmitAction(currentSnapshot.submitButton, emailInput);
  log('步骤 7：已提交邮箱');

  const transition = await waitForStep6EmailSubmitTransition(emailSubmittedAt);
  if (transition.action === 'done') {
    return finalizeStep6VerificationReady({
      logLabel: '步骤 7 收尾',
      loginVerificationRequestedAt: transition.result.loginVerificationRequestedAt || emailSubmittedAt,
      via: transition.result.via || 'email_submit',
    });
  }
  if (transition.action === 'recoverable') {
    log(`步骤 7：${transition.result.message || '提交邮箱后仍未进入目标页面，准备重新执行步骤 7。'}`, 'warn');
    return transition.result;
  }
  if (transition.action === 'email') {
    return step6LoginFromEmailPage(payload, transition.snapshot);
  }
  if (transition.action === 'password') {
    return step6LoginFromPasswordPage(payload, transition.snapshot);
  }

  return createStep6RecoverableResult('email_submit_unknown', normalizeStep6Snapshot(inspectLoginAuthState()), {
    message: '提交邮箱后未得到可用的下一步状态。',
  });
}

async function step6_login(payload) {
  const { email } = payload;
  if (!email) throw new Error('登录时缺少邮箱地址。');

  const snapshot = normalizeStep6Snapshot(await waitForKnownLoginAuthState(15000));

  if (snapshot.state === 'verification_page') {
    log('步骤 7：认证页已在登录验证码页，开始确认页面是否稳定。');
    return finalizeStep6VerificationReady({
      logLabel: '步骤 7 收尾',
      loginVerificationRequestedAt: null,
      via: 'already_on_verification_page',
    });
  }

  if (snapshot.state === 'login_timeout_error_page') {
    log('步骤 7：检测到登录超时报错页，先尝试恢复当前页面。', 'warn');
    const transition = await createStep6LoginTimeoutRecoveryTransition(
      'login_timeout_error_page',
      snapshot,
      '当前页面处于登录超时报错页。',
      {
        loginVerificationRequestedAt: null,
        via: 'login_timeout_initial_recovered',
      }
    );
    if (transition.action === 'done') {
      return finalizeStep6VerificationReady({
        logLabel: '步骤 7 收尾',
        loginVerificationRequestedAt: transition.result.loginVerificationRequestedAt || null,
        via: transition.result.via || 'login_timeout_initial_recovered',
      });
    }
    if (transition.action === 'email') {
      return step6LoginFromEmailPage(payload, transition.snapshot);
    }
    if (transition.action === 'password') {
      return step6LoginFromPasswordPage(payload, transition.snapshot);
    }
    return transition.result;
  }

  if (snapshot.state === 'email_page') {
    log(`步骤 7：正在使用 ${email} 登录...`);
    return step6LoginFromEmailPage(payload, snapshot);
  }

  if (snapshot.state === 'password_page') {
    log('步骤 7：认证页已在密码页，继续当前登录流程。');
    return step6LoginFromPasswordPage(payload, snapshot);
  }

  throwForStep6FatalState(snapshot);
  throw new Error(`无法识别当前登录页面状态。URL: ${snapshot?.url || location.href}`);
}

// ============================================================
// Step 9: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('步骤 9：正在查找 OAuth 同意页的“继续”按钮...');

  const continueBtn = await prepareStep8ContinueButton();

  const rect = getSerializableRect(continueBtn);
  log('步骤 9：已找到“继续”按钮并准备好调试器点击坐标。');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

function getStep8State() {
  const continueBtn = getPrimaryContinueButton();
  const retryState = getCurrentAuthRetryPageState('auth');
  const state = {
    url: location.href,
    consentPage: isOAuthConsentPage(),
    consentReady: isStep8Ready(),
    verificationPage: isVerificationPageStillVisible(),
    addPhonePage: isAddPhonePageReady(),
    retryPage: Boolean(retryState),
    retryEnabled: Boolean(retryState?.retryEnabled),
    retryTitleMatched: Boolean(retryState?.titleMatched),
    retryDetailMatched: Boolean(retryState?.detailMatched),
    maxCheckAttemptsBlocked: Boolean(retryState?.maxCheckAttemptsBlocked),
    buttonFound: Boolean(continueBtn),
    buttonEnabled: isButtonEnabled(continueBtn),
    buttonText: continueBtn ? getActionText(continueBtn) : '',
  };

  if (continueBtn) {
    try {
      state.rect = getSerializableRect(continueBtn);
    } catch {
      state.rect = null;
    }
  }

  return state;
}

async function step8_triggerContinue(payload = {}) {
  const strategy = payload?.strategy || 'requestSubmit';
  const continueBtn = await prepareStep8ContinueButton({
    findTimeoutMs: payload?.findTimeoutMs,
    enabledTimeoutMs: payload?.enabledTimeoutMs,
  });
  const form = continueBtn.form || continueBtn.closest('form');

  switch (strategy) {
    case 'requestSubmit':
      if (!form || typeof form.requestSubmit !== 'function') {
        throw new Error('“继续”按钮当前不在可提交的 form 中，无法使用 requestSubmit。URL: ' + location.href);
      }
      form.requestSubmit(continueBtn);
      break;
    case 'nativeClick':
      continueBtn.click();
      break;
    case 'dispatchClick':
      simulateClick(continueBtn);
      break;
    default:
      throw new Error(`未知的 Step 9 触发策略：${strategy}`);
  }

  log(`Step 9: continue button triggered via ${strategy}.`);
  return {
    strategy,
    ...getStep8State(),
  };
}

async function prepareStep8ContinueButton(options = {}) {
  const {
    findTimeoutMs = 10000,
    enabledTimeoutMs = 8000,
  } = options;

  const continueBtn = await findContinueButton(findTimeoutMs);
  await waitForButtonEnabled(continueBtn, enabledTimeoutMs);

  await humanPause(250, 700);
  continueBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
  continueBtn.focus();
  await waitForStableButtonRect(continueBtn);
  return continueBtn;
}

async function findContinueButton(timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isAddPhonePageReady()) {
      throw new Error('当前页面已进入手机号页面，不是 OAuth 授权同意页。URL: ' + location.href);
    }
    const button = getPrimaryContinueButton();
    if (button && isStep8Ready()) {
      return button;
    }
    await sleep(150);
  }

  throw new Error('在 OAuth 同意页未找到“继续”按钮，或页面尚未进入授权同意状态。URL: ' + location.href);
}

async function waitForButtonEnabled(button, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    throwIfStopped();
    if (isButtonEnabled(button)) return;
    await sleep(150);
  }
  throw new Error('“继续”按钮长时间不可点击。URL: ' + location.href);
}

function isButtonEnabled(button) {
  return Boolean(button)
    && !button.disabled
    && button.getAttribute('aria-disabled') !== 'true';
}

async function waitForStableButtonRect(button, timeout = 1500) {
  let previous = null;
  let stableSamples = 0;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const rect = button?.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0) {
      const snapshot = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };

      if (
        previous
        && Math.abs(snapshot.left - previous.left) < 1
        && Math.abs(snapshot.top - previous.top) < 1
        && Math.abs(snapshot.width - previous.width) < 1
        && Math.abs(snapshot.height - previous.height) < 1
      ) {
        stableSamples += 1;
        if (stableSamples >= 2) {
          return;
        }
      } else {
        stableSamples = 0;
      }

      previous = snapshot;
    }

    await sleep(80);
  }
}

function getSerializableRect(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    throw new Error('滚动后“继续”按钮没有可点击尺寸。URL: ' + location.href);
  }

  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    centerX: rect.left + (rect.width / 2),
    centerY: rect.top + (rect.height / 2),
  };
}

// ============================================================
// Step 5: Fill Name & Birthday / Age
// ============================================================

function getStep5DirectCompletionPayload({ isAgeMode = false } = {}) {
  const payload = {
    skippedPostSubmitCheck: true,
    directProceedToStep6: true,
  };
  if (isAgeMode) {
    payload.ageMode = true;
  }
  return payload;
}

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (!firstName || !lastName) throw new Error('未提供姓名数据。');

  const resolvedAge = age ?? (year ? new Date().getFullYear() - Number(year) : null);
  const hasBirthdayData = [year, month, day].every(value => value != null && !Number.isNaN(Number(value)));
  if (!hasBirthdayData && (resolvedAge == null || Number.isNaN(Number(resolvedAge)))) {
    throw new Error('未提供生日或年龄数据。');
  }

  const fullName = `${firstName} ${lastName}`;
  log(`步骤 5：正在填写姓名：${fullName}`);

  // Actual DOM structure:
  // - Full name: <input name="name" placeholder="全名" type="text">
  // - Birthday: React Aria DateField or hidden input[name="birthday"]
  // - Age: <input name="age" type="text|number">

  // --- Full Name (single field, not first+last) ---
  let nameInput = null;
  try {
    nameInput = await waitForElement(
      'input[name="name"], input[placeholder*="全名"], input[autocomplete="name"]',
      10000
    );
  } catch {
    throw new Error('未找到姓名输入框。URL: ' + location.href);
  }
  await humanPause(500, 1300);
  fillInput(nameInput, fullName);
  log(`步骤 5：姓名已填写：${fullName}`);

  let birthdayMode = false;
  let ageInput = null;
  let yearSpinner = null;
  let monthSpinner = null;
  let daySpinner = null;
  let hiddenBirthday = null;
  let yearReactSelect = null;
  let monthReactSelect = null;
  let dayReactSelect = null;
  let visibleAgeInput = false;
  let visibleBirthdaySpinners = false;
  let visibleBirthdaySelects = false;

  for (let i = 0; i < 100; i++) {
    yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    hiddenBirthday = document.querySelector('input[name="birthday"]');
    ageInput = document.querySelector('input[name="age"]');
    yearReactSelect = findBirthdayReactAriaSelect('年');
    monthReactSelect = findBirthdayReactAriaSelect('月');
    dayReactSelect = findBirthdayReactAriaSelect('天');

    visibleAgeInput = Boolean(ageInput && isVisibleElement(ageInput));
    visibleBirthdaySpinners = Boolean(
      yearSpinner
      && monthSpinner
      && daySpinner
      && isVisibleElement(yearSpinner)
      && isVisibleElement(monthSpinner)
      && isVisibleElement(daySpinner)
    );
    visibleBirthdaySelects = Boolean(
      yearReactSelect?.button
      && monthReactSelect?.button
      && dayReactSelect?.button
      && isVisibleElement(yearReactSelect.button)
      && isVisibleElement(monthReactSelect.button)
      && isVisibleElement(dayReactSelect.button)
    );

    if (visibleAgeInput) break;
    if (visibleBirthdaySpinners || visibleBirthdaySelects) {
      birthdayMode = true;
      break;
    }
    await sleep(100);
  }

  if (birthdayMode) {
    if (!hasBirthdayData) {
      throw new Error('检测到生日字段，但未提供生日数据。');
    }

    const yearSpinner = document.querySelector('[role="spinbutton"][data-type="year"]');
    const monthSpinner = document.querySelector('[role="spinbutton"][data-type="month"]');
    const daySpinner = document.querySelector('[role="spinbutton"][data-type="day"]');
    const yearReactSelect = findBirthdayReactAriaSelect('年');
    const monthReactSelect = findBirthdayReactAriaSelect('月');
    const dayReactSelect = findBirthdayReactAriaSelect('天');

    if (yearReactSelect?.nativeSelect && monthReactSelect?.nativeSelect && dayReactSelect?.nativeSelect) {
      const desiredDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const hiddenBirthday = document.querySelector('input[name="birthday"]');

      log('步骤 5：检测到 React Aria 下拉生日字段，正在填写生日...');
      await humanPause(450, 1100);
      await setReactAriaBirthdaySelect(yearReactSelect, year);
      await humanPause(250, 650);
      await setReactAriaBirthdaySelect(monthReactSelect, month);
      await humanPause(250, 650);
      await setReactAriaBirthdaySelect(dayReactSelect, day);

      if (hiddenBirthday) {
        const start = Date.now();
        while (Date.now() - start < 2000) {
          if ((hiddenBirthday.value || '') === desiredDate) break;
          await sleep(100);
        }

        if ((hiddenBirthday.value || '') !== desiredDate) {
          throw new Error(`生日值未成功写入页面。期望 ${desiredDate}，实际 ${(hiddenBirthday.value || '空')}。`);
        }
      }

      log(`步骤 5：React Aria 生日已填写：${desiredDate}`);
    }

    if (yearSpinner && monthSpinner && daySpinner) {
      log('步骤 5：检测到生日字段，正在填写生日...');

      async function setSpinButton(el, value) {
        el.focus();
        await sleep(100);
        document.execCommand('selectAll', false, null);
        await sleep(50);

        const valueStr = String(value);
        for (const char of valueStr) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Digit${char}`, bubbles: true }));
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true }));
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
          await sleep(50);
        }

        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
        el.blur();
        await sleep(100);
      }

      await humanPause(450, 1100);
      await setSpinButton(yearSpinner, year);
      await humanPause(250, 650);
      await setSpinButton(monthSpinner, String(month).padStart(2, '0'));
      await humanPause(250, 650);
      await setSpinButton(daySpinner, String(day).padStart(2, '0'));
      log(`步骤 5：生日已填写：${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }

    const hiddenBirthday = document.querySelector('input[name="birthday"]');
    if (hiddenBirthday) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      hiddenBirthday.value = dateStr;
      hiddenBirthday.dispatchEvent(new Event('input', { bubbles: true }));
      hiddenBirthday.dispatchEvent(new Event('change', { bubbles: true }));
      log(`步骤 5：已设置隐藏生日输入框：${dateStr}`);
    }
  } else if (ageInput) {
    if (resolvedAge == null || Number.isNaN(Number(resolvedAge))) {
      throw new Error('检测到年龄字段，但未提供年龄数据。');
    }
    await humanPause(500, 1300);
    fillInput(ageInput, String(resolvedAge));
    log(`步骤 5：年龄已填写：${resolvedAge}`);
  } else {
    throw new Error('未找到生日或年龄输入项。URL: ' + location.href);
  }
  // 韩国IP判断勾选框""I agree"
  const allConsentCheckbox = findStep5AllConsentCheckbox();

  if (allConsentCheckbox) {
    if (!isStep5CheckboxChecked(allConsentCheckbox)) {
      const checkboxLabel = allConsentCheckbox.closest('label');
      await humanPause(500, 1500);
      if (checkboxLabel && isVisibleElement(checkboxLabel)) {
        simulateClick(checkboxLabel);
      } else {
        simulateClick(allConsentCheckbox);
      }
      await sleep(250);

      if (!isStep5CheckboxChecked(allConsentCheckbox)) {
        allConsentCheckbox.click();
        await sleep(250);
      }

      if (!isStep5CheckboxChecked(allConsentCheckbox)) {
        throw new Error('未能勾选 “I agree to all of the following” 复选框。');
      }

      log('步骤 5：已勾选 “I agree to all of the following”。');
    } else {
      log('步骤 5：“I agree to all of the following” 已勾选，跳过。');
    }
  }


  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);
  if (!completeBtn) {
    throw new Error('未找到“完成帐户创建”按钮。URL: ' + location.href);
  }

  const isAgeMode = !birthdayMode && Boolean(ageInput);
  if (isAgeMode) {
    log('步骤 5：当前为年龄输入模式，点击“完成帐户创建”后将直接完成当前步骤。', 'warn');
  }

  await humanPause(500, 1300);
  simulateClick(completeBtn);

  const completionPayload = getStep5DirectCompletionPayload({ isAgeMode });
  reportComplete(5, completionPayload);

  if (isAgeMode) {
    log('步骤 5：年龄模式已点击“完成帐户创建”，当前步骤直接完成，不再等待页面结果。', 'warn');
    return completionPayload;
  }

  log('步骤 5：已点击“完成帐户创建”，当前步骤直接完成，不再等待页面结果。');
  return completionPayload;
}
