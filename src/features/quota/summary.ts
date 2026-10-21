/**
 * Provider summary card model: the pool summed across accounts, one bar
 * segment per account. React-free so tests can consume it directly.
 *
 * Claude reads REMAINING weekly quota (`409% of 500%`), like its card meters.
 * Cursor reads USED included quota, like its card, whose bars fill with the
 * share used.
 */

import type { QuotaSummary, QuotaSummarySegment } from '@/types';
import type { QuotaSummaryProvider } from '@/services/api/quotaSummary';
import { parseIsoToMs } from '@/utils/quota';
import { MINUTE_MS } from '@/utils/time/durations';
import { formatCursorPercent } from './providers/cursor/data';

export type { QuotaSummaryProvider };

export const QUOTA_SUMMARY_PROVIDERS: readonly QuotaSummaryProvider[] = ['claude', 'cursor'];

export const isQuotaSummaryProvider = (value: unknown): value is QuotaSummaryProvider =>
  typeof value === 'string' && (QUOTA_SUMMARY_PROVIDERS as readonly string[]).includes(value);

/**
 * Categorical slots for account segments, assigned in backend order (accounts
 * sorted by file name). Never cycled: accounts past the last slot share a
 * neutral "other" color (slot 0).
 */
export const QUOTA_SUMMARY_SLOT_COUNT = 8;

export type QuotaSummaryMeasure = 'remaining' | 'used';

export interface QuotaSummarySegmentView {
  authIndex: string;
  name: string;
  email: string;
  /** Display percent of this account's own pool (remaining or used, per measure). */
  percent: number;
  /** Width on the bar, as a percent of the bar's whole width. */
  widthPercent: number;
  /** 1..QUOTA_SUMMARY_SLOT_COUNT, or 0 for the neutral overflow color. */
  slot: number;
}

export interface QuotaSummaryView {
  measure: QuotaSummaryMeasure;
  /** i18n key naming the window the sums cover. */
  windowLabelKey: string;
  totalPercent: number;
  capacityPercent: number;
  /** Accounts in the sums (loaded ones). */
  accounts: number;
  credentials: number;
  segments: QuotaSummarySegmentView[];
  nextResetMs: number | null;
  onDemandUsd: number | null;
}

const WINDOW_LABEL_KEYS: Record<string, string> = {
  seven_day: 'claude_quota.seven_day',
  seven_day_fable: 'claude_quota.seven_day_fable',
  included: 'cursor_quota.included',
};

/**
 * The Claude poller reports a reset scheduled on the minute as `03:59:59.71Z`;
 * the card's label reads 06:00, so the summary snaps instants within a couple
 * of seconds of a minute. Cursor's `22:31:53Z` cycle end stays as is.
 */
const MINUTE_SNAP_MS = 2000;
const roundToMinute = (ms: number | null): number | null => {
  if (ms === null) return null;
  const nearest = Math.round(ms / MINUTE_MS) * MINUTE_MS;
  return Math.abs(nearest - ms) <= MINUTE_SNAP_MS ? nearest : ms;
};

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const segmentPercent = (provider: QuotaSummaryProvider, segment: QuotaSummarySegment): number => {
  const remaining = clampPercent(segment.remainingPercent);
  return provider === 'cursor' ? 100 - remaining : remaining;
};

const roundPercent = (provider: QuotaSummaryProvider, value: number): number =>
  provider === 'cursor' ? formatCursorPercent(value) : Math.round(clampPercent(value));

export function buildQuotaSummaryView(
  provider: QuotaSummaryProvider,
  summary: QuotaSummary
): QuotaSummaryView {
  const capacity = summary.capacityPercent > 0 ? summary.capacityPercent : 0;
  const raw = summary.segments.map((segment) => segmentPercent(provider, segment));
  const total = raw.reduce((sum, value) => sum + value, 0);

  let used = 0;
  const segments = summary.segments.map((segment, index): QuotaSummarySegmentView => {
    // Each account owns an equal 100-point slot of the capacity; never overrun the bar.
    const width = capacity > 0 ? Math.min((raw[index] / capacity) * 100, 100 - used) : 0;
    used += width;
    return {
      authIndex: segment.authIndex,
      name: segment.name,
      email: segment.email,
      percent: roundPercent(provider, raw[index]),
      widthPercent: Math.round(width * 100) / 100,
      slot: index < QUOTA_SUMMARY_SLOT_COUNT ? index + 1 : 0,
    };
  });

  return {
    measure: provider === 'cursor' ? 'used' : 'remaining',
    windowLabelKey:
      WINDOW_LABEL_KEYS[summary.window] ??
      (provider === 'cursor' ? WINDOW_LABEL_KEYS.included : WINDOW_LABEL_KEYS.seven_day),
    totalPercent: Math.round(total),
    capacityPercent: Math.round(capacity),
    accounts: summary.segments.length,
    credentials: summary.credentials,
    segments,
    nextResetMs: roundToMinute(parseIsoToMs(summary.nextResetAt)),
    onDemandUsd: summary.onDemandUsedUsdSum,
  };
}
