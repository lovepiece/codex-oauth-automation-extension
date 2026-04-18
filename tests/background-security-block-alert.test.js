const test = require('node:test');const assert = require('node:assert/strict');const fs = require('node:fs');const source = fs.readFileSync('background.js', 'utf8');function extractFunction(name) {  const markers = [`async function ${name}(`, `function ${name}(`];  const start = markers    .map((marker) => source.indexOf(marker))    .find((index) => index >= 0);  if (start < 0) {    throw new Error(`missing function ${name}`);  }  let parenDepth = 0;  let signatureEnded = false;  let braceStart = -1;  for (let i = start; i < source.length; i += 1) {    const ch = source[i];    if (ch === '(') {      parenDepth += 1;    } else if (ch === ')') {      parenDepth -= 1;      if (parenDepth === 0) {        signatureEnded = true;      }    } else if (ch === '{' && signatureEnded) {      braceStart = i;      break;    }  }  if (braceStart < 0) {    throw new Error(`missing body for function ${name}`);  }  let depth = 0;  let end = braceStart;  for (; end < source.length; end += 1) {    const ch = source[end];    if (ch === '{') depth += 1;    if (ch === '}') {      depth -= 1;      if (depth === 0) {        end += 1;        break;      }    }  }  return source.slice(start, end);}test('security blocked alert title distinguishes cloudflare and network timeout', () => {
  const api = new Function(`
const CLOUDFLARE_SECURITY_BLOCK_ERROR_PREFIX = 'CF_SECURITY_BLOCKED::';
${extractFunction('getErrorMessage')}
${extractFunction('isCloudflareSecurityBlockedError')}
${extractFunction('getTerminalSecurityBlockedTitle')}
return { getTerminalSecurityBlockedTitle };
`)();
  assert.equal(
    api.getTerminalSecurityBlockedTitle(new Error('CF_SECURITY_BLOCKED::blocked')),
    'Cloudflare 风控拦截'
  );
});
