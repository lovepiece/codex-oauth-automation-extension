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
      || message.type === 'GET_SIGNUP_FLOW_STATE'
      || message.type === 'GET_SIGNUP_PAGE_HEALTH'
      || message.type === 'PREPARE_SIGNUP_VERIFICATION'
      || message.type === 'RESEND_VERIFICATION_CODE'
      || message.type === 'ENSURE_SIGNUP_ENTRY_READY'
      || message.type === 'ENSURE_SIGNUP_PASSWORD_PAGE_READY'
      || message.type === 'ENSURE_SIGNUP_POST_EMAIL_READY'
      || message.type === 'GET_PHONE_VERIFICATION_STATE'
      || message.type === 'SUBMIT_PHONE_NUMBER'
      || message.type === 'FILL_PHONE_VERIFICATION_CODE'
      || message.type === 'RESEND_PHONE_VERIFICATION_CODE'
      || message.type === 'CLICK_PHONE_VERIFICATION_RETRY'
      || message.type === 'GO_BACK_TO_PHONE_NUMBER_ENTRY'
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
          log(`步骤 8：${err.message}`, 'error');
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
        case 6: return await step6_login(message.payload);
        case 8: return await step8_findAndClick();
        default: throw new Error(`signup-page.js 不处理步骤 ${message.step}`);
      }
    case 'FILL_CODE':
      // Step 4 = signup code, Step 7 = login code (same handler)
      return await fillVerificationCode(message.step, message.payload);
    case 'GET_LOGIN_AUTH_STATE':
      return serializeLoginAuthState(inspectLoginAuthState());
    case 'GET_SIGNUP_FLOW_STATE':
      return serializeSignupFlowState(inspectSignupFlowState());
    case 'GET_SIGNUP_PAGE_HEALTH':
      return inspectSignupPageHealth();
    case 'PREPARE_SIGNUP_VERIFICATION':
      return await prepareSignupVerificationFlow(message.payload);
    case 'RESEND_VERIFICATION_CODE':
      return await resendVerificationCode(message.step);
    case 'ENSURE_SIGNUP_ENTRY_READY':
      return await ensureSignupEntryReady();
    case 'ENSURE_SIGNUP_PASSWORD_PAGE_READY':
      return await ensureSignupPasswordPageReady();
    case 'ENSURE_SIGNUP_POST_EMAIL_READY':
      return await ensureSignupPostEmailReady();
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

function getVerificationCodeTarget() {
  const codeInput = document.querySelector(VERIFICATION_CODE_INPUT_SELECTOR);
  if (codeInput && isVisibleElement(codeInput)) {
    return { type: 'single', element: codeInput };
  }

  const singleInputs = Array.from(document.querySelectorAll('input[maxlength="1"]'))
    .filter(isVisibleElement);
  if (singleInputs.length >= 6) {
    return { type: 'split', elements: singleInputs };
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
  if (step === 7) {
    await waitForLoginVerificationPageReady();
  }

  const start = Date.now();
  let action = null;
  let loggedWaiting = false;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    action = findResendVerificationCodeTrigger({ allowDisabled: true });

    if (action && isActionEnabled(action)) {
      log(`步骤 ${step}：重新发送验证码按钮已可用。`);
      await humanPause(350, 900);
      simulateClick(action);
      await sleep(1200);
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

function inspectSignupFlowState() {
  const entrySnapshot = inspectSignupEntryState();
  if (entrySnapshot.state !== 'unknown') {
    return entrySnapshot;
  }

  const verificationTarget = getVerificationCodeTarget();
  const verificationVisible = isEmailVerificationPage() || isVerificationPageStillVisible();
  if (verificationTarget || verificationVisible) {
    return {
      state: 'verification_page',
      verificationTarget,
      verificationVisible,
      url: location.href,
    };
  }

  return entrySnapshot;
}

function serializeSignupFlowState(snapshot) {
  return {
    state: snapshot?.state || 'unknown',
    url: snapshot?.url || location.href,
    hasVerificationTarget: Boolean(snapshot?.verificationTarget),
    verificationVisible: Boolean(snapshot?.verificationVisible),
    displayedEmail: snapshot?.displayedEmail || '',
  };
}

async function waitForSignupEntryState(options = {}) {
  const {
    timeout = 15000,
    autoOpenEntry = false,
  } = options;
  const start = Date.now();
  let lastTriggerClickAt = 0;

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectSignupFlowState();

    if (snapshot.state === 'password_page' || snapshot.state === 'email_entry' || snapshot.state === 'verification_page') {
      return snapshot;
    }

    if (snapshot.state === 'entry_home') {
      if (!autoOpenEntry) {
        return snapshot;
      }

      if (Date.now() - lastTriggerClickAt >= 1500) {
        lastTriggerClickAt = Date.now();
        log('步骤 2：正在点击官网注册入口...');
        await humanPause(350, 900);
        simulateClick(snapshot.signupTrigger);
      }
    }

    await sleep(250);
  }

  return inspectSignupFlowState();
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

async function ensureSignupPostEmailReady(timeout = 20000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    const snapshot = inspectSignupFlowState();
    if (snapshot.state === 'password_page' || snapshot.state === 'verification_page') {
      return {
        ready: true,
        state: snapshot.state,
        url: snapshot.url || location.href,
      };
    }
    await sleep(200);
  }

  const snapshot = inspectSignupFlowState();
  if (snapshot.state === 'password_page' || snapshot.state === 'verification_page') {
    return {
      ready: true,
      state: snapshot.state,
      url: snapshot.url || location.href,
    };
  }

  throw new Error('等待进入密码页或验证码页超时。URL: ' + location.href);
}

async function fillSignupEmailAndContinue(email, step) {
  if (!email) throw new Error(`未提供邮箱地址，步骤 ${step} 无法继续。`);
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const snapshot = await waitForSignupEntryState({
    timeout: 20000,
    autoOpenEntry: true,
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

  if (snapshot.state === 'verification_page') {
    log(`步骤 ${step}：当前已在验证码页，无需重复提交邮箱。`, 'warn');
    return {
      alreadyOnVerificationPage: true,
      url: snapshot.url || location.href,
    };
  }

  if (snapshot.state !== 'email_entry' || !snapshot.emailInput) {
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
      simulateClick(continueButton);
    } catch (error) {
      console.error('[MultiPage:signup-page] deferred signup email submit failed:', error?.message || error);
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

  let snapshot = inspectSignupFlowState();
  if (snapshot.state === 'verification_page') {
    log('步骤 3：页面已直接进入注册验证码阶段，本步骤无需填写密码，自动跳过。', 'warn');
    reportComplete(3, {
      skipped: true,
      reason: 'already_on_signup_verification_page',
      url: snapshot.url || location.href,
    });
    return {
      skipped: true,
      reason: 'already_on_signup_verification_page',
      url: snapshot.url || location.href,
    };
  }
  if (snapshot.state === 'entry_home') {
    throw new Error('当前仍停留在 ChatGPT 官网首页，请先完成步骤 2。');
  }

  if (snapshot.state === 'email_entry') {
    const transition = await fillSignupEmailAndContinue(email, 3);
    if (transition.alreadyOnVerificationPage) {
      log('步骤 3：提交邮箱后已直接进入注册验证码阶段，本步骤无需填写密码，自动跳过。', 'warn');
      reportComplete(3, {
        skipped: true,
        reason: 'signup_verification_after_email_submit',
        url: transition.url || location.href,
      });
      return {
        skipped: true,
        reason: 'signup_verification_after_email_submit',
        url: transition.url || location.href,
      };
    }
    if (!transition.alreadyOnPasswordPage) {
      await sleep(1200);
      const readyResult = await ensureSignupPostEmailReady();
      if (readyResult?.state === 'verification_page') {
        log('步骤 3：等待页面切换时已进入注册验证码阶段，本步骤自动跳过。', 'warn');
        reportComplete(3, {
          skipped: true,
          reason: 'signup_verification_after_post_email_wait',
          url: readyResult.url || location.href,
        });
        return {
          skipped: true,
          reason: 'signup_verification_after_post_email_wait',
          url: readyResult.url || location.href,
        };
      }
    }
    snapshot = inspectSignupFlowState();
  }

  if (snapshot.state !== 'password_page' || !snapshot.passwordInput) {
    await ensureSignupPasswordPageReady();
    snapshot = inspectSignupFlowState();
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

  // Report complete BEFORE submit, because submit causes page navigation
  // which kills the content script connection
  const signupVerificationRequestedAt = submitBtn ? Date.now() : null;
  reportComplete(3, { email, signupVerificationRequestedAt });

  // Submit the form (page will navigate away after this)
  await sleep(500);
  if (submitBtn) {
    await humanPause(500, 1300);
    simulateClick(submitBtn);
    log('步骤 3：表单已提交');
  }
}

// ============================================================
// Fill Verification Code (used by step 4 and step 7)
// ============================================================

const INVALID_VERIFICATION_CODE_PATTERN = /代码不正确|验证码不正确|验证码错误|code\s+(?:is\s+)?incorrect|invalid\s+code|incorrect\s+code|try\s+again/i;
const VERIFICATION_PAGE_PATTERN = /检查您的收件箱|输入我们刚刚向|重新发送电子邮件|重新发送验证码|代码不正确|email\s+verification|check\s+your\s+inbox|enter\s+the\s+code|we\s+just\s+sent|we\s+emailed|resend/i;
const OAUTH_CONSENT_PAGE_PATTERN = /使用\s*ChatGPT\s*登录到\s*Codex|sign\s+in\s+to\s+codex(?:\s+with\s+chatgpt)?|login\s+to\s+codex|log\s+in\s+to\s+codex|authorize|授权/i;
const OAUTH_CONSENT_FORM_SELECTOR = 'form[action*="/sign-in-with-chatgpt/" i][action*="/consent" i]';
const STEP5_SKIP_PAGE_PATTERN = /chatgpt|入门技巧|盡管问|尽管问|请勿共享敏感信息|请核实你的信息|好的[,，\s]*开始吧|是什么促使你使用\s*chatgpt|我们会利用这些信息提出一些可能会对你有用的建议|学校|工作|个人任务|乐趣和娱乐|其他|下一步|跳过|get\s+started|tips|don't\s+share\s+sensitive\s+info|verify\s+your\s+information|what\s+brings\s+you\s+to\s+chatgpt|we(?:'ll| will)\s+use\s+this\s+information|school|work|personal\s+tasks|fun\s+and\s+entertainment|other|skip|next/i;
const CONTINUE_ACTION_PATTERN = /继续|continue/i;
const ADD_PHONE_PAGE_PATTERN = /add[\s-]*phone|添加手机号|手机号码|手机号|phone\s+number|telephone/i;
const PHONE_VERIFICATION_PAGE_PATTERN = /查看你的手机|输入我们刚刚向|重新发送短信|phone\s+verification|verify\s+your\s+phone|texted\s+you\s+a\s+code/i;
const STEP5_SUBMIT_ERROR_PATTERN = /无法根据该信息创建帐户|请重试|unable\s+to\s+create\s+(?:your\s+)?account|couldn'?t\s+create\s+(?:your\s+)?account|something\s+went\s+wrong|invalid\s+(?:birthday|birth|date)|生日|出生日期/i;
const AUTH_TIMEOUT_ERROR_TITLE_PATTERN = /糟糕，出错了|something\s+went\s+wrong|oops/i;
const AUTH_TIMEOUT_ERROR_DETAIL_PATTERN = /operation\s+timed\s+out|timed\s+out|请求超时|操作超时/i;
const SIGNUP_EMAIL_EXISTS_PATTERN = /user[_\s-]*already[_\s-]*exists|与此电子邮件地址相关联的帐户已存在|account\s+associated\s+with\s+this\s+email\s+address\s+already\s+exists|email\s+address.*already\s+exists/i;
const PHONE_MAX_USAGE_EXCEEDED_PATTERN = /phone_max_usage_exceeded/i;
const PHONE_RESEND_RATE_LIMIT_PATTERN = /尝试重新发送的次数过多。?\s*请稍后重试。?|too\s+many\s+(?:times\s+to\s+)?resend|too\s+many\s+resend\s+attempts?/i;
const PHONE_SMS_UNAVAILABLE_PATTERN = /无法向此电话号码发送短信|unable\s+to\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number|cannot\s+send\s+(?:an\s+)?sms\s+to\s+this\s+phone\s+number/i;

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

function isStep5Ready() {
  return Boolean(
    document.querySelector('input[name="name"], input[autocomplete="name"], input[name="birthday"], input[name="age"], [role="spinbutton"][data-type="year"]')
  );
}

function isStep5SkippableWelcomePage() {
  const pageText = getPageTextSnapshot();
  if (!STEP5_SKIP_PAGE_PATTERN.test(pageText)) {
    return false;
  }

  const startButton = Array.from(document.querySelectorAll('button, [role="button"], a'))
    .find((el) => isVisibleElement(el) && /好的[,，\s]*开始吧|开始吧|下一步|跳过|get\s+started|continue|next|skip/i.test(getActionText(el)));

  return Boolean(startButton);
}

function getPageTextSnapshot() {
  return (document.body?.innerText || document.body?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
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
  if (getVerificationCodeTarget()) return true;
  if (findResendVerificationCodeTrigger({ allowDisabled: true })) return true;
  if (document.querySelector('form[action*="email-verification" i]')) return true;

  return VERIFICATION_PAGE_PATTERN.test(getPageTextSnapshot());
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

function getPhoneCountryOptionDialCode(option) {
  if (!option) {
    return '';
  }

  const text = `${getActionText(option) || ''} ${option.textContent || ''}`.replace(/\s+/g, ' ').trim();
  const match = text.match(/\+(\d{1,4})/);
  return match ? match[1] : '';
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
      const optionText = normalizePhoneCountryMatchText(`${getActionText(option) || ''} ${option.textContent || ''}`);
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

  const start = Date.now();
  let option = null;
  while (Date.now() - start < 5000) {
    throwIfStopped();
    option = findPhoneCountryOptionByTarget(targetCountry) || findPhoneCountryOptionForNumber(phoneNumber);
    if (option) {
      break;
    }
    await sleep(120);
  }

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

function normalizePhoneNumberForOpenAiForm(phoneNumber = '') {
  const raw = String(phoneNumber || '').trim();
  if (!raw) {
    return '';
  }

  let normalized = raw.replace(/[^\d+]/g, '');
  const currentDialCode = getSelectedPhoneCountryDialCode();
  if (normalized.startsWith('+')) {
    normalized = normalized.slice(1);
  }
  if (currentDialCode && normalized.startsWith(currentDialCode)) {
    normalized = normalized.slice(currentDialCode.length);
  }

  return normalized.replace(/\D/g, '');
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
  const phoneInput = addPhonePage ? getPhoneNumberInput() : null;
  const codeTarget = addPhonePage ? getVerificationCodeTarget() : null;
  const actionButton = addPhonePage ? getPhoneVerificationActionButton({ allowDisabled: true }) : null;
  const resendButton = addPhonePage ? findResendVerificationCodeTrigger({ allowDisabled: true }) : null;
  const retryButton = addPhonePage ? getAuthRetryButton({ allowDisabled: true }) : null;
  const errorText = addPhonePage ? getPhoneVerificationErrorText() : '';

  return {
    addPhonePage,
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
    if (snapshot.codeTarget) {
      return { success: true, codeEntryReady: true, url: snapshot.url || location.href };
    }
    if (snapshot.errorText) {
      return { success: false, errorText: snapshot.errorText, url: snapshot.url || location.href };
    }
    await sleep(200);
  }

  return { success: false, errorText: '提交手机号后未进入短信验证码输入阶段。', url: location.href };
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
    if (snapshot.codeTarget) {
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

async function submitPhoneNumber(payload = {}) {
  const { phoneNumber, phoneCountry } = payload;
  if (!phoneNumber) {
    throw new Error('未提供手机号。');
  }

  const snapshot = await waitForPhoneVerificationPageReady();
  if (snapshot.codeTarget) {
    return { alreadyWaitingForCode: true, url: snapshot.url || location.href };
  }
  const phoneEntry = await waitForPhoneNumberInputReady();
  if (phoneEntry.alreadyWaitingForCode) {
    return { alreadyWaitingForCode: true, url: phoneEntry.url || location.href };
  }
  const phoneInput = phoneEntry.phoneInput || snapshot.phoneInput || getPhoneNumberInput();
  if (!phoneInput) {
    throw new Error('手机号页面未找到手机号输入框。URL: ' + location.href);
  }

  const actionButton = snapshot.actionButton || getPhoneVerificationActionButton({ allowDisabled: true });
  if (!actionButton || !isActionEnabled(actionButton)) {
    throw new Error('手机号页面未找到可点击的发送验证码按钮。URL: ' + location.href);
  }

  const countryMatch = await ensurePhoneCountryMatchesNumber(phoneNumber, phoneCountry);
  if (countryMatch.matched) {
    log(
      `手机号验证：已${countryMatch.changed ? '自动切换' : '确认'}国家${countryMatch.countryName ? ` ${countryMatch.countryName}` : ''} 区号 +${countryMatch.dialCode || getSelectedPhoneCountryDialCode() || '?'}`,
      'info'
    );
  } else {
    log('手机号验证：未能自动匹配国家区号，将按当前页面已选国家继续填写。', 'warn');
  }

  await humanPause(450, 1100);
  const fullDigitsPhoneNumber = getPhoneDigits(phoneNumber);
  const hiddenPhoneInput = getPhoneNumberHiddenInput();
  fillInput(phoneInput, fullDigitsPhoneNumber || phoneNumber);
  if (hiddenPhoneInput) {
    const hiddenValue = fullDigitsPhoneNumber ? `+${fullDigitsPhoneNumber}` : String(phoneNumber || '').trim();
    fillInput(hiddenPhoneInput, hiddenValue);
  }
  log(`手机号验证：已填写完整手机号 ${fullDigitsPhoneNumber || phoneNumber}`);
  await sleep(500);
  const latestActionButton = getPhoneVerificationActionButton({ allowDisabled: true }) || actionButton;
  if (!latestActionButton || !isActionEnabled(latestActionButton)) {
    throw new Error('手机号页面未找到可点击的继续按钮。URL: ' + location.href);
  }
  await humanPause(300, 800);
  simulateClick(latestActionButton);
  log('手机号验证：已提交手机号，正在等待短信验证码输入框...');
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

function getStep5EmailExistsText() {
  const pageText = getPageTextSnapshot();
  if (SIGNUP_EMAIL_EXISTS_PATTERN.test(pageText)) {
    return pageText;
  }

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

  return messages.find((text) => SIGNUP_EMAIL_EXISTS_PATTERN.test(text)) || '';
}

async function waitForStep5SubmitOutcome(timeout = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    throwIfStopped();

    const emailExistsText = getStep5EmailExistsText();
    if (emailExistsText) {
      return { invalidProfile: true, errorText: '当前邮箱已存在，需要重新开始新一轮。', emailExists: true };
    }

    await sleep(250);
  }

  const emailExistsText = getStep5EmailExistsText();
  if (emailExistsText) {
    return { invalidProfile: true, errorText: '当前邮箱已存在，需要重新开始新一轮。', emailExists: true };
  }

  return {
    success: true,
    assumed: true,
    reason: 'step5_submit_completed_continue_step6',
    url: location.href,
  };

  if (isStep5SkippableWelcomePage()) {
    return {
      success: true,
      skipped: true,
      skipToStep6: true,
      reason: 'welcome_page_after_signup',
      url: location.href,
    };
  }

  if (isAddPhonePageReady()) {
    return { success: true, addPhonePage: true };
  }

  if (isStep8Ready()) {
    return { success: true };
  }

  if (sawStep5FormDisappear || !isStep5Ready()) {
    return {
      success: true,
      assumed: true,
      reason: 'step5_form_disappeared_after_submit',
      url: location.href,
    };
  }

  return {
    invalidProfile: true,
    errorText: '提交后未进入下一阶段，请检查生日是否真正被页面接受。',
  };
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

  if (!titleMatched && !detailMatched) {
    return null;
  }

  return {
    path,
    url: location.href,
    retryButton,
    retryEnabled: isActionEnabled(retryButton),
    titleMatched,
    detailMatched,
  };
}

function getSignupPasswordTimeoutErrorPageState() {
  return getAuthTimeoutErrorPageState({
    pathPatterns: [/\/create-account\/password(?:[/?#]|$)/i],
  });
}

function getLoginTimeoutErrorPageState() {
  return getAuthTimeoutErrorPageState({
    pathPatterns: [/\/log-in(?:[/?#]|$)/i],
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
    retryButton: retryState?.retryButton || null,
    retryEnabled: Boolean(retryState?.retryEnabled),
    titleMatched: Boolean(retryState?.titleMatched),
    detailMatched: Boolean(retryState?.detailMatched),
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

  if (verificationTarget) {
    return {
      ...baseState,
      state: 'verification_page',
    };
  }

  if (retryState) {
    return {
      ...baseState,
      state: 'login_timeout_error_page',
    };
  }

  if (addPhonePage) {
    return {
      ...baseState,
      state: 'add_phone_page',
    };
  }

  if (oauthConsentPage) {
    return {
      ...baseState,
      state: 'oauth_consent_page',
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
    retryEnabled: Boolean(snapshot?.retryEnabled),
    titleMatched: Boolean(snapshot?.titleMatched),
    detailMatched: Boolean(snapshot?.detailMatched),
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

function inspectSignupPageHealth() {
  const pageText = getPageTextSnapshot();
  const isMethodNotAllowed = /405\b[\s\S]{0,80}method\s+not\s+allowed|method\s+not\s+allowed|405/i.test(pageText);
  return {
    url: location.href,
    path: location.pathname || '',
    title: document.title || '',
    isMethodNotAllowed,
  };
}

function getLoginAuthStateLabel(snapshot) {
  switch (snapshot?.state) {
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
  let snapshot = inspectLoginAuthState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectLoginAuthState();
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
    `当前未进入登录验证码页面，请先重新完成步骤 6。当前状态：${getLoginAuthStateLabel(snapshot)}。URL: ${snapshot?.url || location.href}`
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

function throwForStep6FatalState(snapshot) {
  switch (snapshot?.state) {
    case 'oauth_consent_page':
      throw new Error(`当前页面已进入 OAuth 授权页，未经过登录验证码页，无法完成步骤 6。URL: ${snapshot.url}`);
    case 'add_phone_page':
      throw new Error(`当前页面已进入手机号页面，未经过登录验证码页，无法完成步骤 6。URL: ${snapshot.url}`);
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

  if (isStep5SkippableWelcomePage()) {
    return { state: 'step5_skippable_welcome' };
  }

  if (isVerificationPageStillVisible()) {
    return { state: 'verification' };
  }

  if (isSignupPasswordErrorPage()) {
    const timeoutPage = getSignupPasswordTimeoutErrorPageState();
    return {
      state: 'error',
      retryButton: timeoutPage?.retryButton || null,
    };
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
    if (
      snapshot.state === 'step5'
      || snapshot.state === 'step5_skippable_welcome'
      || snapshot.state === 'verification'
      || snapshot.state === 'error'
      || snapshot.state === 'email_exists'
    ) {
      return snapshot;
    }

    await sleep(200);
  }

  return inspectSignupVerificationState();
}

async function prepareSignupVerificationFlow(payload = {}, timeout = 30000) {
  const { password } = payload;
  const start = Date.now();
  let recoveryRound = 0;
  const maxRecoveryRounds = 3;

  while (Date.now() - start < timeout && recoveryRound < maxRecoveryRounds) {
    throwIfStopped();

    const roundNo = recoveryRound + 1;
    log(`步骤 4：等待页面进入验证码阶段（第 ${roundNo}/${maxRecoveryRounds} 轮，先等待 5 秒）...`, 'info');
    const snapshot = await waitForSignupVerificationTransition(5000);

    if (snapshot.state === 'step5' || snapshot.state === 'step5_skippable_welcome') {
      log('步骤 4：页面已进入验证码后的下一阶段，本步骤按已完成处理。', 'ok');
      return { ready: true, alreadyVerified: true, retried: recoveryRound };
    }

    if (snapshot.state === 'verification') {
      log(`步骤 4：验证码页面已就绪${recoveryRound ? `（期间自动恢复 ${recoveryRound} 次）` : ''}。`, 'ok');
      return { ready: true, retried: recoveryRound };
    }

    if (snapshot.state === 'email_exists') {
      throw new Error('当前邮箱已存在，需要重新开始新一轮。');
    }

    recoveryRound += 1;

    if (snapshot.state === 'error') {
      if (snapshot.retryButton && isActionEnabled(snapshot.retryButton)) {
        log(`步骤 4：检测到密码页超时报错，正在点击“重试”（第 ${recoveryRound}/${maxRecoveryRounds} 次）...`, 'warn');
        await humanPause(350, 900);
        simulateClick(snapshot.retryButton);
        await sleep(1200);
        continue;
      }

      log(`步骤 4：检测到异常页，但“重试”按钮暂不可用，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
      continue;
    }

    if (snapshot.state === 'password') {
      if (!password) {
        throw new Error('当前回到了密码页，但没有可用密码，无法自动重新提交。');
      }

      if ((snapshot.passwordInput.value || '') !== password) {
        log('步骤 4：页面仍停留在密码页，正在重新填写密码...', 'warn');
        await humanPause(450, 1100);
        fillInput(snapshot.passwordInput, password);
      }

      if (snapshot.submitButton && isActionEnabled(snapshot.submitButton)) {
        log(`步骤 4：页面仍停留在密码页，正在重新点击“继续”（第 ${recoveryRound}/${maxRecoveryRounds} 次）...`, 'warn');
        await humanPause(350, 900);
        simulateClick(snapshot.submitButton);
        await sleep(1200);
        continue;
      }

      log(`步骤 4：页面仍停留在密码页，但“继续”按钮暂不可用，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
      continue;
    }

    log(`步骤 4：页面仍在切换中，准备继续等待（${recoveryRound}/${maxRecoveryRounds}）...`, 'warn');
  }

  throw new Error(`等待注册验证码页面就绪超时或自动恢复失败（已尝试 ${recoveryRound}/${maxRecoveryRounds} 轮）。URL: ${location.href}`);
}


async function waitForVerificationSubmitOutcome(step, timeout) {
  const resolvedTimeout = timeout ?? (step === 7 ? 30000 : 12000);
  const start = Date.now();

  while (Date.now() - start < resolvedTimeout) {
    throwIfStopped();

    const errorText = getVerificationErrorText();
    if (errorText) {
      return { invalidCode: true, errorText };
    }

    if (step === 4 && isStep5Ready()) {
      return { success: true };
    }

    if (step === 7 && isStep8Ready()) {
      return { success: true };
    }

    if (step === 7 && isAddPhonePageReady()) {
      return { success: true, addPhonePage: true };
    }

    await sleep(150);
  }

  if (isVerificationPageStillVisible()) {
    return {
      invalidCode: true,
      errorText: getVerificationErrorText() || '提交后仍停留在验证码页面，准备重新发送验证码。',
    };
  }

  return { success: true, assumed: true };
}

async function fillVerificationCode(step, payload) {
  const { code } = payload;
  if (!code) throw new Error('未提供验证码。');

  log(`步骤 ${step}：正在填写验证码：${code}`);

  if (step === 7) {
    await waitForLoginVerificationPageReady();
  }

  // Find code input — could be a single input or multiple separate inputs
  let codeInput = null;
  try {
    codeInput = await waitForElement(VERIFICATION_CODE_INPUT_SELECTOR, 10000);
  } catch {
    // Check for multiple single-digit inputs (common pattern)
    const singleInputs = document.querySelectorAll('input[maxlength="1"]');
    if (singleInputs.length >= 6) {
      log(`步骤 ${step}：发现分开的单字符验证码输入框，正在逐个填写...`);
      for (let i = 0; i < 6 && i < singleInputs.length; i++) {
        fillInput(singleInputs[i], code[i]);
        await sleep(100);
      }
      const outcome = await waitForVerificationSubmitOutcome(step);
      if (outcome.invalidCode) {
        log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
      } else if (outcome.addPhonePage) {
        log(`步骤 ${step}：验证码已通过，并已跳转到手机号页面。`, 'ok');
      } else {
        log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
      }
      return outcome;
    }
    throw new Error('未找到验证码输入框。URL: ' + location.href);
  }

  fillInput(codeInput, code);
  log(`步骤 ${step}：验证码已填写`);

  // Report complete BEFORE submit (page may navigate away)

  // Submit
  await sleep(500);
  const submitBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /verify|confirm|submit|continue|确认|验证/i, 5000).catch(() => null);

  if (submitBtn) {
    await humanPause(450, 1200);
    simulateClick(submitBtn);
    log(`步骤 ${step}：验证码已提交`);
  }

  const outcome = await waitForVerificationSubmitOutcome(step);
  if (outcome.invalidCode) {
    log(`步骤 ${step}：验证码被拒绝：${outcome.errorText}`, 'warn');
  } else if (outcome.addPhonePage) {
    log(`步骤 ${step}：验证码已通过，并已跳转到手机号页面。`, 'ok');
  } else {
    log(`步骤 ${step}：验证码已通过${outcome.assumed ? '（按成功推定）' : ''}。`, 'ok');
  }

  return outcome;
}

// ============================================================
// Step 6: Login with registered account (on OAuth auth page)
// ============================================================

async function waitForStep6EmailSubmitTransition(emailSubmittedAt, timeout = 12000) {
  const start = Date.now();
  let snapshot = inspectLoginAuthState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectLoginAuthState();

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
      return {
        action: 'recoverable',
        result: createStep6RecoverableResult('login_timeout_error_page', snapshot, {
          message: '提交邮箱后进入登录超时报错页。',
        }),
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

  snapshot = inspectLoginAuthState();
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
    return {
      action: 'recoverable',
      result: createStep6RecoverableResult('login_timeout_error_page', snapshot, {
        message: '提交邮箱后进入登录超时报错页。',
      }),
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
  let snapshot = inspectLoginAuthState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectLoginAuthState();

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
      return {
        action: 'recoverable',
        result: createStep6RecoverableResult('login_timeout_error_page', snapshot, {
          message: '提交密码后进入登录超时报错页。',
        }),
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

  snapshot = inspectLoginAuthState();
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
    return {
      action: 'recoverable',
      result: createStep6RecoverableResult('login_timeout_error_page', snapshot, {
        message: '提交密码后进入登录超时报错页。',
      }),
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
  let snapshot = inspectLoginAuthState();

  while (Date.now() - start < timeout) {
    throwIfStopped();
    snapshot = inspectLoginAuthState();

    if (snapshot.state === 'verification_page') {
      return createStep6SuccessResult(snapshot, {
        via: 'switch_to_one_time_code_login',
        loginVerificationRequestedAt,
      });
    }

    if (snapshot.state === 'login_timeout_error_page') {
      return createStep6RecoverableResult('login_timeout_error_page', snapshot, {
        message: '切换到一次性验证码登录后进入登录超时报错页。',
      });
    }

    if (snapshot.state === 'oauth_consent_page') {
      throw new Error(`切换到一次性验证码登录后页面直接进入 OAuth 授权页，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    if (snapshot.state === 'add_phone_page') {
      throw new Error(`切换到一次性验证码登录后页面直接进入手机号页面，未经过登录验证码页。URL: ${snapshot.url}`);
    }

    await sleep(250);
  }

  snapshot = inspectLoginAuthState();
  if (snapshot.state === 'verification_page') {
    return createStep6SuccessResult(snapshot, {
      via: 'switch_to_one_time_code_login',
      loginVerificationRequestedAt,
    });
  }
  if (snapshot.state === 'login_timeout_error_page') {
    return createStep6RecoverableResult('login_timeout_error_page', snapshot, {
      message: '切换到一次性验证码登录后进入登录超时报错页。',
    });
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

async function step6SwitchToOneTimeCodeLogin(snapshot) {
  const switchTrigger = snapshot?.switchTrigger || findOneTimeCodeLoginTrigger();
  if (!switchTrigger || !isActionEnabled(switchTrigger)) {
    return createStep6RecoverableResult('missing_one_time_code_trigger', inspectLoginAuthState(), {
      message: '当前登录页没有可用的一次性验证码登录入口。',
    });
  }

  log('步骤 6：已检测到一次性验证码登录入口，准备切换...');
  const loginVerificationRequestedAt = Date.now();
  await humanPause(350, 900);
  simulateClick(switchTrigger);
  log('步骤 6：已点击一次性验证码登录');
  await sleep(1200);
  return waitForStep6SwitchTransition(loginVerificationRequestedAt);
}

async function step6LoginFromPasswordPage(payload, snapshot) {
  const currentSnapshot = snapshot || inspectLoginAuthState();

  if (currentSnapshot.passwordInput) {
    if (!payload.password) {
      throw new Error('登录时缺少密码，步骤 6 无法继续。');
    }

    log('步骤 6：已进入密码页，准备填写密码...');
    await humanPause(550, 1450);
    fillInput(currentSnapshot.passwordInput, payload.password);
    log('步骤 6：已填写密码');

    await sleep(500);
    const passwordSubmittedAt = Date.now();
    await triggerLoginSubmitAction(currentSnapshot.submitButton, currentSnapshot.passwordInput);
    log('步骤 6：已提交密码');

    const transition = await waitForStep6PasswordSubmitTransition(passwordSubmittedAt);
    if (transition.action === 'done') {
      log('步骤 6：已进入登录验证码页面。', 'ok');
      return transition.result;
    }
    if (transition.action === 'recoverable') {
      log(`步骤 6：${transition.result.message || '提交密码后仍未进入登录验证码页面，准备重新执行步骤 6。'}`, 'warn');
      return transition.result;
    }
    if (transition.action === 'switch') {
      return step6SwitchToOneTimeCodeLogin(transition.snapshot);
    }

    return createStep6RecoverableResult('password_submit_unknown', inspectLoginAuthState(), {
      message: '提交密码后未得到可用的下一步状态。',
    });
  }

  if (currentSnapshot.switchTrigger) {
    return step6SwitchToOneTimeCodeLogin(currentSnapshot);
  }

  return createStep6RecoverableResult('password_page_unactionable', currentSnapshot, {
    message: '当前停留在登录页，但没有可提交密码的输入框，也没有一次性验证码登录入口。',
  });
}

async function step6LoginFromEmailPage(payload, snapshot) {
  const currentSnapshot = snapshot || inspectLoginAuthState();
  const emailInput = currentSnapshot.emailInput || getLoginEmailInput();
  if (!emailInput) {
    throw new Error('在登录页未找到邮箱输入框。URL: ' + location.href);
  }

  if ((emailInput.value || '').trim() !== payload.email) {
    await humanPause(500, 1400);
    fillInput(emailInput, payload.email);
    log('步骤 6：已填写邮箱');
  } else {
    log('步骤 6：邮箱已在输入框中，准备提交...');
  }

  await sleep(500);
  const emailSubmittedAt = Date.now();
  await triggerLoginSubmitAction(currentSnapshot.submitButton, emailInput);
  log('步骤 6：已提交邮箱');

  const transition = await waitForStep6EmailSubmitTransition(emailSubmittedAt);
  if (transition.action === 'done') {
    log('步骤 6：已进入登录验证码页面。', 'ok');
    return transition.result;
  }
  if (transition.action === 'recoverable') {
    log(`步骤 6：${transition.result.message || '提交邮箱后仍未进入目标页面，准备重新执行步骤 6。'}`, 'warn');
    return transition.result;
  }
  if (transition.action === 'password') {
    return step6LoginFromPasswordPage(payload, transition.snapshot);
  }

  return createStep6RecoverableResult('email_submit_unknown', inspectLoginAuthState(), {
    message: '提交邮箱后未得到可用的下一步状态。',
  });
}

async function step6_login(payload) {
  const { email } = payload;
  if (!email) throw new Error('登录时缺少邮箱地址。');

  log(`步骤 6：正在使用 ${email} 登录...`);

  const snapshot = await waitForKnownLoginAuthState(15000);

  if (snapshot.state === 'verification_page') {
    log('步骤 6：登录验证码页面已就绪。', 'ok');
    return createStep6SuccessResult(snapshot, { via: 'already_on_verification_page' });
  }

  if (snapshot.state === 'login_timeout_error_page') {
    log('步骤 6：检测到登录超时报错，准备重新执行步骤 6。', 'warn');
    return createStep6RecoverableResult('login_timeout_error_page', snapshot, {
      message: '当前页面处于登录超时报错页。',
    });
  }

  if (snapshot.state === 'email_page') {
    return step6LoginFromEmailPage(payload, snapshot);
  }

  if (snapshot.state === 'password_page') {
    return step6LoginFromPasswordPage(payload, snapshot);
  }

  throwForStep6FatalState(snapshot);
  throw new Error(`无法识别当前登录页面状态。URL: ${snapshot?.url || location.href}`);
}

// ============================================================
// Step 8: Find "继续" on OAuth consent page for debugger click
// ============================================================
// After login + verification, page shows:
// "使用 ChatGPT 登录到 Codex" with a "继续" submit button.
// Background performs the actual click through the debugger Input API.

async function step8_findAndClick() {
  log('步骤 8：正在查找 OAuth 同意页的“继续”按钮...');

  const continueBtn = await prepareStep8ContinueButton();

  const rect = getSerializableRect(continueBtn);
  log('步骤 8：已找到“继续”按钮并准备好调试器点击坐标。');
  return {
    rect,
    buttonText: (continueBtn.textContent || '').trim(),
    url: location.href,
  };
}

function getStep8State() {
  const continueBtn = getPrimaryContinueButton();
  const state = {
    url: location.href,
    consentPage: isOAuthConsentPage(),
    consentReady: isStep8Ready(),
    verificationPage: isVerificationPageStillVisible(),
    addPhonePage: isAddPhonePageReady(),
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
      throw new Error(`未知的 Step 8 触发策略：${strategy}`);
  }

  log(`Step 8: continue button triggered via ${strategy}.`);
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

async function step5_fillNameBirthday(payload) {
  const { firstName, lastName, age, year, month, day } = payload;
  if (isStep5SkippableWelcomePage()) {
    log('步骤 5：检测到 ChatGPT 入门提示页，无需填写姓名和生日，直接跳过并进入步骤 6。', 'warn');
    return {
      skipped: true,
      skipToStep6: true,
      reason: 'welcome_page_after_signup',
      url: location.href,
    };
  }
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

  // Click "完成帐户创建" button
  await sleep(500);
  const completeBtn = document.querySelector('button[type="submit"]')
    || await waitForElementByText('button', /完成|create|continue|finish|done|agree/i, 5000).catch(() => null);
  if (!completeBtn) {
    throw new Error('未找到“完成帐户创建”按钮。URL: ' + location.href);
  }

  const isAgeMode = !birthdayMode && Boolean(ageInput);
  if (isAgeMode) {
    log('步骤 5：当前为年龄输入模式，点击“继续”后将直接视为完成并进入步骤 6。', 'warn');
    reportComplete(5, {
      skippedPostSubmitCheck: true,
      directProceedToStep6: true,
    });
  }

  await humanPause(500, 1300);
  simulateClick(completeBtn);

  if (isAgeMode) {
    log('步骤 5：年龄模式已点击“继续”，已跳过后续结果等待。', 'warn');
    return;
  }

  log('步骤 5：已点击“完成帐户创建”，正在等待页面结果...');

  const outcome = await waitForStep5SubmitOutcome();
  if (outcome.invalidProfile) {
    throw new Error(`步骤 5：${outcome.errorText}`);
  }

  log(`步骤 5：资料已通过。`, 'ok');
  if (outcome.skipToStep6) {
    log('步骤 5：提交后进入欢迎/引导页，改为跳过步骤 5 并直接进入步骤 6。', 'warn');
    return outcome;
  }

  reportComplete(5, { addPhonePage: Boolean(outcome.addPhonePage) });
}
