/**
 * Cursor quota data: the backend's poller view of the agent CLI's `/usage`.
 * React-free and SCSS-free so fixture tests can consume the data layer directly.
 *
 * Cards come from `/v8/management/credentials` (`type: "cursor"`); each one is
 * matched to its quota entry by `auth_index`, which the contract shares between
 * both endpoints.
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CursorQuotaCredential,
  CursorQuotaState,
  CursorQuotaWindow,
  CursorQuotaWindowId,
  CursorPercentWindowData,
} from '@/types';
import { cursorQuotaApi } from '@/services/api/cursorQuota';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getStatusFromError, isCursorFile, isDisabledAuthFile, parseIsoToMs } from '@/utils/quota';
import { HOUR_MS } from '@/utils/time/durations';
import type { QuotaProviderData } from '../types';

/** Fallback when the cycle start is unknown; Cursor's cycle is 30 days. */
export const CURSOR_DEFAULT_PERIOD_HOURS = 24 * 30;

export type CursorQuotaData = Omit<CursorQuotaState, 'status' | 'error' | 'errorStatus'>;

/* ---------- display rules (section 5 of the contract, matching the CLI) ---------- */

/** `round(clamp(p, 0, 100))`, except values in (0, 1) render as 1. */
export function formatCursorPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > 0 && value < 1) return 1;
  return Math.round(Math.min(100, Math.max(0, value)));
}

/** Dollars with 0 decimals when integral, else 2: `$400`, `$117.87`. */
export function formatCursorUsd(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** The CLI's `Resets MMM d`, always in UTC. */
export function formatCursorResetDate(iso: string | null | undefined, locale?: string): string {
  const ms = parseIsoToMs(iso);
  if (ms === null) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const POLL_ERROR_CODES = new Set([
  'token_expired',
  'no_access_token',
  'unauthorized',
  'request_failed',
  'invalid_response',
  'usage_unavailable',
]);

/**
 * i18n key and params for a backend `poll_error` code. `rate_limited (429)`
 * and `rate_limited (403)` share one message; `http_<status>` and unknown
 * codes fall back to a generic message that shows the raw code.
 */
export function cursorPollErrorMessage(code: string): {
  key: string;
  params?: Record<string, string>;
} {
  const trimmed = code.trim();
  if (POLL_ERROR_CODES.has(trimmed)) return { key: `cursor_quota.poll_error_${trimmed}` };
  if (trimmed.startsWith('rate_limited')) return { key: 'cursor_quota.poll_error_rate_limited' };
  return { key: 'cursor_quota.poll_error_other', params: { code: trimmed } };
}

/* ---------- state building ---------- */

const WINDOW_SOURCES: {
  id: CursorQuotaWindowId;
  labelKey: string;
  pick: (entry: CursorQuotaCredential) => CursorPercentWindowData | null;
}[] = [
  { id: 'included', labelKey: 'cursor_quota.included', pick: (entry) => entry.included },
  { id: 'included_auto', labelKey: 'cursor_quota.auto', pick: (entry) => entry.includedAuto },
  { id: 'included_api', labelKey: 'cursor_quota.api', pick: (entry) => entry.includedApi },
];

const resolvePeriodHours = (
  resetAtMs: number | null,
  cycleStart: string | null | undefined
): number => {
  const startMs = parseIsoToMs(cycleStart);
  if (resetAtMs !== null && startMs !== null && resetAtMs > startMs) {
    return (resetAtMs - startMs) / HOUR_MS;
  }
  return CURSOR_DEFAULT_PERIOD_HOURS;
};

/** Card data for one backend entry. `t` resolves window labels for the timeline. */
export function buildCursorQuotaData(entry: CursorQuotaCredential, t: TFunction): CursorQuotaData {
  // All four windows carry the same billing-cycle end; take the first present.
  const resetsAt =
    entry.included?.resetsAt ??
    entry.includedAuto?.resetsAt ??
    entry.includedApi?.resetsAt ??
    entry.onDemand?.resetsAt ??
    null;
  const resetAtMs = parseIsoToMs(resetsAt);
  const periodHours = resolvePeriodHours(resetAtMs, entry.extra?.billingCycleStart);

  const windows = WINDOW_SOURCES.flatMap(({ id, labelKey, pick }): CursorQuotaWindow[] => {
    const window = pick(entry);
    if (!window) return [];
    return [
      {
        id,
        label: t(labelKey),
        labelKey,
        usedPercent: window.usedPercent,
        resetAtMs: parseIsoToMs(window.resetsAt) ?? resetAtMs,
        periodHours,
      },
    ];
  });

  return {
    windows,
    onDemand: entry.onDemand,
    plan: entry.plan,
    resetsAt,
    extra: entry.extra,
    pollError: entry.pollError,
    lastPollAt: entry.lastPollAt,
  };
}

/** The entry for a credential: `auth_index` first, then the file name the contract echoes. */
export function findCursorQuotaEntry(
  entries: readonly CursorQuotaCredential[],
  file: AuthFileItem
): CursorQuotaCredential | undefined {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  return (
    (authIndex ? entries.find((entry) => entry.authIndex === authIndex) : undefined) ??
    entries.find((entry) => entry.name === file.name || entry.id === file.name)
  );
}

/**
 * Snapshot reads are shared across cards fetched together, so "refresh all"
 * makes one GET however many Cursor cards fall back to it.
 */
let snapshotInFlight: Promise<CursorQuotaCredential[]> | null = null;
const readSnapshot = (): Promise<CursorQuotaCredential[]> => {
  if (!snapshotInFlight) {
    snapshotInFlight = cursorQuotaApi
      .get()
      .then((response) => response.credentials)
      .finally(() => {
        snapshotInFlight = null;
      });
  }
  return snapshotInFlight;
};

/**
 * A refresh asks the backend to poll Cursor now. When it cannot (backoff 429,
 * poller off 503, entry unknown 404) the poller's last snapshot is still the
 * best answer, so the card falls back to GET rather than failing.
 */
const REFRESH_FALLBACK_STATUSES = new Set([404, 429, 503]);

const fetchCursorQuota = async (file: AuthFileItem, t: TFunction): Promise<CursorQuotaData> => {
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
  if (!authIndex) {
    throw new Error(t('cursor_quota.missing_auth_index'));
  }

  let entry: CursorQuotaCredential | undefined;
  try {
    entry = findCursorQuotaEntry(await cursorQuotaApi.refresh(authIndex), file);
  } catch (err: unknown) {
    const status = getStatusFromError(err);
    if (status === undefined || !REFRESH_FALLBACK_STATUSES.has(status)) throw err;
  }
  entry ??= findCursorQuotaEntry(await readSnapshot(), file);
  if (!entry) {
    throw new Error(t('cursor_quota.not_tracked'));
  }
  const data = buildCursorQuotaData(entry, t);
  // Nothing to show and a reason why (expired login, Enterprise...): that card needs attention.
  if (data.windows.length === 0 && !data.onDemand && data.pollError) {
    const message = cursorPollErrorMessage(data.pollError);
    throw new Error(t(message.key, message.params));
  }
  return data;
};

export const CURSOR_CONFIG: QuotaProviderData<CursorQuotaState, CursorQuotaData> = {
  type: 'cursor',
  i18nPrefix: 'cursor_quota',
  filterFn: (file) => isCursorFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchCursorQuota,
  storeSelector: (state) => state.cursorQuota,
  storeSetter: 'setCursorQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({ status: 'success', ...data }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
};
