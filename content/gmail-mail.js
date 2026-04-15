// content/gmail-mail.js — Content script for Gmail polling (steps 4, 7)
// Injected dynamically on: mail.google.com

const GMAIL_PREFIX = '[MultiPage:gmail-mail]';
const GMAIL_SEEN_CODES_KEY = 'seenGmailCodes';
const GMAIL_FALLBACK_AFTER = 3;
const isTopFrame = window === window.top;

console.log(GMAIL_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

if (!isTopFrame) {
  console.log(GMAIL_PREFIX, 'Skipping child frame');
} else {

let seenCodes = new Set();

async function loadSeenCodes() {
  try {
    const data = await chrome.storage.session.get(GMAIL_SEEN_CODES_KEY);
    if (Array.isArray(data[GMAIL_SEEN_CODES_KEY])) {
      seenCodes = new Set(data[GMAIL_SEEN_CODES_KEY]);
      console.log(GMAIL_PREFIX, `Loaded ${seenCodes.size} previously seen codes`);
    }
  } catch (err) {
    console.warn(GMAIL_PREFIX, 'Session storage unavailable, using in-memory seen codes:', err?.message || err);
  }
}

async function persistSeenCodes() {
  try {
    await chrome.storage.session.set({ [GMAIL_SEEN_CODES_KEY]: [...seenCodes] });
  } catch (err) {
    console.warn(GMAIL_PREFIX, 'Could not persist seen codes, continuing in-memory only:', err?.message || err);
  }
}

loadSeenCodes();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    resetStopState();
    handlePollEmail(message.step, message.payload).then((result) => {
      sendResponse(result);
    }).catch((err) => {
      if (isStopError(err)) {
        log(`步骤 ${message.step}：已被用户停止。`, 'warn');
        sendResponse({ stopped: true, error: err.message });
        return;
      }
      log(`步骤 ${message.step}：Gmail 轮询失败：${err.message}`, 'warn');
      sendResponse({ error: err.message });
    });
    return true;
  }
});

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isDisplayed(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isVisibleElement(element) {
  if (!isDisplayed(element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalizeMinuteTimestamp(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  const date = new Date(timestamp);
  date.setSeconds(0, 0);
  return date.getTime();
}

function extractEmails(text) {
  const matches = String(text || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  return [...new Set(matches.map((item) => item.toLowerCase()))];
}

function emailMatchesTarget(candidate, targetEmail) {
  const normalizedCandidate = String(candidate || '').trim().toLowerCase();
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  return Boolean(normalizedCandidate && normalizedTarget && normalizedCandidate === normalizedTarget);
}

function getTargetEmailMatchState(text, targetEmail) {
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  if (!normalizedTarget) {
    return { matches: true, hasExplicitEmail: false };
  }

  const normalizedText = String(text || '').toLowerCase();
  if (normalizedText.includes(normalizedTarget)) {
    return { matches: true, hasExplicitEmail: true };
  }

  const atIndex = normalizedTarget.indexOf('@');
  if (atIndex > 0) {
    const encodedTarget = `${normalizedTarget.slice(0, atIndex)}=${normalizedTarget.slice(atIndex + 1)}`;
    if (normalizedText.includes(encodedTarget)) {
      return { matches: true, hasExplicitEmail: true };
    }
  }

  const emails = extractEmails(text);
  if (!emails.length) {
    return { matches: false, hasExplicitEmail: false };
  }

  return {
    matches: emails.some((email) => emailMatchesTarget(email, normalizedTarget)),
    hasExplicitEmail: true,
  };
}

const MONTH_INDEX_MAP = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function parseGmailTimestampText(rawText) {
  const text = normalizeText(rawText);
  if (!text) return null;

  const parsedNative = Date.parse(text);
  if (Number.isFinite(parsedNative)) {
    return parsedNative;
  }

  let match = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
  if (match) {
    const [, year, month, day, hourText, minute, meridiem] = match;
    let hour = Number(hourText);
    if (/pm/i.test(meridiem) && hour < 12) hour += 12;
    if (/am/i.test(meridiem) && hour === 12) hour = 0;
    return new Date(Number(year), Number(month) - 1, Number(day), hour, Number(minute), 0, 0).getTime();
  }

  match = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4}),?\s*(\d{1,2}):(\d{2})\s*([AP]M)\b/i);
  if (match) {
    const [, monthText, day, year, hourText, minute, meridiem] = match;
    const month = MONTH_INDEX_MAP[monthText.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      let hour = Number(hourText);
      if (/pm/i.test(meridiem) && hour < 12) hour += 12;
      if (/am/i.test(meridiem) && hour === 12) hour = 0;
      return new Date(Number(year), month, Number(day), hour, Number(minute), 0, 0).getTime();
    }
  }

  match = text.match(/今天\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]), 0, 0).getTime();
  }

  match = text.match(/昨天\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const now = new Date();
    now.setDate(now.getDate() - 1);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]), 0, 0).getTime();
  }

  match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(match[1]), Number(match[2]), 0, 0).getTime();
  }

  return null;
}

function extractVerificationCode(text) {
  const normalized = String(text || '');

  const cnMatch = normalized.match(/(?:验证码|代码)[^0-9]{0,16}(\d{6})/i);
  if (cnMatch) return cnMatch[1];

  const enMatch = normalized.match(/(?:verification\s+code|temporary\s+verification\s+code|your\s+chatgpt\s+code|code(?:\s+is)?)[^0-9]{0,16}(\d{6})/i);
  if (enMatch) return enMatch[1];

  const plainMatch = normalized.match(/\b(\d{6})\b/);
  if (plainMatch) return plainMatch[1];

  return null;
}

function findInboxLink() {
  const selectors = [
    'a[href*="#inbox"]',
    'a[aria-label*="收件箱"]',
    'a[aria-label*="Inbox"]',
  ];

  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    const visible = candidates.find(isVisibleElement);
    if (visible) return visible;
    if (candidates[0]) return candidates[0];
  }

  return Array.from(document.querySelectorAll('a, [role="link"]')).find((element) => {
    const text = normalizeText(
      element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.textContent
    );
    return /收件箱|Inbox/i.test(text);
  }) || null;
}

function findRefreshButton() {
  const selectors = [
    'div[role="button"][data-tooltip="刷新"]',
    'div[role="button"][aria-label="刷新"]',
    'div[role="button"][data-tooltip*="刷新"]',
    'div[role="button"][aria-label*="刷新"]',
    'div[role="button"][data-tooltip="Refresh"]',
    'div[role="button"][aria-label="Refresh"]',
    'div[role="button"][data-tooltip*="Refresh"]',
    'div[role="button"][aria-label*="Refresh"]',
    'div[act="20"][role="button"]',
    'div.asf.T-I-J3.J-J5-Ji',
  ];

  for (const selector of selectors) {
    const matched = document.querySelector(selector);
    const button = matched?.closest?.('[role="button"]') || matched;
    if (button && isVisibleElement(button)) {
      return button;
    }
  }

  return Array.from(document.querySelectorAll('div[role="button"], button')).find((element) => {
    const text = normalizeText(
      element.getAttribute('aria-label')
      || element.getAttribute('data-tooltip')
      || element.getAttribute('title')
      || element.textContent
    );
    return /刷新|Refresh/i.test(text);
  }) || null;
}

function collectThreadRows() {
  const candidates = [
    ...document.querySelectorAll('tr.zA'),
    ...document.querySelectorAll('tr[role="row"]'),
  ];

  const rows = [];
  const seenRows = new Set();

  candidates.forEach((row) => {
    if (!row || seenRows.has(row)) return;
    seenRows.add(row);

    if (!isDisplayed(row)) return;

    const text = normalizeText(row.textContent || row.innerText || '');
    if (!text) return;

    if (
      row.matches('tr.zA')
      || row.querySelector('.bog, .y6, .y2, .afn, [data-thread-id], [data-legacy-thread-id], [data-legacy-last-message-id]')
      || /openai|chatgpt|verify|verification|code|验证码/i.test(text)
    ) {
      rows.push(row);
    }
  });

  return rows;
}

function getRowPreviewText(row) {
  const sender = normalizeText(
    row.querySelector('.zF, .yP, span[email], [email]')?.textContent
    || row.querySelector('[email]')?.getAttribute?.('email')
    || ''
  );

  const subject = normalizeText(
    row.querySelector('.bog [data-thread-id], .bog [data-legacy-thread-id], .bog, .y6, .bqe')?.textContent
    || ''
  );

  const digest = normalizeText(
    row.querySelector('.y2, .afn, .a4W, .bog + .y2')?.textContent
    || ''
  );

  const timeText = normalizeText(
    row.querySelector('td.xW span')?.getAttribute?.('title')
    || row.querySelector('td.xW span, td.xW time')?.getAttribute?.('title')
    || row.querySelector('td.xW span, td.xW time')?.textContent
    || ''
  );

  const fullText = normalizeText(row.textContent || row.innerText || '');

  return {
    sender,
    subject,
    digest,
    timeText,
    fullText,
    combinedText: normalizeText([sender, subject, digest, timeText, fullText].filter(Boolean).join(' ')),
  };
}

function getRowTimestamp(row) {
  const timeCell = row.querySelector('td.xW span, td.xW time, td.xW [title]');
  const candidates = [
    timeCell?.getAttribute?.('title'),
    timeCell?.getAttribute?.('aria-label'),
    timeCell?.textContent,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = parseGmailTimestampText(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function getRowFingerprint(row, index = 0) {
  const marker = row.querySelector('[data-thread-id], [data-legacy-thread-id], [data-legacy-last-message-id]');
  const stableId = row.getAttribute('data-thread-id')
    || row.getAttribute('data-legacy-thread-id')
    || row.getAttribute('data-legacy-last-message-id')
    || marker?.getAttribute?.('data-thread-id')
    || marker?.getAttribute?.('data-legacy-thread-id')
    || marker?.getAttribute?.('data-legacy-last-message-id')
    || row.getAttribute('id')
    || `row-${index}`;
  const preview = getRowPreviewText(row);
  return `${stableId}::${preview.subject}::${preview.timeText}`.slice(0, 300);
}

function getCurrentMailIds(rows = []) {
  const ids = new Set();
  const sourceRows = rows.length ? rows : collectThreadRows();
  sourceRows.forEach((row, index) => {
    ids.add(getRowFingerprint(row, index));
  });
  return ids;
}

function rowMatchesFilters(preview, senderFilters, subjectFilters) {
  const senderText = normalizeText(preview.sender).toLowerCase();
  const subjectText = normalizeText(preview.subject).toLowerCase();
  const combinedText = normalizeText(preview.combinedText).toLowerCase();

  const senderMatch = senderFilters.some((filter) => {
    const value = String(filter || '').toLowerCase();
    return value && (senderText.includes(value) || combinedText.includes(value));
  });

  const subjectMatch = subjectFilters.some((filter) => {
    const value = String(filter || '').toLowerCase();
    return value && (subjectText.includes(value) || combinedText.includes(value));
  });

  return senderMatch || subjectMatch;
}

async function ensureInboxReady(step) {
  if (!/#inbox/i.test(location.href)) {
    const inboxLink = findInboxLink();
    if (inboxLink) {
      simulateClick(inboxLink);
      await sleep(800);
      log(`步骤 ${step}：已切回 Gmail 收件箱。`);
    } else {
      location.hash = '#inbox';
      await sleep(800);
    }
  }

  for (let i = 0; i < 20; i++) {
    const rows = collectThreadRows();
    if (rows.length > 0) {
      return rows;
    }
    await sleep(400);
  }

  return [];
}

async function refreshInbox(step) {
  const refreshButton = findRefreshButton();
  if (refreshButton) {
    simulateClick(refreshButton);
    log(`步骤 ${step}：已点击 Gmail 刷新。`);
    await sleep(1500);
    return;
  }

  const inboxLink = findInboxLink();
  if (inboxLink) {
    simulateClick(inboxLink);
    log(`步骤 ${step}：未找到刷新按钮，已重新进入收件箱。`);
    await sleep(1200);
    return;
  }

  location.reload();
  log(`步骤 ${step}：未找到刷新按钮，已直接刷新页面。`);
  await sleep(2500);
}

async function returnToInbox() {
  if (/#inbox/i.test(location.href) && collectThreadRows().length > 0) {
    return;
  }

  const inboxLink = findInboxLink();
  if (inboxLink) {
    simulateClick(inboxLink);
  } else {
    location.hash = '#inbox';
  }

  for (let i = 0; i < 20; i++) {
    if (collectThreadRows().length > 0) {
      return;
    }
    await sleep(250);
  }
}

async function openRowAndGetMessageText(row) {
  simulateClick(row);

  for (let i = 0; i < 20; i++) {
    const messageContainer = document.querySelector('div[role="main"] .a3s, div[role="main"] [data-message-id], h2[data-thread-perm-id]');
    if (messageContainer || !/#inbox/i.test(location.href)) {
      break;
    }
    await sleep(250);
  }

  await sleep(900);
  const main = document.querySelector('div[role="main"]');
  const text = normalizeText(main?.innerText || document.body?.innerText || document.body?.textContent || '');
  await returnToInbox();
  return text;
}

async function handlePollEmail(step, payload) {
  const {
    senderFilters = [],
    subjectFilters = [],
    maxAttempts = 5,
    intervalMs = 3000,
    filterAfterTimestamp = 0,
    excludeCodes = [],
    targetEmail = '',
  } = payload || {};

  const excludedCodeSet = new Set(excludeCodes.filter(Boolean));
  const filterAfterMinute = normalizeMinuteTimestamp(Number(filterAfterTimestamp) || 0);

  log(`步骤 ${step}：开始轮询 Gmail（最多 ${maxAttempts} 次）`);
  if (filterAfterMinute) {
    log(`步骤 ${step}：仅尝试 ${new Date(filterAfterMinute).toLocaleString('zh-CN', { hour12: false })} 及之后时间的邮件。`);
  }

  let initialRows = await ensureInboxReady(step);
  if (!initialRows.length) {
    await refreshInbox(step);
    initialRows = await ensureInboxReady(step);
  }

  if (!initialRows.length) {
    throw new Error('Gmail 收件箱列表未加载完成，请确认当前已打开 Gmail 收件箱。');
  }

  const existingMailIds = getCurrentMailIds(initialRows);
  log(`步骤 ${step}：已记录当前 ${existingMailIds.size} 封旧邮件快照`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`步骤 ${step}：正在轮询 Gmail，第 ${attempt}/${maxAttempts} 次`);

    if (attempt > 1) {
      await refreshInbox(step);
    }

    const rows = collectThreadRows();
    const useFallback = attempt > GMAIL_FALLBACK_AFTER;

    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const rowId = getRowFingerprint(row, index);
      const rowTimestamp = getRowTimestamp(row);
      const rowMinute = normalizeMinuteTimestamp(rowTimestamp || 0);
      const passesTimeFilter = !filterAfterMinute || (rowMinute && rowMinute >= filterAfterMinute);
      const shouldBypassOldSnapshot = Boolean(filterAfterMinute && passesTimeFilter && rowMinute > 0);

      if (!passesTimeFilter) {
        continue;
      }

      if (!useFallback && !shouldBypassOldSnapshot && existingMailIds.has(rowId)) {
        continue;
      }

      const preview = getRowPreviewText(row);
      if (!rowMatchesFilters(preview, senderFilters, subjectFilters)) {
        continue;
      }

      const previewTargetState = getTargetEmailMatchState(preview.combinedText, targetEmail);
      const previewEmails = extractEmails(preview.combinedText);
      if (targetEmail && previewEmails.length > 0 && !previewTargetState.matches) {
        continue;
      }

      const previewCode = extractVerificationCode(preview.combinedText);
      if (previewCode && previewTargetState.matches) {
        if (excludedCodeSet.has(previewCode)) {
          log(`步骤 ${step}：跳过排除的验证码：${previewCode}`, 'info');
          continue;
        }
        if (seenCodes.has(previewCode)) {
          log(`步骤 ${step}：跳过已处理过的验证码：${previewCode}`, 'info');
          continue;
        }
        seenCodes.add(previewCode);
        persistSeenCodes();
        const source = useFallback && existingMailIds.has(rowId) ? '回退匹配邮件' : '新邮件';
        const timeLabel = rowTimestamp ? `，时间：${new Date(rowTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
        log(`步骤 ${step}：已在 Gmail 找到验证码：${previewCode}（来源：${source}${timeLabel}）`, 'ok');
        return {
          ok: true,
          code: previewCode,
          emailTimestamp: Date.now(),
          mailId: rowId,
        };
      }

      const openedText = await openRowAndGetMessageText(row);
      const openedTargetState = getTargetEmailMatchState(openedText, targetEmail);
      if (targetEmail && openedTargetState.hasExplicitEmail && !openedTargetState.matches) {
        continue;
      }

      const bodyCode = extractVerificationCode(openedText);
      if (!bodyCode) {
        continue;
      }
      if (excludedCodeSet.has(bodyCode)) {
        log(`步骤 ${step}：跳过排除的验证码：${bodyCode}`, 'info');
        continue;
      }
      if (seenCodes.has(bodyCode)) {
        log(`步骤 ${step}：跳过已处理过的验证码：${bodyCode}`, 'info');
        continue;
      }
      seenCodes.add(bodyCode);
      persistSeenCodes();
      const source = useFallback && existingMailIds.has(rowId) ? '回退匹配邮件正文' : '新邮件正文';
      const timeLabel = rowTimestamp ? `，时间：${new Date(rowTimestamp).toLocaleString('zh-CN', { hour12: false })}` : '';
      log(`步骤 ${step}：已在 Gmail 正文中找到验证码：${bodyCode}（来源：${source}${timeLabel}）`, 'ok');
      return {
        ok: true,
        code: bodyCode,
        emailTimestamp: Date.now(),
        mailId: rowId,
      };
    }

    if (attempt === GMAIL_FALLBACK_AFTER + 1) {
      log(`步骤 ${step}：连续 ${GMAIL_FALLBACK_AFTER} 次未发现新邮件，开始回退到首封匹配邮件`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `${(maxAttempts * intervalMs / 1000).toFixed(0)} 秒后仍未在 Gmail 中找到匹配邮件。请手动检查 Gmail 收件箱。`
  );
}

}
