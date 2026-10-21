/**
 * Provider summary card: the pool summed across accounts, a bar with one
 * colored segment per account, and the next reset.
 *
 * Claude: `409% of 500% remaining across 5 accounts` (weekly window).
 * Cursor: `23% of 100% used across 1 account` (included window), matching its card.
 */

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import type { QuotaSummary } from '@/types';
import { formatCursorUsd } from '../providers/cursor/data';
import {
  buildQuotaSummaryView,
  type QuotaSummaryProvider,
  type QuotaSummarySegmentView,
} from '../summary';
import styles from './QuotaSummaryCard.module.scss';

export interface QuotaSummaryCardProps {
  provider: QuotaSummaryProvider;
  summary: QuotaSummary | null;
  loading: boolean;
  now: number;
  /** Name shown for an account (masking is the caller's call). */
  accountLabel: (segment: QuotaSummarySegmentView) => string;
}

export function QuotaSummaryCard({
  provider,
  summary,
  loading,
  now,
  accountLabel,
}: QuotaSummaryCardProps) {
  const { t, i18n } = useTranslation();

  if (!summary) {
    return loading ? <Skeleton height={132} rounded={14} /> : null;
  }

  const view = buildQuotaSummaryView(provider, summary);
  const titleId = `quota-summary-${provider}`;
  const measureKey = view.measure === 'used' ? 'used' : 'remaining';
  const windowLabel = t(view.windowLabelKey);
  const resetText =
    view.nextResetMs === null
      ? t('quota_summary.no_reset')
      : `${formatRelativeInstant(view.nextResetMs, now, i18n.resolvedLanguage)} · ${formatInstantShort(view.nextResetMs)}`;
  const notLoaded = Math.max(0, view.credentials - view.accounts);

  const segmentTitle = (segment: QuotaSummarySegmentView) =>
    t(`quota_summary.segment_${measureKey}`, {
      name: accountLabel(segment),
      percent: segment.percent,
    });

  return (
    <section className={styles.card} aria-labelledby={titleId} data-provider={provider}>
      <div className={styles.stats}>
        <div className={styles.stat}>
          <h2 id={titleId} className={styles.label}>
            {t(`quota_summary.title_${measureKey}`, { window: windowLabel })}
          </h2>
          {view.accounts > 0 ? (
            <p className={styles.figure}>
              <span className={styles.value}>{view.totalPercent}%</span>
              <span className={styles.ofCapacity}>
                {t(`quota_summary.of_capacity_${measureKey}`, {
                  capacity: view.capacityPercent,
                  count: view.accounts,
                })}
              </span>
            </p>
          ) : (
            <p className={styles.empty}>{t('quota_summary.not_polled')}</p>
          )}
        </div>
        {view.onDemandUsd !== null && view.accounts > 0 && (
          <div className={styles.stat}>
            <p className={styles.label}>{t('quota_summary.on_demand')}</p>
            <p className={styles.secondaryValue}>{formatCursorUsd(view.onDemandUsd)}</p>
          </div>
        )}
        <div className={`${styles.stat} ${styles.reset}`}>
          <p className={styles.label}>{t('quota_summary.next_reset')}</p>
          <p className={styles.secondaryValue}>{resetText}</p>
        </div>
      </div>

      {view.accounts > 0 && (
        <>
          <div
            className={styles.bar}
            role="img"
            aria-label={view.segments.map(segmentTitle).join(', ')}
          >
            {view.segments.map((segment) =>
              segment.widthPercent > 0 ? (
                <span
                  key={segment.authIndex}
                  className={styles.segment}
                  data-slot={segment.slot}
                  style={{ width: `${segment.widthPercent}%` } as CSSProperties}
                  title={segmentTitle(segment)}
                />
              ) : null
            )}
            <span className={styles.rest} />
          </div>
          <ul className={styles.legend}>
            {view.segments.map((segment) => (
              <li key={segment.authIndex} className={styles.legendItem}>
                <span className={styles.swatch} data-slot={segment.slot} aria-hidden="true" />
                <span className={styles.legendName}>{accountLabel(segment)}</span>
                <span className={styles.legendValue}>{segment.percent}%</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {notLoaded > 0 && (
        <p className={styles.note}>{t('quota_summary.not_loaded', { count: notLoaded })}</p>
      )}
    </section>
  );
}
