const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadGeneratedEmailHelpersApi() {
  const source = fs.readFileSync('background/generated-email-helpers.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageGeneratedEmailHelpers;`)(globalScope);
}

test('background imports generated email helper module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /importScripts\([\s\S]*'background\/generated-email-helpers\.js'/);
});

test('generated email helper module exposes a factory', () => {
  const api = loadGeneratedEmailHelpersApi();

  assert.equal(typeof api?.createGeneratedEmailHelpers, 'function');
});

test('generated email helper falls back to normal generator when 2925 is in receive mode', async () => {
  const api = loadGeneratedEmailHelpersApi();
  const events = [];

  const helpers = api.createGeneratedEmailHelpers({
    addLog: async () => {},
    buildGeneratedAliasEmail: () => {
      throw new Error('should not build alias in receive mode');
    },
    buildCloudflareTempEmailHeaders: () => ({}),
    CLOUDFLARE_TEMP_EMAIL_GENERATOR: 'cloudflare-temp-email',
    DUCK_AUTOFILL_URL: 'https://duckduckgo.com/email',
    fetch: async () => ({ ok: true, text: async () => '{}' }),
    fetchIcloudHideMyEmail: async () => {
      throw new Error('should not use icloud generator');
    },
    getCloudflareTempEmailAddressFromResponse: () => '',
    getCloudflareTempEmailConfig: () => ({ baseUrl: '', adminAuth: '', domain: '' }),
    getState: async () => ({
      mailProvider: '2925',
      mail2925Mode: 'receive',
      emailGenerator: 'duck',
    }),
    ensureMail2925AccountForFlow: async () => {
      throw new Error('should not allocate 2925 account in receive mode');
    },
    joinCloudflareTempEmailUrl: () => '',
    normalizeCloudflareDomain: () => '',
    normalizeCloudflareTempEmailAddress: () => '',
    normalizeEmailGenerator: (value) => String(value || '').trim().toLowerCase(),
    isGeneratedAliasProvider: (_provider, mail2925Mode) => mail2925Mode === 'provide',
    reuseOrCreateTab: async () => {},
    sendToContentScript: async (_source, message) => {
      events.push(message.type);
      return { email: 'duck@example.com', generated: true };
    },
    setEmailState: async (email) => {
      events.push(['email', email]);
    },
    throwIfStopped: () => {},
  });

  const email = await helpers.fetchGeneratedEmail({
    mailProvider: '2925',
    mail2925Mode: 'receive',
    emailGenerator: 'duck',
  }, {
    mailProvider: '2925',
    mail2925Mode: 'receive',
    generator: 'duck',
  });

  assert.equal(email, 'duck@example.com');
  assert.deepStrictEqual(events, [
    'FETCH_DUCK_EMAIL',
    ['email', 'duck@example.com'],
  ]);
});

test('generated email helper uses the regular temp email domain when random subdomain mode is disabled', async () => {
  const api = loadGeneratedEmailHelpersApi();
  const requests = [];
  const savedEmails = [];

  const helpers = api.createGeneratedEmailHelpers({
    addLog: async () => {},
    buildGeneratedAliasEmail: () => {
      throw new Error('should not build managed alias');
    },
    buildCloudflareTempEmailHeaders: () => ({ 'x-admin-auth': 'admin-secret' }),
    CLOUDFLARE_TEMP_EMAIL_GENERATOR: 'cloudflare-temp-email',
    DUCK_AUTOFILL_URL: 'https://duckduckgo.com/email',
    fetch: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return {
        ok: true,
        text: async () => JSON.stringify({ address: 'user@mail.example.com' }),
      };
    },
    fetchIcloudHideMyEmail: async () => {
      throw new Error('should not use icloud generator');
    },
    getCloudflareTempEmailAddressFromResponse: (payload) => payload.address,
    getCloudflareTempEmailConfig: () => ({
      baseUrl: 'https://temp.example.com',
      adminAuth: 'admin-secret',
      customAuth: '',
      useRandomSubdomain: false,
      domain: 'mail.example.com',
    }),
    getState: async () => ({
      mailProvider: '163',
      emailGenerator: 'cloudflare-temp-email',
    }),
    ensureMail2925AccountForFlow: async () => {
      throw new Error('should not allocate mail2925 account');
    },
    joinCloudflareTempEmailUrl: (baseUrl, path) => `${baseUrl}${path}`,
    normalizeCloudflareDomain: () => '',
    normalizeCloudflareTempEmailAddress: (value) => String(value || '').trim().toLowerCase(),
    normalizeEmailGenerator: (value) => String(value || '').trim().toLowerCase(),
    isGeneratedAliasProvider: () => false,
    reuseOrCreateTab: async () => {},
    sendToContentScript: async () => {
      throw new Error('should not use duck generator');
    },
    setEmailState: async (email) => {
      savedEmails.push(email);
    },
    throwIfStopped: () => {},
  });

  const email = await helpers.fetchGeneratedEmail({
    emailGenerator: 'cloudflare-temp-email',
  }, {
    generator: 'cloudflare-temp-email',
  });

  assert.equal(email, 'user@mail.example.com');
  assert.deepEqual(savedEmails, ['user@mail.example.com']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://temp.example.com/admin/new_address');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    enablePrefix: true,
    enableRandomSubdomain: false,
    name: requests[0].body.name,
    domain: 'mail.example.com',
  });
  assert.match(requests[0].body.name, /^[a-z0-9]+$/);
});

test('generated email helper requests random subdomain creation while preserving the returned address', async () => {
  const api = loadGeneratedEmailHelpersApi();
  const requests = [];
  const savedEmails = [];

  const helpers = api.createGeneratedEmailHelpers({
    addLog: async () => {},
    buildGeneratedAliasEmail: () => {
      throw new Error('should not build managed alias');
    },
    buildCloudflareTempEmailHeaders: () => ({ 'x-admin-auth': 'admin-secret' }),
    CLOUDFLARE_TEMP_EMAIL_GENERATOR: 'cloudflare-temp-email',
    DUCK_AUTOFILL_URL: 'https://duckduckgo.com/email',
    fetch: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return {
        ok: true,
        text: async () => JSON.stringify({ address: 'user@a1b2c3d4.example.com' }),
      };
    },
    fetchIcloudHideMyEmail: async () => {
      throw new Error('should not use icloud generator');
    },
    getCloudflareTempEmailAddressFromResponse: (payload) => payload.address,
    getCloudflareTempEmailConfig: () => ({
      baseUrl: 'https://temp.example.com',
      adminAuth: 'admin-secret',
      customAuth: '',
      useRandomSubdomain: true,
      domain: 'mail.example.com',
    }),
    getState: async () => ({
      mailProvider: '163',
      emailGenerator: 'cloudflare-temp-email',
    }),
    ensureMail2925AccountForFlow: async () => {
      throw new Error('should not allocate mail2925 account');
    },
    joinCloudflareTempEmailUrl: (baseUrl, path) => `${baseUrl}${path}`,
    normalizeCloudflareDomain: () => '',
    normalizeCloudflareTempEmailAddress: (value) => String(value || '').trim().toLowerCase(),
    normalizeEmailGenerator: (value) => String(value || '').trim().toLowerCase(),
    isGeneratedAliasProvider: () => false,
    reuseOrCreateTab: async () => {},
    sendToContentScript: async () => {
      throw new Error('should not use duck generator');
    },
    setEmailState: async (email) => {
      savedEmails.push(email);
    },
    throwIfStopped: () => {},
  });

  const email = await helpers.fetchGeneratedEmail({
    emailGenerator: 'cloudflare-temp-email',
  }, {
    generator: 'cloudflare-temp-email',
    localPart: 'user',
  });

  assert.equal(email, 'user@a1b2c3d4.example.com');
  assert.deepEqual(savedEmails, ['user@a1b2c3d4.example.com']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://temp.example.com/admin/new_address');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, {
    enablePrefix: true,
    enableRandomSubdomain: true,
    name: 'user',
    domain: 'mail.example.com',
  });
});
