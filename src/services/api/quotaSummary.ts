/**
 * Provider quota summaries from the backend pollers, normalized to camelCase.
 *
 * Contracts (CLIProxyAPI): `GET /v8/management/quota/claude` (docs/management-api-v8.md,
 * `summary.weekly_*` keys) and `GET /v8/management/quota/cursor`
 * (docs/cursor/USAGE-TRACKING.md section 5, `summary.*` keys). Both are poller
 * snapshots: reading them makes no upstream call.
 */

import type { QuotaSummary, QuotaSummarySegment } from '@/types';
import { isRecord } from '@/utils/helpers';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { apiClient } from './client';

export type QuotaSummaryProvider = 'claude' | 'cursor';

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const nullableText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

/** Summary keys differ per provider; everything else is shared. */
const SUMMARY_KEYS: Record<
  QuotaSummaryProvider,
  { window: string; remaining: string; capacity: string }
> = {
  claude: {
    window: 'weekly_window',
    remaining: 'weekly_remaining_percent_sum',
    capacity: 'weekly_capacity_percent',
  },
  cursor: { window: 'window', remaining: 'remaining_percent_sum', capacity: 'capacity_percent' },
};

/** The `summary` of a quota response; segment names come from its `credentials[]`. */
export function normalizeQuotaSummary(
  provider: QuotaSummaryProvider,
  value: unknown
): QuotaSummary {
  const root = asRecord(value);
  const summary = asRecord(root.summary);
  const keys = SUMMARY_KEYS[provider];

  const identities = new Map<string, { name: string; email: string }>();
  if (Array.isArray(root.credentials)) {
    root.credentials.forEach((entry) => {
      const record = asRecord(entry);
      const authIndex = normalizeAuthIndex(record.auth_index);
      if (authIndex)
        identities.set(authIndex, { name: text(record.name), email: text(record.email) });
    });
  }

  const segments: QuotaSummarySegment[] = Array.isArray(summary.segments)
    ? summary.segments.flatMap((entry): QuotaSummarySegment[] => {
        const record = asRecord(entry);
        const authIndex = normalizeAuthIndex(record.auth_index);
        const remainingPercent = finiteNumber(record.remaining_percent);
        if (!authIndex || remainingPercent === null) return [];
        const identity = identities.get(authIndex);
        return [
          {
            authIndex,
            remainingPercent,
            name: identity?.name ?? '',
            email: identity?.email ?? '',
          },
        ];
      })
    : [];

  return {
    credentials: finiteNumber(summary.credentials) ?? identities.size,
    loaded: finiteNumber(summary.loaded) ?? segments.length,
    window: text(summary[keys.window]),
    remainingPercentSum: finiteNumber(summary[keys.remaining]) ?? 0,
    capacityPercent: finiteNumber(summary[keys.capacity]) ?? 0,
    segments,
    nextResetAt: nullableText(summary.next_reset_at),
    onDemandUsedUsdSum: provider === 'cursor' ? finiteNumber(summary.on_demand_used_usd_sum) : null,
  };
}

export const quotaSummaryApi = {
  async get(provider: QuotaSummaryProvider): Promise<QuotaSummary> {
    return normalizeQuotaSummary(provider, await apiClient.get(`/quota/${provider}`));
  },
};
