const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

function createRow(initialDisplay = 'none') {
  return {
    style: { display: initialDisplay },
  };
}

test('sidepanel html places cloudflare temp email controls in a standalone section', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  assert.match(html, /id="cloudflare-temp-email-section"/);
  assert.match(html, /id="btn-cloudflare-temp-email-usage-guide"/);
  assert.match(html, /id="btn-cloudflare-temp-email-github"/);
  assert.match(html, /id="row-temp-email-random-subdomain-toggle"/);
  assert.match(html, /id="input-temp-email-use-random-subdomain"/);
  assert.doesNotMatch(html, /id="row-temp-email-random-subdomain-domain"/);
});

test('sidepanel modal message preserves line breaks and supports inline links', () => {
  const css = fs.readFileSync('sidepanel/sidepanel.css', 'utf8');
  assert.match(css, /\.modal-message\s*\{[\s\S]*white-space:\s*pre-line;/);
  assert.match(css, /\.modal-message a,\s*[\s\S]*\.modal-alert a/);
});

test('buildCloudflareTempEmailUsageGuideModalConfig returns a modal payload with inline links for generator mode', () => {
  const bundle = extractFunction('buildCloudflareTempEmailUsageGuideModalConfig');

  const api = new Function(`
const selectMailProvider = { value: '163' };
const selectEmailGenerator = { value: 'cloudflare-temp-email' };
const CLOUDFLARE_TEMP_EMAIL_BUILD_TUTORIAL_URL = 'https://linux.do/t/topic/316819';
const CLOUDFLARE_TEMP_EMAIL_RANDOM_SUBDOMAIN_ISSUE_URL = 'https://github.com/dreamhunter2333/cloudflare_temp_email/issues/942';
function getSelectedEmailGenerator() { return String(selectEmailGenerator.value || '').trim().toLowerCase(); }
${bundle}
return {
  buildCloudflareTempEmailUsageGuideModalConfig,
};
  `)();

  const modalConfig = api.buildCloudflareTempEmailUsageGuideModalConfig();
  assert.equal(typeof modalConfig.title, 'string');
  assert.equal(typeof modalConfig.messageHtml, 'string');
  assert.equal(typeof modalConfig.alert?.text, 'string');
  assert.equal(modalConfig.title.length > 0, true);
  assert.equal(modalConfig.messageHtml.length > 0, true);
  assert.equal(modalConfig.alert.text.length > 0, true);
  assert.equal(modalConfig.messageHtml.includes('<a '), true);
  assert.equal(modalConfig.messageHtml.includes('Issue #942'), true);
  assert.equal(modalConfig.messageHtml.includes('LINUX DO 教程'), true);
});

test('buildCloudflareTempEmailUsageGuideModalConfig returns a distinct alert for provider mode', () => {
  const bundle = extractFunction('buildCloudflareTempEmailUsageGuideModalConfig');

  const api = new Function(`
const selectMailProvider = { value: 'cloudflare-temp-email' };
const selectEmailGenerator = { value: 'duck' };
const CLOUDFLARE_TEMP_EMAIL_BUILD_TUTORIAL_URL = 'https://linux.do/t/topic/316819';
const CLOUDFLARE_TEMP_EMAIL_RANDOM_SUBDOMAIN_ISSUE_URL = 'https://github.com/dreamhunter2333/cloudflare_temp_email/issues/942';
function getSelectedEmailGenerator() { return String(selectEmailGenerator.value || '').trim().toLowerCase(); }
${bundle}
return {
  buildCloudflareTempEmailUsageGuideModalConfig,
};
  `)();

  const providerConfig = api.buildCloudflareTempEmailUsageGuideModalConfig();

  const generatorApi = new Function(`
const selectMailProvider = { value: '163' };
const selectEmailGenerator = { value: 'cloudflare-temp-email' };
const CLOUDFLARE_TEMP_EMAIL_BUILD_TUTORIAL_URL = 'https://linux.do/t/topic/316819';
const CLOUDFLARE_TEMP_EMAIL_RANDOM_SUBDOMAIN_ISSUE_URL = 'https://github.com/dreamhunter2333/cloudflare_temp_email/issues/942';
function getSelectedEmailGenerator() { return String(selectEmailGenerator.value || '').trim().toLowerCase(); }
${bundle}
return {
  buildCloudflareTempEmailUsageGuideModalConfig,
};
  `)();

  const generatorConfig = generatorApi.buildCloudflareTempEmailUsageGuideModalConfig();
  assert.equal(typeof providerConfig.alert?.text, 'string');
  assert.equal(typeof providerConfig.messageHtml, 'string');
  assert.equal(providerConfig.alert.text.length > 0, true);
  assert.equal(providerConfig.messageHtml.length > 0, true);
  assert.notEqual(providerConfig.alert.text, generatorConfig.alert.text);
});

test('openCloudflareTempEmailRepositoryPage opens the upstream repository', () => {
  const bundle = extractFunction('openCloudflareTempEmailRepositoryPage');

  const api = new Function(`
const calls = [];
const CLOUDFLARE_TEMP_EMAIL_REPOSITORY_URL = 'https://github.com/dreamhunter2333/cloudflare_temp_email';
function openExternalUrl(url) { calls.push(url); }
${bundle}
return {
  calls,
  openCloudflareTempEmailRepositoryPage,
};
  `)();

  api.openCloudflareTempEmailRepositoryPage();
  assert.deepEqual(api.calls, ['https://github.com/dreamhunter2333/cloudflare_temp_email']);
});

test('applyCloudflareTempEmailSettingsState restores the random subdomain toggle and temp domain list', () => {
  const bundle = extractFunction('applyCloudflareTempEmailSettingsState');

  const api = new Function(`
const inputTempEmailBaseUrl = { value: '' };
const inputTempEmailAdminAuth = { value: '' };
const inputTempEmailCustomAuth = { value: '' };
const inputTempEmailReceiveMailbox = { value: '' };
const inputTempEmailUseRandomSubdomain = { checked: false };
const calls = {
  domainOptions: [],
  domainEditMode: [],
};
function renderCloudflareTempEmailDomainOptions(value) { calls.domainOptions.push(value); }
function setCloudflareTempEmailDomainEditMode(editing, options) { calls.domainEditMode.push({ editing, options }); }
${bundle}
return {
  applyCloudflareTempEmailSettingsState,
  calls,
  inputTempEmailBaseUrl,
  inputTempEmailAdminAuth,
  inputTempEmailCustomAuth,
  inputTempEmailReceiveMailbox,
  inputTempEmailUseRandomSubdomain,
};
  `)();

  api.applyCloudflareTempEmailSettingsState({
    cloudflareTempEmailBaseUrl: 'https://temp.example.com',
    cloudflareTempEmailAdminAuth: 'admin-secret',
    cloudflareTempEmailCustomAuth: 'custom-secret',
    cloudflareTempEmailReceiveMailbox: 'relay@example.com',
    cloudflareTempEmailUseRandomSubdomain: true,
    cloudflareTempEmailDomain: 'mail.example.com',
  });

  assert.equal(api.inputTempEmailBaseUrl.value, 'https://temp.example.com');
  assert.equal(api.inputTempEmailAdminAuth.value, 'admin-secret');
  assert.equal(api.inputTempEmailCustomAuth.value, 'custom-secret');
  assert.equal(api.inputTempEmailReceiveMailbox.value, 'relay@example.com');
  assert.equal(api.inputTempEmailUseRandomSubdomain.checked, true);
  assert.deepEqual(api.calls.domainOptions, ['mail.example.com']);
  assert.deepEqual(api.calls.domainEditMode, [{ editing: false, options: { clearInput: true } }]);
});

test('updateMailProviderUI keeps the temp domain selector visible and updates the hint when random subdomain is enabled', () => {
  const bundle = extractFunction('updateMailProviderUI');

  const api = new Function(`
let latestState = {
  cloudflareTempEmailDomains: ['mail.example.com'],
};
let cloudflareTempEmailDomainEditMode = false;
const ICLOUD_PROVIDER = 'icloud';
const GMAIL_PROVIDER = 'gmail';
const LUCKMAIL_PROVIDER = 'luckmail-api';
const rowMail2925Mode = ${JSON.stringify(createRow('none'))};
const rowMail2925PoolSettings = ${JSON.stringify(createRow('none'))};
const rowEmailPrefix = ${JSON.stringify(createRow('none'))};
const rowInbucketHost = ${JSON.stringify(createRow('none'))};
const rowInbucketMailbox = ${JSON.stringify(createRow('none'))};
const rowEmailGenerator = ${JSON.stringify(createRow(''))};
const rowCfDomain = ${JSON.stringify(createRow('none'))};
const rowTempEmailBaseUrl = ${JSON.stringify(createRow('none'))};
const rowTempEmailAdminAuth = ${JSON.stringify(createRow('none'))};
const rowTempEmailCustomAuth = ${JSON.stringify(createRow('none'))};
const rowTempEmailReceiveMailbox = ${JSON.stringify(createRow('none'))};
const rowTempEmailRandomSubdomainToggle = ${JSON.stringify(createRow('none'))};
const rowTempEmailDomain = ${JSON.stringify(createRow('none'))};
const cloudflareTempEmailSection = ${JSON.stringify(createRow('none'))};
const hotmailSection = ${JSON.stringify(createRow('none'))};
const mail2925Section = ${JSON.stringify(createRow('none'))};
const luckmailSection = ${JSON.stringify(createRow('none'))};
const icloudSection = ${JSON.stringify(createRow('none'))};
const labelEmailPrefix = { textContent: '' };
const inputEmailPrefix = { placeholder: '', style: { display: '' }, readOnly: false };
const labelMail2925UseAccountPool = ${JSON.stringify(createRow('none'))};
const selectMail2925PoolAccount = { style: { display: 'none' }, disabled: false };
const btnFetchEmail = { hidden: false, disabled: false, textContent: '' };
const btnMailLogin = { disabled: false, textContent: '', title: '' };
const inputEmail = { readOnly: false, placeholder: '', value: '' };
const autoHintText = { textContent: '' };
const rowHotmailServiceMode = ${JSON.stringify(createRow('none'))};
const rowHotmailRemoteBaseUrl = ${JSON.stringify(createRow('none'))};
const rowHotmailLocalBaseUrl = ${JSON.stringify(createRow('none'))};
const inputMail2925UseAccountPool = { checked: false };
const selectMailProvider = { value: '163' };
const selectEmailGenerator = { value: 'cloudflare-temp-email', disabled: false };
const inputTempEmailUseRandomSubdomain = { checked: false };
const calls = {
  tempDomainEditMode: [],
};
function isLuckmailProvider() { return false; }
function isCustomMailProvider() { return false; }
function isIcloudMailProvider() { return false; }
function usesGeneratedAliasMailProvider() { return false; }
function getSelectedMail2925Mode() { return 'provide'; }
function getManagedAliasProviderUiCopy() { return null; }
function getCurrentRegistrationEmailUiCopy() {
  return {
    buttonLabel: '生成 Temp',
    placeholder: '点击生成 Cloudflare Temp Email，或手动粘贴邮箱',
    label: 'Cloudflare Temp Email',
  };
}
function updateMailLoginButtonState() {}
function getSelectedHotmailServiceMode() { return 'local'; }
function getCloudflareDomainsFromState() { return { domains: [], activeDomain: '' }; }
function setCloudflareDomainEditMode() {}
function getCloudflareTempEmailDomainsFromState() { return { domains: ['mail.example.com'], activeDomain: 'mail.example.com' }; }
function setCloudflareTempEmailDomainEditMode(editing) { calls.tempDomainEditMode.push(editing); }
function queueIcloudAliasRefresh() {}
function hideIcloudLoginHelp() {}
function syncMail2925PoolAccountOptions() {}
function getMail2925Accounts() { return []; }
function renderHotmailAccounts() {}
function renderMail2925Accounts() {}
function renderLuckmailPurchases() {}
function getSelectedEmailGenerator() { return String(selectEmailGenerator.value || '').trim().toLowerCase(); }
function isAutoRunLockedPhase() { return false; }
${bundle}
return {
  updateMailProviderUI,
  cloudflareTempEmailSection,
  rowTempEmailRandomSubdomainToggle,
  rowTempEmailDomain,
  inputTempEmailUseRandomSubdomain,
  autoHintText,
  calls,
};
  `)();

  api.updateMailProviderUI();
  assert.equal(api.cloudflareTempEmailSection.style.display, '');
  assert.equal(api.rowTempEmailRandomSubdomainToggle.style.display, '');
  assert.equal(api.rowTempEmailDomain.style.display, '');

  api.inputTempEmailUseRandomSubdomain.checked = true;
  api.updateMailProviderUI();
  assert.equal(api.cloudflareTempEmailSection.style.display, '');
  assert.equal(api.rowTempEmailDomain.style.display, '');
  assert.match(api.autoHintText.textContent, /RANDOM_SUBDOMAIN_DOMAINS/);
});
