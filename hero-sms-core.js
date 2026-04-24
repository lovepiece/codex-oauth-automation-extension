(function attachHeroSmsCore(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }

  root.HeroSmsCore = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createHeroSmsCoreModule() {
  const DEFAULT_HERO_SMS_BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';
  const HERO_SMS_NUMBER_MAX_USES = 5;
  const HERO_SMS_ACTIVATION_TTL_MS = 20 * 60 * 1000;
  const HERO_SMS_STANDBY_RETRY_DELAY_MS = 5 * 60 * 1000;
  const HERO_SMS_SMS_POLL_INTERVAL_MS = 5000;
  const HERO_SMS_SMS_TIMEOUT_MS = 180000;
  const HERO_SMS_RESEND_AFTER_MS = 60000;
  const HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT = 3;
  const HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS = 2 * 60 * 1000;
  const HERO_SMS_SERVICE_ALIASES = {
    openai: 'dr',
    chatgpt: 'dr',
    claude: 'acz',
  };

  function cloneValue(value) {
    if (value === undefined) {
      return undefined;
    }
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function firstNonEmptyString(values) {
    for (const value of values) {
      if (value === undefined || value === null) continue;
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
    return '';
  }

  function normalizeHeroSmsBaseUrl(rawValue = '') {
    const value = String(rawValue || '').trim();
    if (!value) return DEFAULT_HERO_SMS_BASE_URL;

    const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value) ? value : `https://${value}`;
    try {
      const parsed = new URL(candidate);
      parsed.hash = '';
      parsed.search = '';
      const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
      return `${parsed.origin}${pathname}`;
    } catch {
      return DEFAULT_HERO_SMS_BASE_URL;
    }
  }

  function normalizeHeroSmsService(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    return HERO_SMS_SERVICE_ALIASES[normalized] || normalized;
  }

  function normalizeHeroSmsCountry(value = '') {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) return '';
    if (!/^\d+$/.test(rawValue)) return '';
    return String(Math.max(0, Number(rawValue)));
  }

  function normalizeHeroSmsCountryCatalogEntry(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const id = normalizeHeroSmsCountry(value.id);
    if (!id) {
      return null;
    }

    const eng = String(value.eng || '').trim();
    const chn = String(value.chn || '').trim();
    const rus = String(value.rus || '').trim();
    const names = [];
    const seen = new Set();
    for (const item of [chn, eng, rus]) {
      const normalized = String(item || '').replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(normalized);
    }

    return {
      id,
      eng,
      chn,
      rus,
      names,
    };
  }

  function normalizeHeroSmsActivation(value = null, now = Date.now()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const activationId = Number(value.activationId ?? value.activation_id ?? value.id);
    const phoneNumber = String(value.phoneNumber ?? value.number ?? value.phone ?? '').trim();
    if (!Number.isInteger(activationId) || activationId <= 0 || !phoneNumber) {
      return null;
    }

    const acquiredAt = Number(value.acquiredAt) || now;
    const expiresAt = Number(value.expiresAt) || (acquiredAt + HERO_SMS_ACTIVATION_TTL_MS);
    return {
      activationId,
      phoneNumber,
      service: normalizeHeroSmsService(value.service),
      country: normalizeHeroSmsCountry(value.country),
      acquiredAt,
      expiresAt,
      useCount: Math.max(0, Math.floor(Number(value.useCount) || 0)),
      lastCode: String(value.lastCode || '').trim(),
      lastStatus: String(value.lastStatus || '').trim(),
      lastStatusAt: Number(value.lastStatusAt) || 0,
      resendCount: Math.max(0, Math.floor(Number(value.resendCount) || 0)),
      releasedAt: Number(value.releasedAt) || 0,
      releaseReason: String(value.releaseReason || '').trim(),
    };
  }

  function normalizeHeroSmsFailedActivation(value = null, now = Date.now()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const activationId = Number(value.activationId ?? value.activation_id ?? value.id);
    const phoneNumber = String(value.phoneNumber ?? value.number ?? value.phone ?? '').trim();
    if (!Number.isInteger(activationId) || activationId <= 0 || !phoneNumber) {
      return null;
    }

    const failedAt = Number(value.failedAt) || now;
    const cleanupAt = Number(value.cleanupAt) || (failedAt + HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS);

    return {
      activationId,
      phoneNumber,
      service: normalizeHeroSmsService(value.service),
      country: normalizeHeroSmsCountry(value.country),
      baseUrl: normalizeHeroSmsBaseUrl(value.baseUrl),
      apiKey: String(value.apiKey || '').trim(),
      acquiredAt: Number(value.acquiredAt) || 0,
      expiresAt: Number(value.expiresAt) || 0,
      useCount: Math.max(0, Math.floor(Number(value.useCount) || 0)),
      resendCount: Math.max(0, Math.floor(Number(value.resendCount) || 0)),
      failedAt,
      cleanupAt,
      reason: String(value.reason || '').trim(),
      errorText: String(value.errorText || '').trim(),
      status: String(value.status || 'scheduled').trim() || 'scheduled',
      cleanupResponse: String(value.cleanupResponse || '').trim(),
      cleanupError: String(value.cleanupError || '').trim(),
      cleanupAttemptedAt: Number(value.cleanupAttemptedAt) || 0,
      cleanupCompletedAt: Number(value.cleanupCompletedAt) || 0,
    };
  }

  function normalizeHeroSmsStandbyActivation(value = null, now = Date.now()) {
    const normalizedActivation = normalizeHeroSmsActivation(value, now);
    if (!normalizedActivation) {
      return null;
    }

    const standbyAt = Number(value.standbyAt) || now;
    const retryAt = Number(value.retryAt) || (standbyAt + HERO_SMS_STANDBY_RETRY_DELAY_MS);

    return {
      ...normalizedActivation,
      standbyAt,
      retryAt,
      reason: String(value.reason || '').trim(),
      errorText: String(value.errorText || '').trim(),
      status: String(value.status || 'waiting_retry').trim() || 'waiting_retry',
      retryCount: Math.max(0, Math.floor(Number(value.retryCount) || 0)),
      lastSelectedAt: Number(value.lastSelectedAt) || 0,
    };
  }

  function normalizeHeroSmsActiveActivation(value = null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const activationId = Number(
      value.activationId
      ?? value.activation_id
      ?? value.id
      ?? value.orderId
      ?? value.order_id
    );
    if (!Number.isInteger(activationId) || activationId <= 0) {
      return null;
    }

    const phoneNumber = String(
      value.phoneNumber
      ?? value.phone_number
      ?? value.number
      ?? value.phone
      ?? value.msisdn
      ?? ''
    ).trim();
    const acquiredAt = Number(
      value.acquiredAt
      ?? value.createdAt
      ?? value.created_at
      ?? value.activationTime
      ?? value.createDate
      ?? value.issuedAt
      ?? value.issued_at
      ?? 0
    ) || Date.parse(
      value.acquiredAt
      ?? value.createdAt
      ?? value.created_at
      ?? value.activationTime
      ?? value.createDate
      ?? value.issuedAt
      ?? value.issued_at
      ?? ''
    ) || 0;
    const expiresAt = Number(
      value.expiresAt
      ?? value.expiredAt
      ?? value.expires_at
      ?? value.expired_at
      ?? value.estDate
      ?? value.finishDate
      ?? 0
    ) || Date.parse(
      value.expiresAt
      ?? value.expiredAt
      ?? value.expires_at
      ?? value.expired_at
      ?? value.estDate
      ?? value.finishDate
      ?? ''
    ) || 0;

    return {
      activationId,
      phoneNumber,
      service: normalizeHeroSmsService(value.service ?? value.serviceCode ?? value.service_code ?? ''),
      country: normalizeHeroSmsCountry(value.country ?? value.countryCode ?? value.country_code ?? value.countryId ?? value.country_id ?? ''),
      status: String(value.status ?? value.state ?? value.activationStatus ?? '').trim(),
      acquiredAt,
      expiresAt,
      smsCode: String(value.smsCode ?? value.code ?? '').trim(),
      smsText: String(value.smsText ?? value.text ?? '').trim(),
      cost: String(value.activationCost ?? value.cost ?? '').trim(),
      raw: value,
    };
  }

  function normalizeHeroSmsStandbyActivationList(value, now = Date.now()) {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => normalizeHeroSmsStandbyActivation(item, now))
      .filter(Boolean)
      .sort((left, right) => (right.standbyAt || 0) - (left.standbyAt || 0));
  }

  function normalizeHeroSmsFailedActivationList(value, now = Date.now()) {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((item) => normalizeHeroSmsFailedActivation(item, now))
      .filter(Boolean)
      .sort((left, right) => (right.failedAt || 0) - (left.failedAt || 0));

    return normalized.slice(0, 30);
  }

  function normalizeHeroSmsActiveActivationList(value) {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((item) => normalizeHeroSmsActiveActivation(item))
      .filter(Boolean)
      .reduce((map, item) => {
        const existing = map.get(item.activationId);
        if (!existing) {
          map.set(item.activationId, item);
          return map;
        }

        map.set(item.activationId, {
          ...existing,
          ...item,
          phoneNumber: item.phoneNumber || existing.phoneNumber,
          service: item.service || existing.service,
          country: item.country || existing.country,
          status: item.status || existing.status,
          acquiredAt: item.acquiredAt || existing.acquiredAt,
          expiresAt: item.expiresAt || existing.expiresAt,
          smsCode: item.smsCode || existing.smsCode,
          smsText: item.smsText || existing.smsText,
          cost: item.cost || existing.cost,
          raw: item.raw || existing.raw,
        });
        return map;
      }, new Map());

    return Array.from(normalized.values()).sort((left, right) => {
      const leftTime = left.acquiredAt || left.activationId || 0;
      const rightTime = right.acquiredAt || right.activationId || 0;
      return rightTime - leftTime;
    });
  }

  function normalizeHeroSmsState(value = {}, now = Date.now()) {
    const state = value && typeof value === 'object' ? value : {};
    return {
      heroSmsBaseUrl: normalizeHeroSmsBaseUrl(state.heroSmsBaseUrl),
      heroSmsApiKey: String(state.heroSmsApiKey || '').trim(),
      heroSmsService: normalizeHeroSmsService(state.heroSmsService),
      heroSmsCountry: normalizeHeroSmsCountry(state.heroSmsCountry),
      currentHeroSmsActivation: normalizeHeroSmsActivation(state.currentHeroSmsActivation, now),
      heroSmsLastCode: String(state.heroSmsLastCode || '').trim(),
      heroSmsRuntimeStatus: String(state.heroSmsRuntimeStatus || '').trim(),
      heroSmsActiveActivations: normalizeHeroSmsActiveActivationList(state.heroSmsActiveActivations),
      heroSmsActiveActivationsFetchedAt: Number(state.heroSmsActiveActivationsFetchedAt) || 0,
      heroSmsFailedActivations: normalizeHeroSmsFailedActivationList(state.heroSmsFailedActivations, now),
      heroSmsStandbyActivations: normalizeHeroSmsStandbyActivationList(state.heroSmsStandbyActivations, now),
    };
  }

  function extractHeroSmsErrorText(payload) {
    if (typeof payload === 'string') {
      return payload.trim();
    }
    if (!payload || typeof payload !== 'object') {
      return '';
    }

    return String(
      payload.error
      || payload.message
      || payload.msg
      || payload.description
      || payload.detail
      || payload.status_text
      || ''
    ).trim();
  }

  function parseHeroSmsNumberResponse(text = '') {
    const parts = String(text || '').split(':');
    if (parts.length >= 3 && parts[0] === 'ACCESS_NUMBER') {
      return {
        activationId: Number(parts[1]),
        phoneNumber: parts.slice(2).join(':').trim(),
      };
    }
    if (/UNPROCESSABLE_ENTITY:service:INVALID/i.test(text)) {
      throw new Error(`HeroSMS service is invalid: ${text}`);
    }
    if (/UNPROCESSABLE_ENTITY:country:INVALID/i.test(text)) {
      throw new Error(`HeroSMS country is invalid: ${text}`);
    }
    throw new Error(`HeroSMS getNumber returned an unexpected payload: ${text}`);
  }

  function parseHeroSmsNumberV2Response(payload) {
    if (typeof payload === 'string') {
      return parseHeroSmsNumberResponse(payload);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`HeroSMS getNumberV2 returned an unexpected payload: ${JSON.stringify(payload)}`);
    }

    const status = String(payload.status || payload.result || '').trim().toLowerCase();
    if (status && status !== 'success' && status !== 'ok') {
      const errorText = extractHeroSmsErrorText(payload) || JSON.stringify(payload);
      throw new Error(`HeroSMS getNumberV2 returned an error: ${errorText}`);
    }

    const container = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const activationId = Number(
      container.activationId
      ?? container.activation_id
      ?? container.id
      ?? container.orderId
      ?? payload.activationId
      ?? payload.activation_id
      ?? payload.id
    );
    const phoneNumber = String(
      container.phoneNumber
      ?? container.phone_number
      ?? container.number
      ?? container.phone
      ?? container.msisdn
      ?? payload.phoneNumber
      ?? payload.phone_number
      ?? payload.number
      ?? payload.phone
      ?? ''
    ).trim();

    if (!Number.isInteger(activationId) || activationId <= 0 || !phoneNumber) {
      throw new Error(`HeroSMS getNumberV2 did not include activationId or phoneNumber: ${JSON.stringify(payload)}`);
    }

    return {
      activationId,
      phoneNumber,
    };
  }

  function parseHeroSmsStatusResponse(text = '') {
    const [status, code = ''] = String(text || '').split(':', 2);
    return {
      status: String(status || '').trim(),
      code: String(code || '').trim(),
      raw: String(text || '').trim(),
    };
  }

  function parseHeroSmsActiveActivationsResponse(payload) {
    if (typeof payload === 'string') {
      throw new Error(`HeroSMS getActiveActivations returned an unexpected payload: ${payload}`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`HeroSMS getActiveActivations returned an unexpected payload: ${JSON.stringify(payload)}`);
    }

    const status = String(payload.status || payload.result || '').trim().toLowerCase();
    if (status && status !== 'success' && status !== 'ok') {
      const errorText = extractHeroSmsErrorText(payload) || JSON.stringify(payload);
      throw new Error(`HeroSMS getActiveActivations returned an error: ${errorText}`);
    }

    const activeContainer = payload.activeActivations && typeof payload.activeActivations === 'object'
      ? payload.activeActivations
      : {};
    const rowPayload = [];
    if (Array.isArray(activeContainer.rows)) {
      rowPayload.push(...activeContainer.rows);
    }
    if (Array.isArray(activeContainer.row)) {
      rowPayload.push(...activeContainer.row);
    } else if (activeContainer.row && typeof activeContainer.row === 'object') {
      rowPayload.push(activeContainer.row);
    }
    const combined = [
      ...(Array.isArray(payload.data) ? payload.data : []),
      ...rowPayload,
    ];

    return normalizeHeroSmsActiveActivationList(combined);
  }

  function isHeroSmsDeliveredStatus(status = '') {
    const normalized = String(status || '').trim().toUpperCase();
    return normalized === 'STATUS_OK'
      || normalized === 'STATUS_WAIT_RETRY'
      || normalized === 'STATUS_WAIT_RESEND';
  }

  function isHeroSmsActivationCanceledStatus(status = '') {
    return String(status || '').trim().toUpperCase() === 'STATUS_CANCEL';
  }

  function extractHeroSmsDeliveredCode(status) {
    const parsed = status && typeof status === 'object'
      ? status
      : parseHeroSmsStatusResponse(status);
    if (!isHeroSmsDeliveredStatus(parsed?.status)) {
      return '';
    }

    const codeText = String(parsed?.code || '').trim();
    if (!codeText) {
      return '';
    }

    const match = codeText.match(/\d{4,8}/);
    return match ? match[0] : '';
  }

  function validateHeroSmsSetStatusResponse(statusCode, responseText = '') {
    const normalizedStatusCode = Number(statusCode);
    const response = String(responseText || '').trim();
    const successPattern = normalizedStatusCode === 1
      ? /^ACCESS_READY\b/i
      : normalizedStatusCode === 3
        ? /^ACCESS_RETRY_GET\b/i
        : normalizedStatusCode === 6
          ? /^ACCESS_ACTIVATION\b/i
          : normalizedStatusCode === 8
            ? /^ACCESS_CANCEL\b/i
            : null;

    if (successPattern && successPattern.test(response)) {
      return response;
    }

    let payload = null;
    try {
      payload = JSON.parse(response);
    } catch {
      payload = null;
    }

    const errorText = extractHeroSmsErrorText(payload || response) || response || `status=${normalizedStatusCode}`;
    throw new Error(`HeroSMS setStatus(${normalizedStatusCode}) returned an error: ${errorText}`);
  }

  function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function ensureNotAborted(signal) {
    if (!signal) {
      return;
    }
    if (signal.aborted) {
      const reason = signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason || 'The operation was aborted.'));
      throw reason;
    }
  }

  class HeroSmsRuntime {
    constructor(options = {}) {
      this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      this.sleepImpl = options.sleepImpl || defaultSleep;
      this.nowImpl = typeof options.now === 'function' ? options.now : Date.now;
      this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
      this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null;
      this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : null;
      this.countryCatalogUrl = String(options.countryCatalogUrl || 'data/SMS-Country.json');
      this.countryCatalog = Array.isArray(options.countryCatalog)
        ? options.countryCatalog.map((item) => normalizeHeroSmsCountryCatalogEntry(item)).filter(Boolean)
        : null;
      this.countryCatalogPromise = null;
      this.state = normalizeHeroSmsState(options.initialState || {}, this.now());
    }

    now() {
      return Number(this.nowImpl()) || Date.now();
    }

    getState() {
      return cloneValue(this.state);
    }

    setState(patch = {}) {
      this.state = normalizeHeroSmsState({
        ...this.state,
        ...(patch || {}),
      }, this.now());
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return this.getState();
    }

    emitLog(message, level = 'info', meta = null) {
      if (this.onLog) {
        this.onLog({
          level,
          message: String(message || '').trim(),
          meta: meta ? cloneValue(meta) : null,
        });
      }
    }

    setRuntimeStatus(status = '') {
      const normalizedStatus = String(status || '').trim();
      this.state.heroSmsRuntimeStatus = normalizedStatus;
      if (this.onStatusChange) {
        this.onStatusChange(normalizedStatus, this.getState());
      }
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return normalizedStatus;
    }

    setConfig(config = {}) {
      return this.setState({
        heroSmsBaseUrl: config.baseUrl ?? this.state.heroSmsBaseUrl,
        heroSmsApiKey: config.apiKey ?? this.state.heroSmsApiKey,
        heroSmsService: config.service ?? this.state.heroSmsService,
        heroSmsCountry: config.country ?? this.state.heroSmsCountry,
      });
    }

    getConfig(state = this.state) {
      return {
        baseUrl: normalizeHeroSmsBaseUrl(state.heroSmsBaseUrl),
        apiKey: String(state.heroSmsApiKey || '').trim(),
        service: normalizeHeroSmsService(state.heroSmsService),
        country: normalizeHeroSmsCountry(state.heroSmsCountry),
      };
    }

    getCurrentActivation(state = this.state) {
      return normalizeHeroSmsActivation(state.currentHeroSmsActivation, this.now());
    }

    setCurrentActivation(activation) {
      const normalizedActivation = normalizeHeroSmsActivation(activation, this.now());
      this.state.currentHeroSmsActivation = normalizedActivation;
      if (!normalizedActivation) {
        this.state.heroSmsLastCode = '';
      }
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return normalizedActivation ? cloneValue(normalizedActivation) : null;
    }

    mergeCurrentActivation(patch = {}) {
      const currentActivation = this.getCurrentActivation();
      if (!currentActivation) {
        return null;
      }

      return this.setCurrentActivation({
        ...currentActivation,
        ...(patch || {}),
      });
    }

    setLastCode(code = '') {
      const normalizedCode = String(code || '').trim();
      this.state.heroSmsLastCode = normalizedCode;
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return normalizedCode;
    }

    getActivationRemainingMs(activation, now = this.now()) {
      const normalized = normalizeHeroSmsActivation(activation, now);
      if (!normalized) {
        return 0;
      }
      return Math.max(0, normalized.expiresAt - now);
    }

    getFailedActivations(state = this.state) {
      return normalizeHeroSmsFailedActivationList(state.heroSmsFailedActivations, this.now());
    }

    setFailedActivations(list = []) {
      this.state.heroSmsFailedActivations = normalizeHeroSmsFailedActivationList(list, this.now());
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return cloneValue(this.state.heroSmsFailedActivations);
    }

    upsertFailedActivation(entry) {
      const normalizedEntry = normalizeHeroSmsFailedActivation(entry, this.now());
      if (!normalizedEntry) {
        return this.getFailedActivations();
      }

      const currentList = this.getFailedActivations();
      const existingIndex = currentList.findIndex((item) => item.activationId === normalizedEntry.activationId);
      if (existingIndex >= 0) {
        currentList[existingIndex] = {
          ...currentList[existingIndex],
          ...normalizedEntry,
        };
      } else {
        currentList.unshift(normalizedEntry);
      }
      return this.setFailedActivations(currentList);
    }

    getStandbyActivations(state = this.state) {
      return normalizeHeroSmsStandbyActivationList(state.heroSmsStandbyActivations, this.now());
    }

    setStandbyActivations(list = []) {
      this.state.heroSmsStandbyActivations = normalizeHeroSmsStandbyActivationList(list, this.now());
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return cloneValue(this.state.heroSmsStandbyActivations);
    }

    upsertStandbyActivation(entry) {
      const normalizedEntry = normalizeHeroSmsStandbyActivation(entry, this.now());
      if (!normalizedEntry) {
        return this.getStandbyActivations();
      }

      const currentList = this.getStandbyActivations();
      const existingIndex = currentList.findIndex((item) => item.activationId === normalizedEntry.activationId);
      if (existingIndex >= 0) {
        currentList[existingIndex] = {
          ...currentList[existingIndex],
          ...normalizedEntry,
        };
      } else {
        currentList.unshift(normalizedEntry);
      }
      return this.setStandbyActivations(currentList);
    }

    removeStandbyActivation(activationId) {
      const normalizedId = Number(activationId);
      if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
        return this.getStandbyActivations();
      }

      const nextList = this.getStandbyActivations().filter((item) => item.activationId !== normalizedId);
      return this.setStandbyActivations(nextList);
    }

    getActiveActivations(state = this.state) {
      return normalizeHeroSmsActiveActivationList(state.heroSmsActiveActivations);
    }

    setActiveActivations(list = [], fetchedAt = this.now()) {
      this.state.heroSmsActiveActivations = normalizeHeroSmsActiveActivationList(list);
      this.state.heroSmsActiveActivationsFetchedAt = Number(fetchedAt) || this.now();
      if (this.onStateChange) {
        this.onStateChange(this.getState());
      }
      return cloneValue(this.state.heroSmsActiveActivations);
    }

    ensureConfig(config = this.getConfig()) {
      if (!config.baseUrl) {
        throw new Error('HeroSMS baseUrl is required.');
      }
      if (!config.apiKey) {
        throw new Error('HeroSMS apiKey is required.');
      }
      if (!config.service) {
        throw new Error('HeroSMS service is required.');
      }
      if (!config.country) {
        throw new Error('HeroSMS country is required.');
      }
      return config;
    }

    ensureApiConfig(config = this.getConfig()) {
      if (!config.baseUrl) {
        throw new Error('HeroSMS baseUrl is required.');
      }
      if (!config.apiKey) {
        throw new Error('HeroSMS apiKey is required.');
      }
      return config;
    }

    async loadCountryCatalog(options = {}) {
      if (Array.isArray(options.countryCatalog)) {
        return options.countryCatalog
          .map((item) => normalizeHeroSmsCountryCatalogEntry(item))
          .filter(Boolean);
      }
      if (Array.isArray(this.countryCatalog)) {
        return cloneValue(this.countryCatalog);
      }
      if (!this.countryCatalogPromise) {
        this.countryCatalogPromise = (async () => {
          const fetchImpl = options.fetchImpl || this.fetchImpl;
          if (typeof fetchImpl !== 'function') {
            throw new Error('A fetch implementation is required to load the HeroSMS country catalog.');
          }
          const response = await fetchImpl(String(options.url || this.countryCatalogUrl));
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const payload = await response.json();
          if (!Array.isArray(payload)) {
            throw new Error('HeroSMS country catalog payload is invalid.');
          }
          this.countryCatalog = payload
            .map((item) => normalizeHeroSmsCountryCatalogEntry(item))
            .filter(Boolean);
          return this.countryCatalog;
        })().catch((error) => {
          this.countryCatalogPromise = null;
          throw error;
        });
      }

      const catalog = await this.countryCatalogPromise;
      return cloneValue(catalog);
    }

    async getCountrySelection(countryValue = '', options = {}) {
      const countryId = normalizeHeroSmsCountry(countryValue);
      if (!countryId) {
        return null;
      }

      const catalog = await this.loadCountryCatalog(options);
      const match = catalog.find((entry) => entry.id === countryId);
      if (!match) {
        return null;
      }

      return {
        id: match.id,
        name: match.chn || match.eng || match.rus || '',
        eng: match.eng,
        chn: match.chn,
        rus: match.rus,
        names: Array.isArray(match.names) ? [...match.names] : [],
      };
    }

    async requestText(action, params = {}, config = this.getConfig()) {
      const normalizedConfig = this.ensureApiConfig(config);
      if (typeof this.fetchImpl !== 'function') {
        throw new Error('A fetch implementation is required to call HeroSMS APIs.');
      }

      const url = new URL(normalizedConfig.baseUrl);
      url.searchParams.set('action', action);
      url.searchParams.set('api_key', normalizedConfig.apiKey);
      for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }

      let response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'text/plain, application/json;q=0.9, */*;q=0.8',
          },
        });
      } catch (error) {
        throw new Error(`HeroSMS request failed: ${error.message}`);
      }

      const text = (await response.text()).trim();
      if (!response.ok) {
        throw new Error(`HeroSMS request failed: ${text || `HTTP ${response.status}`}`);
      }
      if (!text) {
        throw new Error(`HeroSMS ${action} returned an empty response.`);
      }
      return text;
    }

    async requestPayload(action, params = {}, config = this.getConfig()) {
      const text = await this.requestText(action, params, config);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    async heroSmsGetNumber(options = {}, config = this.getConfig()) {
      const normalizedConfig = this.ensureConfig(config);
      const payload = await this.requestPayload('getNumberV2', {
        service: normalizedConfig.service,
        country: normalizedConfig.country,
        operator: options.operator,
        maxPrice: options.maxPrice,
        fixedPrice: options.fixedPrice,
        ref: options.ref,
        phoneException: options.phoneException,
      }, normalizedConfig);
      return parseHeroSmsNumberV2Response(payload);
    }

    async heroSmsGetActiveActivations(config = this.getConfig()) {
      const normalizedConfig = this.ensureApiConfig(config);
      const payload = await this.requestPayload('getActiveActivations', {}, normalizedConfig);
      return parseHeroSmsActiveActivationsResponse(payload);
    }

    async heroSmsGetStatus(activationId, config = this.getConfig()) {
      const text = await this.requestText('getStatus', { id: activationId }, config);
      return parseHeroSmsStatusResponse(text);
    }

    async heroSmsSetStatus(activationId, status, config = this.getConfig()) {
      return this.requestText('setStatus', { id: activationId, status }, config);
    }

    async heroSmsFinishActivation(activationId, config = this.getConfig()) {
      return this.requestText('finishActivation', { id: activationId }, config);
    }

    async heroSmsCancelActivation(activationId, config = this.getConfig()) {
      return this.requestText('cancelActivation', { id: activationId }, config);
    }

    async heroSmsSetActivationReady(activationId, config = this.getConfig()) {
      const response = await this.heroSmsSetStatus(activationId, 1, config);
      return validateHeroSmsSetStatusResponse(1, response);
    }

    async heroSmsRequestNextSms(activationId, config = this.getConfig()) {
      const response = await this.heroSmsSetStatus(activationId, 3, config);
      return validateHeroSmsSetStatusResponse(3, response);
    }

    async heroSmsReleaseActivation(activationId, mode = 'cancel', config = this.getConfig()) {
      const normalizedMode = String(mode || '').trim().toLowerCase() === 'complete' ? 'complete' : 'cancel';
      const statusCode = normalizedMode === 'complete' ? 6 : 8;

      try {
        const response = await this.heroSmsSetStatus(activationId, statusCode, config);
        return validateHeroSmsSetStatusResponse(statusCode, response);
      } catch (error) {
        if (normalizedMode === 'complete') {
          return this.heroSmsFinishActivation(activationId, config);
        }

        try {
          return await this.heroSmsCancelActivation(activationId, config);
        } catch {
          throw error;
        }
      }
    }

    async attemptActivationRelease(activation, options = {}) {
      const normalizedActivation = normalizeHeroSmsActivation(activation, this.now());
      if (!normalizedActivation) {
        return {
          ok: false,
          released: false,
          mode: 'cancel',
          releaseResponse: '',
          error: new Error('A valid HeroSMS activation is required.'),
        };
      }

      const config = this.getConfig(options.state || this.state);
      const releaseMode = options.preferComplete || normalizedActivation.useCount >= HERO_SMS_NUMBER_MAX_USES
        ? 'complete'
        : 'cancel';

      try {
        const releaseResponse = await this.heroSmsReleaseActivation(
          normalizedActivation.activationId,
          releaseMode,
          config
        );
        return {
          ok: true,
          released: true,
          mode: releaseMode,
          releaseResponse,
          activation: normalizedActivation,
          error: null,
        };
      } catch (error) {
        return {
          ok: false,
          released: false,
          mode: releaseMode,
          releaseResponse: '',
          activation: normalizedActivation,
          error,
        };
      }
    }

    isActivationReusable(activation, state = this.state) {
      const normalizedActivation = normalizeHeroSmsActivation(activation, this.now());
      if (!normalizedActivation) {
        return false;
      }
      const config = this.getConfig(state);
      return normalizedActivation.service === config.service
        && normalizedActivation.country === config.country
        && normalizedActivation.useCount < HERO_SMS_NUMBER_MAX_USES
        && this.getActivationRemainingMs(normalizedActivation) > 0
        && !isHeroSmsActivationCanceledStatus(normalizedActivation.lastStatus)
        && !normalizedActivation.releasedAt;
    }

    isStandbyActivationReusable(activation, state = this.state, now = this.now()) {
      const normalizedActivation = normalizeHeroSmsStandbyActivation(activation, now);
      if (!normalizedActivation) {
        return false;
      }
      const config = this.getConfig(state);
      return normalizedActivation.service === config.service
        && normalizedActivation.country === config.country
        && normalizedActivation.useCount < HERO_SMS_NUMBER_MAX_USES
        && this.getActivationRemainingMs(normalizedActivation, now) > 0
        && normalizedActivation.retryAt <= now
        && !isHeroSmsActivationCanceledStatus(normalizedActivation.lastStatus)
        && !normalizedActivation.releasedAt;
    }

    async cleanupExpiredStandbyActivations(state = this.state) {
      const currentState = normalizeHeroSmsState(state, this.now());
      const now = this.now();
      const standbyList = this.getStandbyActivations(currentState);
      const nextList = [];
      let changed = false;

      for (const item of standbyList) {
        const shouldRelease = this.getActivationRemainingMs(item, now) <= 0 || item.useCount >= HERO_SMS_NUMBER_MAX_USES;
        if (!shouldRelease) {
          nextList.push(item);
          continue;
        }

        changed = true;
        const releaseResult = await this.attemptActivationRelease(item, {
          state: currentState,
          preferComplete: item.useCount >= HERO_SMS_NUMBER_MAX_USES,
        });
        if (releaseResult.released) {
          this.emitLog(
            `Released standby activation ${item.phoneNumber} because it expired or reached max uses.`,
            'warn',
            { activationId: item.activationId }
          );
          continue;
        }

        nextList.push(normalizeHeroSmsStandbyActivation({
          ...item,
          status: 'release_failed',
          errorText: String(releaseResult.error?.message || item.errorText || '').trim(),
        }, now));
      }

      if (!changed) {
        return standbyList;
      }
      return this.setStandbyActivations(nextList);
    }

    async takeReusableStandbyActivation(state = this.state) {
      const currentState = normalizeHeroSmsState(state, this.now());
      const standbyList = await this.cleanupExpiredStandbyActivations(currentState);
      const now = this.now();
      const candidate = standbyList
        .filter((item) => this.isStandbyActivationReusable(item, currentState, now))
        .sort((left, right) => (left.retryAt || 0) - (right.retryAt || 0))[0];
      if (!candidate) {
        return null;
      }

      this.removeStandbyActivation(candidate.activationId);
      const activation = this.setCurrentActivation({
        ...candidate,
        lastSelectedAt: now,
      });
      this.setRuntimeStatus(`Restored standby number ${activation.phoneNumber}`);
      this.emitLog(`Restored standby activation ${activation.phoneNumber}.`, 'warn', {
        activationId: activation.activationId,
      });
      return activation;
    }

    async syncActiveActivations(state = this.state, options = {}) {
      const config = this.ensureApiConfig(this.getConfig(state));
      const activeList = await this.heroSmsGetActiveActivations(config);
      return this.setActiveActivations(activeList, options.fetchedAt || this.now());
    }

    pickReusableRemoteActiveActivation(activeList = [], state = this.state, options = {}) {
      const config = this.getConfig(state);
      const failedIds = new Set(this.getFailedActivations(state).map((item) => item.activationId));
      const standbyIds = new Set(this.getStandbyActivations(state).map((item) => item.activationId));
      const explicitExcludedIds = new Set(
        (Array.isArray(options.excludeActivationIds) ? options.excludeActivationIds : [])
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item) && item > 0)
      );

      const candidates = normalizeHeroSmsActiveActivationList(activeList).filter((item) => {
        if (!item.phoneNumber) return false;
        if (failedIds.has(item.activationId) || standbyIds.has(item.activationId) || explicitExcludedIds.has(item.activationId)) {
          return false;
        }
        if (item.service && item.service !== config.service) {
          return false;
        }
        if (item.country && item.country !== config.country) {
          return false;
        }
        return !isHeroSmsActivationCanceledStatus(item.status);
      });

      if (!candidates.length) {
        return null;
      }

      const strictMatches = candidates.filter((item) => item.service === config.service && item.country === config.country);
      if (strictMatches.length > 0) {
        return strictMatches.sort((left, right) => {
          const leftScore = left.acquiredAt || left.activationId || 0;
          const rightScore = right.acquiredAt || right.activationId || 0;
          return rightScore - leftScore;
        })[0];
      }

      return candidates.length === 1 ? candidates[0] : null;
    }

    async takeReusableRemoteActiveActivation(state = this.state, options = {}) {
      const currentState = normalizeHeroSmsState(state, this.now());
      const config = this.getConfig(currentState);
      const fetchedAt = options.fetchedAt || this.now();
      const activeList = Array.isArray(options.activeList)
        ? this.setActiveActivations(options.activeList, fetchedAt)
        : await this.syncActiveActivations(currentState, { fetchedAt });
      const candidate = this.pickReusableRemoteActiveActivation(activeList, currentState, options);
      if (!candidate) {
        return null;
      }

      const activation = this.setCurrentActivation({
        activationId: candidate.activationId,
        phoneNumber: candidate.phoneNumber,
        service: candidate.service || config.service,
        country: candidate.country || config.country,
        acquiredAt: candidate.acquiredAt || this.now(),
        expiresAt: candidate.expiresAt || ((candidate.acquiredAt || this.now()) + HERO_SMS_ACTIVATION_TTL_MS),
        lastStatus: candidate.status,
      });
      this.setRuntimeStatus(`Restored remote active number ${activation.phoneNumber}`);
      this.emitLog(`Restored active activation ${activation.phoneNumber}.`, 'warn', {
        activationId: activation.activationId,
      });
      return activation;
    }

    async finalizeActivation(stateOrActivation = this.state, options = {}) {
      const {
        preferComplete = false,
        releaseReason = '',
        silent = false,
      } = options;
      const state = stateOrActivation && stateOrActivation.currentHeroSmsActivation !== undefined
        ? stateOrActivation
        : this.state;
      const activation = stateOrActivation && stateOrActivation.activationId
        ? normalizeHeroSmsActivation(stateOrActivation, this.now())
        : this.getCurrentActivation(state);

      if (!activation) {
        return { ok: true, released: false };
      }

      const releaseResult = await this.attemptActivationRelease(activation, {
        state,
        preferComplete,
      });
      if (!releaseResult.released) {
        if (!silent) {
          this.emitLog(`Failed to release activation ${activation.phoneNumber}: ${releaseResult.error?.message || 'unknown error'}.`, 'warn');
        }
        return {
          ok: false,
          released: false,
          mode: releaseResult.mode,
          releaseResponse: '',
          error: releaseResult.error?.message || 'release_failed',
        };
      }

      const currentActivation = this.getCurrentActivation();
      if (currentActivation && currentActivation.activationId === activation.activationId) {
        this.setCurrentActivation(null);
        this.setLastCode('');
      }
      this.setRuntimeStatus(
        activation.phoneNumber
          ? `Released ${activation.phoneNumber} as ${releaseResult.mode}`
          : `Released HeroSMS activation as ${releaseResult.mode}`
      );
      if (!silent) {
        this.emitLog(`Released activation ${activation.phoneNumber}.`, 'ok', {
          activationId: activation.activationId,
          mode: releaseResult.mode,
          releaseReason,
          releaseResponse: releaseResult.releaseResponse,
        });
      }

      try {
        await this.syncActiveActivations({
          ...state,
          currentHeroSmsActivation: null,
        }, { fetchedAt: this.now() });
      } catch {
        // Swallow sync errors for standalone runtime users.
      }

      return {
        ok: true,
        released: true,
        mode: releaseResult.mode,
        releaseResponse: releaseResult.releaseResponse,
        error: '',
      };
    }

    async ensureActivationForFlow(state = this.state, options = {}) {
      const currentState = normalizeHeroSmsState(state, this.now());
      const config = this.ensureConfig(this.getConfig(currentState));
      const currentActivation = this.getCurrentActivation(currentState);

      if (currentActivation && this.isActivationReusable(currentActivation, currentState)) {
        return currentActivation;
      }

      if (currentActivation) {
        await this.finalizeActivation(currentState, {
          preferComplete: currentActivation.useCount >= HERO_SMS_NUMBER_MAX_USES,
          releaseReason: currentActivation.useCount >= HERO_SMS_NUMBER_MAX_USES ? 'max_uses_reached' : 'expired_or_replaced',
        });
      }

      const standbyActivation = await this.takeReusableStandbyActivation(currentState);
      if (standbyActivation) {
        return standbyActivation;
      }

      try {
        const remoteActivation = await this.takeReusableRemoteActiveActivation(currentState, {
          excludeActivationIds: currentActivation ? [currentActivation.activationId] : [],
        });
        if (remoteActivation) {
          return remoteActivation;
        }
      } catch (error) {
        this.emitLog(`Failed to read HeroSMS active activations before acquiring a new number: ${error.message}`, 'warn');
      }

      const acquired = await this.heroSmsGetNumber(options, config);
      const now = this.now();
      const activation = this.setCurrentActivation({
        activationId: acquired.activationId,
        phoneNumber: acquired.phoneNumber,
        service: config.service,
        country: config.country,
        acquiredAt: now,
        expiresAt: now + HERO_SMS_ACTIVATION_TTL_MS,
        useCount: 0,
        resendCount: 0,
      });
      this.setLastCode('');
      this.setRuntimeStatus(`Acquired number ${activation.phoneNumber}`);
      this.emitLog(`Acquired activation ${activation.phoneNumber}.`, 'ok', {
        activationId: activation.activationId,
      });

      try {
        await this.syncActiveActivations({
          ...currentState,
          currentHeroSmsActivation: activation,
        }, { fetchedAt: this.now() });
      } catch {
        // Swallow sync errors for standalone runtime users.
      }
      return activation;
    }

    async ensureActivationReadyForSubmission(state = this.state, options = {}) {
      const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts) || HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT));
      let currentState = normalizeHeroSmsState(state, this.now());
      let lastStatus = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const activation = await this.ensureActivationForFlow(currentState, options);
        const config = this.ensureConfig(this.getConfig(currentState));
        lastStatus = await this.heroSmsGetStatus(activation.activationId, config);
        const updatedActivation = this.mergeCurrentActivation({
          lastStatus: lastStatus.status,
          lastStatusAt: this.now(),
        }) || activation;

        if (!isHeroSmsActivationCanceledStatus(lastStatus.status)) {
          return updatedActivation;
        }

        this.emitLog(
          `Activation ${activation.phoneNumber} was cancelled before submission, retrying with a fresh number (${attempt}/${maxAttempts}).`,
          'warn',
          { activationId: activation.activationId, status: lastStatus.status }
        );
        this.setCurrentActivation(null);
        this.setLastCode('');
        this.setRuntimeStatus('Current number is invalid, requesting a new HeroSMS number.');
        currentState = this.getState();
      }

      throw new Error(
        `Failed to acquire a valid HeroSMS number after ${maxAttempts} attempts.${lastStatus?.raw ? ` Last status: ${lastStatus.raw}` : ''}`
      );
    }

    async requestResendForCurrentActivation(options = {}) {
      const config = this.ensureConfig(this.getConfig());
      const activation = this.getCurrentActivation();
      if (!activation) {
        throw new Error('There is no current HeroSMS activation to resend.');
      }

      const response = await this.heroSmsRequestNextSms(activation.activationId, config);
      const nextActivation = this.mergeCurrentActivation({
        resendCount: activation.resendCount + 1,
        lastStatus: response,
        lastStatusAt: this.now(),
      });

      if (!options.silent) {
        this.emitLog(`Requested a new SMS for ${activation.phoneNumber}.`, 'warn', {
          activationId: activation.activationId,
          response,
        });
      }
      this.setRuntimeStatus(`Requested SMS resend (${nextActivation?.resendCount || (activation.resendCount + 1)}).`);

      return {
        ok: true,
        activation: nextActivation,
        response,
      };
    }

    async moveActivationToFailedList(activation, reason, errorText = '') {
      const normalizedActivation = normalizeHeroSmsActivation(activation, this.now());
      if (!normalizedActivation) {
        return null;
      }

      const config = this.getConfig();
      const now = this.now();
      const failedEntry = normalizeHeroSmsFailedActivation({
        ...normalizedActivation,
        reason,
        errorText,
        failedAt: now,
        cleanupAt: now + HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS,
        status: 'scheduled',
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
      }, now);

      this.upsertFailedActivation(failedEntry);
      const currentActivation = this.getCurrentActivation();
      if (currentActivation && currentActivation.activationId === normalizedActivation.activationId) {
        this.setCurrentActivation(null);
      }
      this.setLastCode('');
      this.setRuntimeStatus(`Moved ${normalizedActivation.phoneNumber} to failed list.`);
      return failedEntry;
    }

    async moveActivationToStandbyList(activation, reason, errorText = '') {
      const normalizedActivation = normalizeHeroSmsActivation(activation, this.now());
      if (!normalizedActivation) {
        return null;
      }

      const remainingMs = this.getActivationRemainingMs(normalizedActivation);
      if (remainingMs <= HERO_SMS_STANDBY_RETRY_DELAY_MS) {
        return null;
      }

      const now = this.now();
      const standbyEntry = normalizeHeroSmsStandbyActivation({
        ...normalizedActivation,
        reason,
        errorText,
        standbyAt: now,
        retryAt: now + HERO_SMS_STANDBY_RETRY_DELAY_MS,
        status: 'waiting_retry',
      }, now);
      this.upsertStandbyActivation(standbyEntry);

      const currentActivation = this.getCurrentActivation();
      if (currentActivation && currentActivation.activationId === normalizedActivation.activationId) {
        this.setCurrentActivation(null);
      }
      this.setLastCode('');
      this.setRuntimeStatus(`Moved ${normalizedActivation.phoneNumber} to standby list.`);
      return standbyEntry;
    }

    async cleanupFailedActivation(activationId) {
      const failedList = this.getFailedActivations();
      const target = failedList.find((item) => item.activationId === activationId);
      if (!target) {
        return { ok: true, skipped: true, reason: 'not_found' };
      }

      const config = {
        baseUrl: normalizeHeroSmsBaseUrl(target.baseUrl || this.state.heroSmsBaseUrl),
        apiKey: String(target.apiKey || this.state.heroSmsApiKey || '').trim(),
        service: normalizeHeroSmsService(target.service || this.state.heroSmsService),
        country: normalizeHeroSmsCountry(target.country || this.state.heroSmsCountry),
      };

      const cleanupAttemptedAt = this.now();
      let nextPatch = {
        cleanupAttemptedAt,
        cleanupError: '',
      };

      try {
        const shouldComplete = target.reason === 'phone_max_usage_exceeded' || target.useCount >= HERO_SMS_NUMBER_MAX_USES;
        if (shouldComplete) {
          const finishResponse = await this.heroSmsReleaseActivation(target.activationId, 'complete', config);
          nextPatch = {
            ...nextPatch,
            status: 'completed',
            cleanupResponse: finishResponse,
            cleanupCompletedAt: this.now(),
          };
        } else {
          try {
            const cancelResponse = await this.heroSmsReleaseActivation(target.activationId, 'cancel', config);
            nextPatch = {
              ...nextPatch,
              status: 'cancelled',
              cleanupResponse: cancelResponse,
              cleanupCompletedAt: this.now(),
            };
          } catch (cancelError) {
            const finishResponse = await this.heroSmsReleaseActivation(target.activationId, 'complete', config);
            nextPatch = {
              ...nextPatch,
              status: 'completed',
              cleanupResponse: finishResponse,
              cleanupCompletedAt: this.now(),
              cleanupError: cancelError.message,
            };
          }
        }
      } catch (error) {
        nextPatch = {
          ...nextPatch,
          status: 'cleanup_failed',
          cleanupError: error.message,
        };
      }

      this.upsertFailedActivation({
        ...target,
        ...nextPatch,
      });
      return { ok: true, activationId, status: nextPatch.status };
    }

    async cleanupFailedActivationsDue(now = this.now()) {
      const failedList = this.getFailedActivations();
      const dueList = failedList.filter((item) => !item.cleanupCompletedAt && item.cleanupAt <= now);
      const results = [];
      for (const item of dueList) {
        results.push(await this.cleanupFailedActivation(item.activationId));
      }
      return results;
    }

    async waitForCode(activation, options = {}) {
      const config = this.ensureConfig(this.getConfig());
      let currentActivation = normalizeHeroSmsActivation(
        activation || this.getCurrentActivation(),
        this.now()
      );
      if (!currentActivation) {
        throw new Error('A current HeroSMS activation is required before waiting for an SMS code.');
      }

      const signal = options.signal || null;
      const pollIntervalMs = Number(options.pollIntervalMs) || HERO_SMS_SMS_POLL_INTERVAL_MS;
      const timeoutMs = Number(options.timeoutMs) || HERO_SMS_SMS_TIMEOUT_MS;
      const resendAfterMs = Number(options.resendAfterMs) || HERO_SMS_RESEND_AFTER_MS;
      const excludeCodes = new Set((options.excludeCodes || []).map((item) => String(item || '').trim()).filter(Boolean));
      const requestFreshCodeOnStart = Boolean(options.requestFreshCodeOnStart);
      const resendCallback = typeof options.onResend === 'function' ? options.onResend : null;
      const start = this.now();
      const maxResendAttempts = Math.max(
        1,
        Math.floor(
          Number.isFinite(Number(options.maxResendAttempts))
            ? Number(options.maxResendAttempts)
            : Math.max(1, timeoutMs / Math.max(resendAfterMs, pollIntervalMs))
        )
      );
      let resendAttempts = 0;
      let nextResendAt = start + resendAfterMs;

      if (options.markReady !== false) {
        ensureNotAborted(signal);
        const readyResponse = await this.heroSmsSetActivationReady(currentActivation.activationId, config);
        currentActivation = this.mergeCurrentActivation({
          lastStatus: readyResponse,
          lastStatusAt: this.now(),
        }) || currentActivation;
        this.setRuntimeStatus(`Activation ${currentActivation.phoneNumber} is ready and waiting for SMS.`);
      }

      const triggerResend = async (reason) => {
        if (resendAttempts >= maxResendAttempts) {
          return false;
        }

        resendAttempts += 1;
        if (resendCallback) {
          await resendCallback({
            attempt: resendAttempts,
            reason,
            activation: cloneValue(currentActivation),
          });
        } else {
          await this.requestResendForCurrentActivation({ silent: false });
        }

        nextResendAt = this.now() + resendAfterMs;
        return true;
      };

      if (requestFreshCodeOnStart) {
        ensureNotAborted(signal);
        await triggerResend('initial');
      }

      while (this.now() - start < timeoutMs) {
        ensureNotAborted(signal);
        const status = await this.heroSmsGetStatus(currentActivation.activationId, config);
        currentActivation = this.mergeCurrentActivation({
          lastStatus: status.raw,
          lastStatusAt: this.now(),
        }) || currentActivation;

        const deliveredCode = extractHeroSmsDeliveredCode(status);
        if (deliveredCode && !excludeCodes.has(deliveredCode)) {
          this.setLastCode(deliveredCode);
          currentActivation = this.mergeCurrentActivation({
            lastCode: deliveredCode,
            lastStatus: status.raw,
            lastStatusAt: this.now(),
          }) || currentActivation;
          this.setRuntimeStatus(`Received code ${deliveredCode}`);
          return {
            ok: true,
            code: deliveredCode,
            raw: status.raw,
          };
        }

        if (this.now() >= nextResendAt && resendAttempts < maxResendAttempts) {
          ensureNotAborted(signal);
          await triggerResend('timeout');
        }

        ensureNotAborted(signal);
        await this.sleepImpl(pollIntervalMs);
      }

      const timeoutError = new Error('HeroSMS wait for SMS code timed out.');
      timeoutError.code = 'hero_sms_wait_code_timeout';
      timeoutError.errorText = timeoutError.message;
      throw timeoutError;
    }
  }

  function createHeroSmsRuntime(options = {}) {
    return new HeroSmsRuntime(options);
  }

  return {
    DEFAULT_HERO_SMS_BASE_URL,
    HERO_SMS_NUMBER_MAX_USES,
    HERO_SMS_ACTIVATION_TTL_MS,
    HERO_SMS_STANDBY_RETRY_DELAY_MS,
    HERO_SMS_SMS_POLL_INTERVAL_MS,
    HERO_SMS_SMS_TIMEOUT_MS,
    HERO_SMS_RESEND_AFTER_MS,
    HERO_SMS_PHONE_MAX_USAGE_RETRY_LIMIT,
    HERO_SMS_FAILED_ACTIVATION_CLEANUP_DELAY_MS,
    HERO_SMS_SERVICE_ALIASES,
    HeroSmsRuntime,
    createHeroSmsRuntime,
    extractHeroSmsDeliveredCode,
    extractHeroSmsErrorText,
    isHeroSmsActivationCanceledStatus,
    isHeroSmsDeliveredStatus,
    normalizeHeroSmsActivation,
    normalizeHeroSmsActiveActivation,
    normalizeHeroSmsActiveActivationList,
    normalizeHeroSmsBaseUrl,
    normalizeHeroSmsCountry,
    normalizeHeroSmsCountryCatalogEntry,
    normalizeHeroSmsFailedActivation,
    normalizeHeroSmsFailedActivationList,
    normalizeHeroSmsService,
    normalizeHeroSmsStandbyActivation,
    normalizeHeroSmsStandbyActivationList,
    normalizeHeroSmsState,
    parseHeroSmsActiveActivationsResponse,
    parseHeroSmsNumberResponse,
    parseHeroSmsNumberV2Response,
    parseHeroSmsStatusResponse,
    validateHeroSmsSetStatusResponse,
    firstNonEmptyString,
  };
});
