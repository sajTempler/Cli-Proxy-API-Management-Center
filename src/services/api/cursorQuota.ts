/**
 * Cursor quota endpoint (`/v8/management/quota/cursor`), normalized to camelCase.
 *
 * Contract: CLIProxyAPI docs/cursor/USAGE-TRACKING.md section 5. Every key is
 * documented as always present, but the reader still narrows `unknown` so a
 * partial or older payload degrades to nulls instead of throwing in the UI.
 */

import type {
  CursorOnDemand,
  CursorOnDemandLimitKind,
  CursorPercentWindowData,
  CursorPlan,
  CursorQuotaCredential,
  CursorQuotaExtra,
  CursorQuotaResponse,
} from '@/types';
import { isRecord } from '@/utils/helpers';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { apiClient } from './client';

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const nullableText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

const LIMIT_KINDS: readonly CursorOnDemandLimitKind[] = [
  'fixed',
  'unlimited',
  'disabled',
  'unavailable',
];

const normalizePercentWindow = (value: unknown): CursorPercentWindowData | null => {
  if (!isRecord(value)) return null;
  const usedPercent = finiteNumber(value.used_percent);
  if (usedPercent === null) return null;
  return {
    usedPercent,
    remainingPercent: finiteNumber(value.remaining_percent) ?? Math.max(0, 100 - usedPercent),
    resetsAt: nullableText(value.resets_at),
    observedAt: nullableText(value.observed_at),
  };
};

const normalizeOnDemand = (value: unknown): CursorOnDemand | null => {
  if (!isRecord(value)) return null;
  const rawKind = text(value.limit_kind) as CursorOnDemandLimitKind;
  const limitKind = LIMIT_KINDS.includes(rawKind) ? rawKind : 'unavailable';
  const fixed = limitKind === 'fixed';
  return {
    limitKind,
    limitScope: text(value.limit_scope),
    usedUsd: finiteNumber(value.used_usd) ?? 0,
    limitUsd: fixed ? finiteNumber(value.limit_usd) : null,
    remainingUsd: fixed ? finiteNumber(value.remaining_usd) : null,
    usedPercent: fixed ? finiteNumber(value.used_percent) : null,
    resetsAt: nullableText(value.resets_at),
    observedAt: nullableText(value.observed_at),
  };
};

const normalizePlan = (value: unknown): CursorPlan | null => {
  if (!isRecord(value)) return null;
  const label = text(value.label).trim();
  if (!label) return null;
  return { label, price: text(value.price).trim() };
};

const normalizeExtra = (value: unknown): CursorQuotaExtra | null => {
  if (!isRecord(value)) return null;
  return {
    billingCycleStart: nullableText(value.billing_cycle_start),
    includedSpendUsd: finiteNumber(value.included_spend_usd),
    includedLimitUsd: finiteNumber(value.included_limit_usd),
    bonusUsd: finiteNumber(value.bonus_usd),
    totalSpendUsd: finiteNumber(value.total_spend_usd),
    autoBucketModels: Array.isArray(value.auto_bucket_models)
      ? value.auto_bucket_models.filter((model): model is string => typeof model === 'string')
      : [],
  };
};

/** One `credentials[]` entry; null when it has no usable `auth_index`. */
export function normalizeCursorQuotaCredential(value: unknown): CursorQuotaCredential | null {
  if (!isRecord(value)) return null;
  const authIndex = normalizeAuthIndex(value.auth_index);
  if (!authIndex) return null;
  const windows = asRecord(value.windows);
  return {
    authIndex,
    id: text(value.id),
    name: text(value.name),
    email: text(value.email),
    disabled: value.disabled === true,
    status: text(value.status),
    plan: normalizePlan(value.plan),
    included: normalizePercentWindow(windows.included),
    includedAuto: normalizePercentWindow(windows.included_auto),
    includedApi: normalizePercentWindow(windows.included_api),
    onDemand: normalizeOnDemand(windows.on_demand),
    extra: normalizeExtra(value.extra),
    lastPollAt: nullableText(value.last_poll_at),
    nextPollAt: nullableText(value.next_poll_at),
    pollError: text(value.poll_error),
  };
}

const normalizeCredentials = (value: unknown): CursorQuotaCredential[] =>
  Array.isArray(value)
    ? value
        .map(normalizeCursorQuotaCredential)
        .filter((entry): entry is CursorQuotaCredential => entry !== null)
    : [];

/** The GET payload. Unknown shapes normalize to an empty credential list. */
export function normalizeCursorQuotaResponse(value: unknown): CursorQuotaResponse {
  const root = asRecord(value);
  return {
    generatedAt: nullableText(root.generated_at),
    refreshIntervalSeconds: finiteNumber(root.refresh_interval_seconds),
    credentials: normalizeCredentials(root.credentials),
  };
}

export const cursorQuotaApi = {
  /** Poller snapshot of every cursor credential; no upstream call. */
  async get(): Promise<CursorQuotaResponse> {
    return normalizeCursorQuotaResponse(await apiClient.get('/quota/cursor'));
  },

  /** Synchronous upstream poll; returns only the refreshed entries. */
  async refresh(authIndex?: string): Promise<CursorQuotaCredential[]> {
    const body = authIndex ? { auth_index: authIndex } : {};
    const data = await apiClient.post('/quota/cursor/refresh', body);
    return normalizeCredentials(asRecord(data).credentials);
  },
};
