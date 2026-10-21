/**
 * Cursor card: the agent CLI's `/usage` view. Included with its Auto and API
 * buckets, On-Demand spend, plan, and the billing-cycle reset.
 *
 * Unlike the other bodies, bars here fill with the share USED, because that is
 * how Cursor reports and draws them; the colour still follows what is left.
 */

import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { CursorOnDemand, CursorQuotaState } from '@/types';
import { formatRelativeInstant, parseIsoToMs } from '@/utils/quota';
import { useNow } from '@/hooks/useNow';
import {
  QUOTA_PROGRESS_HIGH_THRESHOLD,
  QUOTA_PROGRESS_MEDIUM_THRESHOLD,
} from '../../components/QuotaMeter';
import { collectQuotaRowInstants, pickUrgentRowId } from '../../resetSchedule';
import type { QuotaBodyProps, QuotaClassMap } from '../../types';
import {
  cursorPollErrorMessage,
  formatCursorPercent,
  formatCursorResetDate,
  formatCursorUsd,
} from './data';

/** Auto and API sit under Included, as in the CLI. */
const SUB_ROW_STYLE: CSSProperties = { paddingInlineStart: 14 };

function UsedMeter({
  usedPercent,
  classes,
  index,
}: {
  usedPercent: number | null;
  classes: QuotaClassMap;
  index: number;
}) {
  const used = usedPercent === null ? 0 : Math.min(100, Math.max(0, usedPercent));
  const remaining = 100 - used;
  const fillClass =
    remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
      ? classes.quotaBarFillHigh
      : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
        ? classes.quotaBarFillMedium
        : classes.quotaBarFillLow;
  const style = {
    width: `${Math.round(used * 100) / 100}%`,
    '--meter-index': index,
  } as CSSProperties;
  return (
    <div className={classes.quotaBar}>
      <div className={`${classes.quotaBarFill} ${fillClass}`} style={style} />
    </div>
  );
}

/** Header value and detail line for On-Demand, per the contract's CLI rendering rules. */
function describeOnDemand(
  onDemand: CursorOnDemand,
  t: (key: string, params?: Record<string, string>) => string
): { value: string; detail: string | null } {
  const used = formatCursorUsd(onDemand.usedUsd);
  if (onDemand.limitKind === 'fixed' && onDemand.limitUsd !== null) {
    return {
      value: `${used} / ${formatCursorUsd(onDemand.limitUsd)}`,
      detail:
        onDemand.remainingUsd === null
          ? null
          : t('cursor_quota.on_demand_remaining', {
              amount: formatCursorUsd(onDemand.remainingUsd),
            }),
    };
  }
  if (onDemand.limitKind === 'unlimited') {
    return {
      value: used,
      detail:
        onDemand.limitScope === 'team_member'
          ? t('cursor_quota.on_demand_no_personal_limit')
          : onDemand.limitScope === 'personal'
            ? t('cursor_quota.on_demand_no_monthly_limit')
            : null,
    };
  }
  if (onDemand.usedUsd > 0) return { value: used, detail: null };
  return {
    value: t(
      onDemand.limitKind === 'disabled'
        ? 'cursor_quota.on_demand_disabled'
        : 'cursor_quota.on_demand_unavailable'
    ),
    detail: null,
  };
}

export function CursorQuotaBody({ quota, classes }: QuotaBodyProps<CursorQuotaState>) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const language = i18n.resolvedLanguage;
  const urgentRowId = useMemo(
    () => pickUrgentRowId(collectQuotaRowInstants('cursor', quota), now),
    [quota, now]
  );

  const windows = quota.windows ?? [];
  const onDemand = quota.onDemand ?? null;
  const plan = quota.plan ?? null;
  const pollError = quota.pollError?.trim() ?? '';
  const hasData = windows.length > 0 || onDemand !== null;
  const pollErrorMessage = pollError ? cursorPollErrorMessage(pollError) : null;
  const pollErrorText = pollErrorMessage ? t(pollErrorMessage.key, pollErrorMessage.params) : '';

  const resetDate = formatCursorResetDate(quota.resetsAt, language);
  const resetMs = parseIsoToMs(quota.resetsAt);
  const resetRelative =
    resetMs !== null && resetMs > now ? formatRelativeInstant(resetMs, now, language) : null;
  const bonusUsd = quota.extra?.bonusUsd ?? null;

  const onDemandView = onDemand
    ? describeOnDemand(onDemand, (key, params) => t(key, params ?? {}))
    : null;

  return (
    <>
      {plan && (
        <div className={classes.codexPlan}>
          <span className={classes.codexPlanItem}>
            <span className={classes.codexPlanLabel}>{t('cursor_quota.plan_label')}</span>
            <span className={classes.codexPlanValue}>{plan.label}</span>
            {plan.price && (
              // The chip capitalizes plan names; a price like "$40/mo" must stay as sent.
              <span className={classes.codexPlanValue} style={{ textTransform: 'none' }}>
                · {plan.price}
              </span>
            )}
          </span>
        </div>
      )}

      {pollErrorText && hasData && (
        <div role="status" className={classes.codexResetCreditsError}>
          {t('cursor_quota.stale_snapshot', {
            reason: pollErrorText,
            time: quota.lastPollAt ? new Date(quota.lastPollAt).toLocaleString(language) : '--',
          })}
        </div>
      )}

      {!hasData && (
        <div className={classes.quotaMessage}>{pollErrorText || t('cursor_quota.not_polled')}</div>
      )}

      {windows.map((window, index) => {
        const isSub = window.id !== 'included';
        return (
          <div
            key={window.id}
            className={classes.quotaRow}
            style={isSub ? SUB_ROW_STYLE : undefined}
          >
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{t(window.labelKey)}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {t('cursor_quota.used_percent', {
                    percent: formatCursorPercent(window.usedPercent),
                  })}
                </span>
              </div>
            </div>
            <UsedMeter usedPercent={window.usedPercent} classes={classes} index={index} />
            {!isSub && bonusUsd !== null && bonusUsd > 0 && (
              <div className={classes.quotaAmount}>
                {t('cursor_quota.bonus', { amount: formatCursorUsd(bonusUsd) })}
              </div>
            )}
          </div>
        );
      })}

      {onDemand && onDemandView && (
        <div className={classes.quotaRow}>
          <div className={classes.quotaRowHeader}>
            <span className={classes.quotaModel}>{t('cursor_quota.on_demand')}</span>
            <div className={classes.quotaMeta}>
              <span className={classes.quotaPercent}>{onDemandView.value}</span>
            </div>
          </div>
          {onDemand.limitKind === 'fixed' && (
            <UsedMeter
              usedPercent={onDemand.usedPercent}
              classes={classes}
              index={windows.length}
            />
          )}
          {onDemandView.detail && <div className={classes.quotaAmount}>{onDemandView.detail}</div>}
        </div>
      )}

      {hasData && resetDate && (
        <div className={classes.quotaMeta}>
          <span className={classes.quotaReset}>
            {t('cursor_quota.resets', { date: resetDate })}
          </span>
          {resetRelative && (
            <span
              className={
                urgentRowId
                  ? `${classes.quotaResetRelative} ${classes.quotaResetRelativeSoon}`
                  : classes.quotaResetRelative
              }
            >
              {resetRelative}
            </span>
          )}
        </div>
      )}
    </>
  );
}
