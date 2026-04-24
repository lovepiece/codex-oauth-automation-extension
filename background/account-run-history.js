(function attachBackgroundAccountRunHistory(root, factory) {
  root.MultiPageBackgroundAccountRunHistory = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundAccountRunHistoryModule() {
  function createAccountRunHistoryHelpers(deps = {}) {
    const {
      ACCOUNT_RUN_HISTORY_STORAGE_KEY = 'accountRunHistory',
      addLog,
      buildLocalHelperEndpoint,
      chrome,
      getErrorMessage,
      getState,
      normalizeAccountRunHistoryHelperBaseUrl,
    } = deps;

    function normalizeTimestamp(value) {
      const timestamp = Date.parse(String(value || ''));
      return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function normalizeRetryCount(value) {
      const count = Math.floor(Number(value) || 0);
      return count > 0 ? count : 0;
    }

    function normalizeFinalStatus(status = '') {
      const normalized = String(status || '').trim().toLowerCase();
      if (!normalized) {
        return '';
      }
      if (normalized === 'success') {
        return 'success';
      }
      if (normalized === 'failed' || /_failed$/.test(normalized)) {
        return 'failed';
      }
      if (normalized === 'stopped' || /_stopped$/.test(normalized)) {
        return 'stopped';
      }
      return '';
    }

    function extractRecordStep(status = '', detail = '') {
      const normalizedStatus = String(status || '').trim().toLowerCase();
      const statusMatch = normalizedStatus.match(/^step(\d+)_(?:failed|stopped)$/);
      if (statusMatch) {
        const step = Number(statusMatch[1]);
        return Number.isInteger(step) && step > 0 ? step : null;
      }

      const text = String(detail || '').trim();
      const detailMatch = text.match(/(?:Step\s+(\d+)|步骤\s*(\d+))/i);
      if (!detailMatch) {
        return null;
      }

      const step = Number(detailMatch[1] || detailMatch[2]);
      return Number.isInteger(step) && step > 0 ? step : null;
    }

    function isPhoneVerificationFailure(detail = '') {
      const text = String(detail || '').trim();
      if (!text) {
        return false;
      }

      return /add[_\s-]?phone/i.test(text)
        || /手机号(?:验证|页面|页)|手机(?:号)?页面|出现手机号验证/.test(text)
        || /进入了手机号页面/.test(text);
    }

    function buildFailureLabel(finalStatus, failedStep, failureDetail = '') {
      if (finalStatus === 'success') {
        return '流程完成';
      }
      if (finalStatus === 'stopped') {
        if (Number.isInteger(failedStep) && failedStep > 0) {
          return `步骤 ${failedStep} 停止`;
        }
        return '流程已停止';
      }
      if (finalStatus !== 'failed') {
        return '无';
      }
      if (isPhoneVerificationFailure(failureDetail)) {
        return '出现手机号验证';
      }
      if (Number.isInteger(failedStep) && failedStep > 0) {
        return `步骤 ${failedStep} 失败`;
      }
      return '流程失败';
    }

    function buildRecordId(email = '') {
      return String(email || '').trim().toLowerCase();
    }

    function normalizeSource(value = '') {
      return String(value || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual';
    }

    function normalizeAutoRunContext(context) {
      if (!context || typeof context !== 'object') {
        return null;
      }

      const currentRun = Math.max(0, Math.floor(Number(context.currentRun) || 0));
      const totalRuns = Math.max(0, Math.floor(Number(context.totalRuns) || 0));
      const attemptRun = Math.max(0, Math.floor(Number(context.attemptRun) || 0));

      if (!currentRun && !totalRuns && !attemptRun) {
        return null;
      }

      return {
        currentRun,
        totalRuns,
        attemptRun,
      };
    }

    function buildAutoRunContextFromState(state = {}) {
      return normalizeAutoRunContext({
        currentRun: state.autoRunCurrentRun,
        totalRuns: state.autoRunTotalRuns,
        attemptRun: state.autoRunAttemptRun,
      });
    }

    function getRetryCountFromState(state = {}) {
      if (!Boolean(state.autoRunning)) {
        return 0;
      }

      const attemptRun = Math.max(0, Math.floor(Number(state.autoRunAttemptRun) || 0));
      return attemptRun > 1 ? attemptRun - 1 : 0;
    }

    function normalizeAccountRunHistoryRecord(record) {
      if (!record || typeof record !== 'object') {
        return null;
      }

      const email = String(record.email || '').trim();
      const password = String(record.password || '').trim();
      const finalStatus = normalizeFinalStatus(record.finalStatus || record.status || '');

      if (!email || !password || !finalStatus) {
        return null;
      }

      const finishedAt = String(record.finishedAt || record.recordedAt || '').trim();
      const failureDetail = finalStatus === 'failed' || finalStatus === 'stopped'
        ? String(record.failureDetail || record.reason || '').trim()
        : '';
      const failedStepCandidate = Number(record.failedStep);
      const failedStep = Number.isInteger(failedStepCandidate) && failedStepCandidate > 0
        ? failedStepCandidate
        : extractRecordStep(record.finalStatus || record.status || '', failureDetail);
      const autoRunContext = normalizeAutoRunContext(record.autoRunContext);
      const retryCount = normalizeRetryCount(
        record.retryCount !== undefined
          ? record.retryCount
          : ((autoRunContext?.attemptRun || 0) > 1 ? autoRunContext.attemptRun - 1 : 0)
      );
      const source = normalizeSource(record.source || (autoRunContext ? 'auto' : 'manual'));
      const computedFailureLabel = buildFailureLabel(finalStatus, failedStep, failureDetail);
      const rawFailureLabel = String(record.failureLabel || '').trim();

      return {
        recordId: String(record.recordId || '').trim() || buildRecordId(email),
        email,
        password,
        finalStatus,
        finishedAt,
        retryCount,
        failureLabel: finalStatus === 'stopped'
          ? computedFailureLabel
          : (rawFailureLabel || computedFailureLabel),
        failureDetail,
        failedStep: Number.isInteger(failedStep) && failedStep > 0 ? failedStep : null,
        source,
        autoRunContext: source === 'auto' ? autoRunContext : null,
      };
    }

    function normalizeAccountRunHistory(records) {
      if (!Array.isArray(records)) {
        return [];
      }

      return records
        .map((item) => normalizeAccountRunHistoryRecord(item))
        .filter(Boolean)
        .sort((left, right) => normalizeTimestamp(right.finishedAt) - normalizeTimestamp(left.finishedAt));
    }

    async function getPersistedAccountRunHistory() {
      try {
        const stored = await chrome.storage.local.get(ACCOUNT_RUN_HISTORY_STORAGE_KEY);
        return normalizeAccountRunHistory(stored[ACCOUNT_RUN_HISTORY_STORAGE_KEY]);
      } catch (err) {
        console.warn('[MultiPage:account-run-history] Failed to read account run history:', err?.message || err);
        return [];
      }
    }

    async function setPersistedAccountRunHistory(records) {
      const normalizedHistory = normalizeAccountRunHistory(records);
      await chrome.storage.local.set({
        [ACCOUNT_RUN_HISTORY_STORAGE_KEY]: normalizedHistory,
      });
      return normalizedHistory;
    }

    function buildAccountRunHistoryRecord(state = {}, status = '', reason = '') {
      const email = String(state.email || '').trim();
      const password = String(state.password || state.customPassword || '').trim() || '无';
      const finalStatus = normalizeFinalStatus(status);

      if (!email || !finalStatus) {
        return null;
      }

      const failureDetail = finalStatus === 'failed' || finalStatus === 'stopped' ? String(reason || '').trim() : '';
      const failedStep = finalStatus === 'failed' || finalStatus === 'stopped'
        ? extractRecordStep(status, failureDetail)
        : null;
      const source = Boolean(state.autoRunning) ? 'auto' : 'manual';
      const autoRunContext = source === 'auto' ? buildAutoRunContextFromState(state) : null;
      const retryCount = source === 'auto' ? getRetryCountFromState(state) : 0;
      const finishedAt = new Date().toISOString();

      return {
        recordId: buildRecordId(email),
        email,
        password,
        finalStatus,
        finishedAt,
        retryCount,
        failureLabel: buildFailureLabel(finalStatus, failedStep, failureDetail),
        failureDetail,
        failedStep: Number.isInteger(failedStep) && failedStep > 0 ? failedStep : null,
        source,
        autoRunContext,
      };
    }

    function upsertAccountRunHistoryRecord(history, record) {
      const normalizedHistory = normalizeAccountRunHistory(history);
      if (!record) {
        return normalizedHistory;
      }

      const recordId = String(record.recordId || '').trim();
      const emailKey = String(record.email || '').trim().toLowerCase();
      const nextHistory = normalizedHistory.filter((item) => {
        const itemRecordId = String(item.recordId || '').trim();
        const itemEmailKey = String(item.email || '').trim().toLowerCase();
        return itemRecordId !== recordId && itemEmailKey !== emailKey;
      });

      nextHistory.unshift(record);
      return normalizeAccountRunHistory(nextHistory);
    }

    function deleteAccountRunHistoryEntries(history, recordIds = []) {
      const normalizedHistory = normalizeAccountRunHistory(history);
      const normalizedIds = Array.isArray(recordIds)
        ? recordIds
          .map((value) => String(value || '').trim().toLowerCase())
          .filter(Boolean)
        : [];

      if (!normalizedIds.length) {
        return {
          deletedCount: 0,
          nextHistory: normalizedHistory,
        };
      }

      const selectedIds = new Set(normalizedIds);
      const nextHistory = normalizedHistory.filter((record) => !selectedIds.has(buildRecordId(record.recordId || record.email)));

      return {
        deletedCount: normalizedHistory.length - nextHistory.length,
        nextHistory: normalizeAccountRunHistory(nextHistory),
      };
    }

    async function appendAccountRunHistoryRecord(status, stateOverride = null, reason = '') {
      const state = stateOverride || await getState();
      const record = buildAccountRunHistoryRecord(state, status, reason);
      if (!record) {
        return null;
      }

      const history = await getPersistedAccountRunHistory();
      const nextHistory = upsertAccountRunHistoryRecord(history, record);
      await setPersistedAccountRunHistory(nextHistory);
      return record;
    }

    function summarizeAccountRunHistory(records = []) {
      return normalizeAccountRunHistory(records).reduce((summary, record) => {
        summary.total += 1;
        if (record.finalStatus === 'success') {
          summary.success += 1;
        } else if (record.finalStatus === 'failed') {
          summary.failed += 1;
        } else if (record.finalStatus === 'stopped') {
          summary.stopped += 1;
        }
        summary.retryTotal += normalizeRetryCount(record.retryCount);
        return summary;
      }, {
        total: 0,
        success: 0,
        failed: 0,
        stopped: 0,
        retryTotal: 0,
      });
    }

    function buildAccountRunHistorySnapshotPayload(records = []) {
      const normalizedHistory = normalizeAccountRunHistory(records);
      return {
        generatedAt: new Date().toISOString(),
        summary: summarizeAccountRunHistory(normalizedHistory),
        records: normalizedHistory,
      };
    }

    function shouldSyncAccountRunHistorySnapshot(state = {}) {
      if (!Boolean(state.accountRunHistoryTextEnabled)) {
        return false;
      }

      const helperBaseUrl = normalizeAccountRunHistoryHelperBaseUrl(state.accountRunHistoryHelperBaseUrl);
      return Boolean(helperBaseUrl);
    }

    function shouldAppendAccountRunTextFile(state = {}) {
      return shouldSyncAccountRunHistorySnapshot(state);
    }

    async function syncAccountRunHistorySnapshot(records, stateOverride = null) {
      const state = stateOverride || await getState();
      if (!shouldSyncAccountRunHistorySnapshot(state)) {
        return '';
      }

      const helperBaseUrl = normalizeAccountRunHistoryHelperBaseUrl(state.accountRunHistoryHelperBaseUrl);
      let response;
      try {
        response = await fetch(buildLocalHelperEndpoint(helperBaseUrl, '/sync-account-run-records'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(buildAccountRunHistorySnapshotPayload(records)),
        });
      } catch (err) {
        throw new Error(`账号记录快照同步失败：无法连接本地 helper（${getErrorMessage(err)}）`);
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch (err) {
        throw new Error(`账号记录快照同步失败：本地 helper 返回了无法解析的响应（${getErrorMessage(err)}）`);
      }

      if (!response.ok || payload?.ok === false) {
        throw new Error(`账号记录快照同步失败：${payload?.error || `HTTP ${response.status}`}`);
      }

      return payload?.filePath || '';
    }

    async function appendAccountRunRecord(status, stateOverride = null, reason = '') {
      const state = stateOverride || await getState();
      const record = await appendAccountRunHistoryRecord(status, state, reason);
      if (!record) {
        return null;
      }

      try {
        const history = await getPersistedAccountRunHistory();
        const filePath = await syncAccountRunHistorySnapshot(history, state);
        if (filePath) {
          await addLog(`账号记录快照已同步到本地：${filePath}`, 'info');
        }
      } catch (err) {
        await addLog(getErrorMessage(err), 'warn');
      }

      return record;
    }

    async function clearAccountRunHistory(stateOverride = null) {
      const state = stateOverride || await getState();
      const history = await getPersistedAccountRunHistory();
      await setPersistedAccountRunHistory([]);

      try {
        const filePath = await syncAccountRunHistorySnapshot([], state);
        if (filePath) {
          await addLog(`账号记录快照已同步到本地：${filePath}`, 'info');
        }
      } catch (err) {
        await addLog(getErrorMessage(err), 'warn');
      }

      return {
        clearedCount: history.length,
      };
    }

    async function deleteAccountRunHistoryRecords(recordIds = [], stateOverride = null) {
      const state = stateOverride || await getState();
      const history = await getPersistedAccountRunHistory();
      const { deletedCount, nextHistory } = deleteAccountRunHistoryEntries(history, recordIds);

      if (!deletedCount) {
        return {
          deletedCount: 0,
          remainingCount: history.length,
        };
      }

      await setPersistedAccountRunHistory(nextHistory);

      try {
        const filePath = await syncAccountRunHistorySnapshot(nextHistory, state);
        if (filePath) {
          await addLog(`账号记录快照已同步到本地：${filePath}`, 'info');
        }
      } catch (err) {
        await addLog(getErrorMessage(err), 'warn');
      }

      return {
        deletedCount,
        remainingCount: nextHistory.length,
      };
    }

    return {
      appendAccountRunRecord,
      appendAccountRunHistoryRecord,
      buildAccountRunHistoryRecord,
      buildAccountRunHistorySnapshotPayload,
      clearAccountRunHistory,
      deleteAccountRunHistoryRecords,
      getPersistedAccountRunHistory,
      normalizeAccountRunHistory,
      normalizeAccountRunHistoryRecord,
      normalizeFinalStatus,
      setPersistedAccountRunHistory,
      shouldAppendAccountRunTextFile,
      shouldSyncAccountRunHistorySnapshot,
      summarizeAccountRunHistory,
      syncAccountRunHistorySnapshot,
    };
  }

  return {
    createAccountRunHistoryHelpers,
  };
});
