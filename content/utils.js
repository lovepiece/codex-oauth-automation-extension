// content/utils.js — Shared utilities for all content scripts

const SCRIPT_SOURCE = (() => {
  const url = location.href;
  if (url.includes('auth0.openai.com') || url.includes('auth.openai.com') || url.includes('accounts.openai.com')) return 'signup-page';
  if (url.includes('mail.qq.com')) return 'qq-mail';
  if (url.includes('mail.163.com')) return 'mail-163';
  if (url.includes('chatgpt.com')) return 'chatgpt';
  // VPS panel — detected dynamically since URL is configurable
  return 'vps-panel';
})();

const LOG_PREFIX = `[MultiPage:${SCRIPT_SOURCE}]`;

/**
 * Wait for a DOM element to appear.
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait time in ms (default 10000)
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) {
      console.log(LOG_PREFIX, `Found immediately: ${selector}`);
      log(`Found element: ${selector}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `Waiting for: ${selector} (timeout: ${timeout}ms)`);
    log(`Waiting for selector: ${selector}...`);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        console.log(LOG_PREFIX, `Found after wait: ${selector}`);
        log(`Found element: ${selector}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      const msg = `Timeout waiting for ${selector} after ${timeout}ms on ${location.href}`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);
  });
}

/**
 * Wait for an element matching a text pattern among multiple candidates.
 * @param {string} containerSelector - Selector for candidate elements
 * @param {RegExp} textPattern - Regex to match against textContent
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<Element>}
 */
function waitForElementByText(containerSelector, textPattern, timeout = 10000) {
  return new Promise((resolve, reject) => {
    function search() {
      const candidates = document.querySelectorAll(containerSelector);
      for (const el of candidates) {
        if (textPattern.test(el.textContent)) {
          return el;
        }
      }
      return null;
    }

    const existing = search();
    if (existing) {
      console.log(LOG_PREFIX, `Found by text immediately: ${containerSelector} matching ${textPattern}`);
      log(`Found element by text: ${textPattern}`);
      resolve(existing);
      return;
    }

    console.log(LOG_PREFIX, `Waiting for text match: ${containerSelector} / ${textPattern}`);
    log(`Waiting for element with text: ${textPattern}...`);

    const observer = new MutationObserver(() => {
      const el = search();
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        console.log(LOG_PREFIX, `Found by text after wait: ${textPattern}`);
        log(`Found element by text: ${textPattern}`);
        resolve(el);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      const msg = `Timeout waiting for text "${textPattern}" in "${containerSelector}" after ${timeout}ms on ${location.href}`;
      console.error(LOG_PREFIX, msg);
      reject(new Error(msg));
    }, timeout);
  });
}

/**
 * React-compatible form filling.
 * Sets value via native setter and dispatches input + change events.
 * @param {HTMLInputElement} el
 * @param {string} value
 */
function fillInput(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  ).set;
  nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `Filled input ${el.name || el.id || el.type} with: ${value}`);
  log(`Filled input [${el.name || el.id || el.type || 'unknown'}]`);
}

/**
 * Fill a select element by setting its value and triggering change.
 * @param {HTMLSelectElement} el
 * @param {string} value
 */
function fillSelect(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  console.log(LOG_PREFIX, `Selected value ${value} in ${el.name || el.id}`);
  log(`Selected [${el.name || el.id || 'unknown'}] = ${value}`);
}

/**
 * Send a log message to Side Panel via Background.
 * @param {string} message
 * @param {string} level - 'info' | 'ok' | 'warn' | 'error'
 */
function log(message, level = 'info') {
  chrome.runtime.sendMessage({
    type: 'LOG',
    source: SCRIPT_SOURCE,
    step: null,
    payload: { message, level, timestamp: Date.now() },
    error: null,
  });
}

/**
 * Report that this content script is loaded and ready.
 */
function reportReady() {
  console.log(LOG_PREFIX, 'Content script ready');
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_READY',
    source: SCRIPT_SOURCE,
    step: null,
    payload: {},
    error: null,
  });
}

/**
 * Report step completion.
 * @param {number} step
 * @param {Object} data - Step output data
 */
function reportComplete(step, data = {}) {
  console.log(LOG_PREFIX, `Step ${step} completed`, data);
  log(`Step ${step} completed successfully`, 'ok');
  chrome.runtime.sendMessage({
    type: 'STEP_COMPLETE',
    source: SCRIPT_SOURCE,
    step,
    payload: data,
    error: null,
  });
}

/**
 * Report step error.
 * @param {number} step
 * @param {string} errorMessage
 */
function reportError(step, errorMessage) {
  console.error(LOG_PREFIX, `Step ${step} failed: ${errorMessage}`);
  log(`Step ${step} failed: ${errorMessage}`, 'error');
  chrome.runtime.sendMessage({
    type: 'STEP_ERROR',
    source: SCRIPT_SOURCE,
    step,
    payload: {},
    error: errorMessage,
  });
}

/**
 * Simulate a click with proper event dispatching.
 * @param {Element} el
 */
function simulateClick(el) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  console.log(LOG_PREFIX, `Clicked: ${el.tagName} ${el.textContent?.slice(0, 30) || ''}`);
  log(`Clicked [${el.tagName}] "${el.textContent?.trim().slice(0, 30) || ''}"`);
}

/**
 * Wait a specified number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Auto-report ready on load
// Skip ready signal from child iframes of mail pages to avoid overwriting the top frame's registration
const _isMailChildFrame = (SCRIPT_SOURCE === 'qq-mail' || SCRIPT_SOURCE === 'mail-163') && window !== window.top;
if (!_isMailChildFrame) {
  reportReady();
}
