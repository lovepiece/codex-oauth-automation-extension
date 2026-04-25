const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => sidepanelSource.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let index = start; index < sidepanelSource.length; index += 1) {
    const ch = sidepanelSource[index];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = index;
      break;
    }
  }

  let depth = 0;
  let end = braceStart;
  for (; end < sidepanelSource.length; end += 1) {
    const ch = sidepanelSource[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return sidepanelSource.slice(start, end);
}

test('sidepanel html exposes header repo entry and version label', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');

  assert.match(
    html,
    /id="btn-repo-home"[\s\S]*title="打开 GitHub 仓库"/
  );
  assert.match(
    html,
    /<span id="extension-update-status" class="header-version-title">Pro0\.0<\/span>/
  );
  assert.doesNotMatch(html, /update-service\.js|btn-release-log|update-section|GitHub Releases/);
});

test('header repo helper opens repository url', () => {
  const bundle = [
    extractFunction('getRepositoryHomeUrl'),
    extractFunction('openRepositoryHomePage'),
  ].join('\n');

  const api = new Function(`
const opened = [];
function openExternalUrl(url) {
  opened.push(url);
}
${bundle}
return {
  getRepositoryHomeUrl,
  openRepositoryHomePage,
  getOpened() {
    return opened;
  },
};
`)();

  assert.equal(
    api.getRepositoryHomeUrl(),
    'https://github.com/QLHazyCoder/codex-oauth-automation-extension'
  );

  api.openRepositoryHomePage();

  assert.deepEqual(api.getOpened(), [
    'https://github.com/QLHazyCoder/codex-oauth-automation-extension',
  ]);
});
