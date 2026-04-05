// content/mail-163.js — Content script for 163 Mail (steps 4, 7)
// Injected on: mail.163.com
//
// Actual 163 Mail DOM structure:
// <div class="rF0" sign="letter" id="...Dom" aria-label="你的 ChatGPT 代码为 479637 发件人 ： OpenAI ...">
//   <div class="dP0" sign="start-from">
//     <span class="nui-user">OpenAI</span>
//   </div>
//   <div class="il0">
//     <span class="da0">你的 ChatGPT 代码为 479637</span>
//   </div>
// </div>

const MAIL163_PREFIX = '[MultiPage:mail-163]';
const isTopFrame = window === window.top;

console.log(MAIL163_PREFIX, 'Content script loaded on', location.href, 'frame:', isTopFrame ? 'top' : 'child');

// Only operate in the top frame — child iframes don't have the inbox
if (!isTopFrame) {
  console.log(MAIL163_PREFIX, 'Skipping child frame');
  // Don't report ready or handle messages from child frames
} else {

// ============================================================
// Message Handler (top frame only)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'POLL_EMAIL') {
    handlePollEmail(message.step, message.payload).then(result => {
      sendResponse(result);
    }).catch(err => {
      reportError(message.step, err.message);
      sendResponse({ error: err.message });
    });
    return true;
  }
});

// ============================================================
// Get all current mail IDs
// ============================================================

function getCurrentMailIds() {
  const ids = new Set();
  // 163 mail items have sign="letter" and id ending with "Dom"
  const items = findMailItems();
  for (const item of items) {
    const id = item.getAttribute('id') || '';
    if (id) ids.add(id);
  }
  return ids;
}

function findMailItems() {
  // Try current document first
  let items = document.querySelectorAll('div[sign="letter"]');
  if (items.length > 0) return items;

  // Try iframes (163 mail may use iframes)
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (doc) {
        items = doc.querySelectorAll('div[sign="letter"]');
        if (items.length > 0) return items;
      }
    } catch { }
  }
  return [];
}

// ============================================================
// Email Polling
// ============================================================

async function handlePollEmail(step, payload) {
  const { senderFilters, subjectFilters, maxAttempts, intervalMs } = payload;

  log(`Step ${step}: Starting email poll on 163 Mail (max ${maxAttempts} attempts)`);

  // Wait for sidebar to load, then click "收件箱"
  log(`Step ${step}: Waiting for 163 Mail sidebar to load...`);
  try {
    const inboxLink = await waitForElement('.nui-tree-item-text[title="收件箱"]', 5000);
    inboxLink.click();
    log(`Step ${step}: Clicked inbox in sidebar`);
  } catch {
    log(`Step ${step}: Could not find inbox link, trying to proceed anyway...`, 'warn');
  }

  // Wait for mail list — poll every 500ms, max 10s
  log(`Step ${step}: Waiting for mail list...`);
  let items = [];
  for (let i = 0; i < 20; i++) {
    items = findMailItems();
    if (items.length > 0) break;
    await sleep(500);
  }

  if (items.length === 0) {
    log(`Step ${step}: Mail list not found, trying refresh...`, 'warn');
    await refreshInbox();
    await sleep(2000);
    items = findMailItems();
  }

  if (items.length === 0) {
    throw new Error('163 Mail list did not load. Make sure inbox is open and has emails.');
  }

  log(`Step ${step}: Mail list loaded, ${items.length} items found`);

  const existingMailIds = getCurrentMailIds();
  log(`Step ${step}: Snapshotted ${existingMailIds.size} existing emails`);

  const FALLBACK_AFTER = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Polling 163 Mail... attempt ${attempt}/${maxAttempts}`);

    if (attempt > 1) {
      await refreshInbox();
      await sleep(1000);
    }

    const allItems = findMailItems();
    const useFallback = attempt > FALLBACK_AFTER;

    for (const item of allItems) {
      const id = item.getAttribute('id') || '';

      if (!useFallback && existingMailIds.has(id)) continue;

      // Get sender from .nui-user
      const senderEl = item.querySelector('.nui-user');
      const sender = senderEl ? senderEl.textContent.toLowerCase() : '';

      // Get subject from span.da0
      const subjectEl = item.querySelector('span.da0');
      const subject = subjectEl ? subjectEl.textContent : '';

      // Also check aria-label which contains full info
      const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

      const senderMatch = senderFilters.some(f => sender.includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));
      const subjectMatch = subjectFilters.some(f => subject.toLowerCase().includes(f.toLowerCase()) || ariaLabel.includes(f.toLowerCase()));

      if (senderMatch || subjectMatch) {
        const code = extractVerificationCode(subject + ' ' + ariaLabel);
        if (code) {
          const source = useFallback && existingMailIds.has(id) ? 'fallback' : 'new';
          log(`Step ${step}: Code found: ${code} (${source}, subject: ${subject.slice(0, 40)})`, 'ok');
          return { ok: true, code, emailTimestamp: Date.now(), mailId: id };
        }
      }
    }

    if (attempt === FALLBACK_AFTER + 1) {
      log(`Step ${step}: No new emails after ${FALLBACK_AFTER} attempts, falling back to first match`, 'warn');
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `No matching email found on 163 Mail after ${(maxAttempts * intervalMs / 1000).toFixed(0)}s. ` +
    'Check inbox manually.'
  );
}

// ============================================================
// Inbox Refresh
// ============================================================

async function refreshInbox() {
  // 163 mail: try the toolbar "刷 新" button first
  // Actual DOM: <div class="js-component-button nui-btn"><span class="nui-btn-text">刷 新</span></div>
  const toolbarBtns = document.querySelectorAll('.nui-btn .nui-btn-text');
  for (const btn of toolbarBtns) {
    if (btn.textContent.replace(/\s/g, '') === '刷新') {
      btn.closest('.nui-btn').click();
      console.log(MAIL163_PREFIX, 'Clicked toolbar "刷新" button');
      await sleep(800);
      return;
    }
  }

  // Fallback: click the left sidebar "收 信" button
  // Actual DOM: <li class="ra0 nb0"><span class="oz0">收 信</span></li>
  const shouXinBtns = document.querySelectorAll('.ra0');
  for (const btn of shouXinBtns) {
    if (btn.textContent.replace(/\s/g, '').includes('收信')) {
      btn.click();
      console.log(MAIL163_PREFIX, 'Clicked sidebar "收信" button');
      await sleep(800);
      return;
    }
  }

  console.log(MAIL163_PREFIX, 'Could not find refresh button');
}

// ============================================================
// Verification Code Extraction
// ============================================================

function extractVerificationCode(text) {
  const matchCn = text.match(/(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})/);
  if (matchCn) return matchCn[1];

  const matchEn = text.match(/code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})/i);
  if (matchEn) return matchEn[1] || matchEn[2];

  const match6 = text.match(/\b(\d{6})\b/);
  if (match6) return match6[1];

  return null;
}

} // end of isTopFrame else block
