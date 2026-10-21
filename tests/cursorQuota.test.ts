/**
 * Cursor quota: normalization of GET /v8/management/quota/cursor and the card
 * state built from it. The fixture follows CLIProxyAPI
 * docs/cursor/USAGE-TRACKING.md section 5 (the live example plus a never-polled
 * and a team-member entry).
 */

import { afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import { cursorQuotaApi, normalizeCursorQuotaResponse } from '@/services/api/cursorQuota';
import {
  CURSOR_CONFIG,
  CURSOR_DEFAULT_PERIOD_HOURS,
  buildCursorQuotaData,
  cursorPollErrorMessage,
  findCursorQuotaEntry,
  formatCursorPercent,
  formatCursorResetDate,
  formatCursorUsd,
} from '@/features/quota/providers/cursor/data';
import { CursorQuotaBody } from '@/features/quota/providers/cursor/CursorQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { buildTimelineLane } from '@/features/quota/quotaTimelineModel';
import { QuotaTimeline } from '@/features/quota/components/QuotaTimeline';
import { collectQuotaRowInstants } from '@/features/quota/resetSchedule';
import type { AuthFileItem, CursorQuotaState } from '@/types';
import fixture from './fixtures/cursor-quota.json';

const t = ((key: string) => key) as unknown as TFunction;
const response = normalizeCursorQuotaResponse(fixture);
const [live, expired, member] = response.credentials;
const RESET = '2026-10-30T22:31:53Z';

const statusError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const cursorFile = (extra: Partial<AuthFileItem> = {}): AuthFileItem =>
  ({
    name: 'cursor-user@example.com.json',
    type: 'cursor',
    provider: 'cursor',
    auth_index: '3',
    ...extra,
  }) as AuthFileItem;

describe('normalizeCursorQuotaResponse', () => {
  test('maps the contract example to camelCase without rounding', () => {
    expect(response.generatedAt).toBe('2026-10-21T09:00:00Z');
    expect(response.refreshIntervalSeconds).toBe(900);
    expect(response.credentials).toHaveLength(3);
    expect(live).toMatchObject({
      authIndex: '3',
      name: 'cursor-user@example.com.json',
      email: 'user@example.com',
      plan: { label: 'Team', price: '$40/mo' },
      included: { usedPercent: 22.5864, remainingPercent: 77.4136, resetsAt: RESET },
      includedAuto: { usedPercent: 7.8114 },
      includedApi: { usedPercent: 100, remainingPercent: 0 },
      onDemand: {
        limitKind: 'fixed',
        usedUsd: 117.87,
        limitUsd: 400,
        remainingUsd: 282.13,
        usedPercent: 29.4675,
      },
      extra: {
        billingCycleStart: '2026-09-30T22:31:53Z',
        bonusUsd: 262.33,
        autoBucketModels: ['default', 'composer-2'],
      },
      pollError: '',
    });
  });

  test('keeps null windows and the poll error of a never-polled entry', () => {
    expect(expired).toMatchObject({
      authIndex: '4',
      plan: null,
      included: null,
      includedAuto: null,
      includedApi: null,
      onDemand: null,
      extra: null,
      lastPollAt: null,
      pollError: 'token_expired',
    });
  });

  test('limit, remaining and percent are numbers only for a fixed limit', () => {
    expect(member.onDemand).toMatchObject({
      limitKind: 'unlimited',
      limitScope: 'team_member',
      usedUsd: 0,
      limitUsd: null,
      remainingUsd: null,
      usedPercent: null,
    });
    const odd = normalizeCursorQuotaResponse({
      credentials: [
        {
          auth_index: 9,
          windows: { on_demand: { limit_kind: 'surprise', used_usd: 3, limit_usd: 10 } },
        },
      ],
    }).credentials[0];
    expect(odd.authIndex).toBe('9');
    expect(odd.onDemand).toMatchObject({ limitKind: 'unavailable', usedUsd: 3, limitUsd: null });
  });

  test('drops entries without auth_index and tolerates non-object payloads', () => {
    expect(
      normalizeCursorQuotaResponse({ credentials: [{ name: 'x' }, null, 3] }).credentials
    ).toEqual([]);
    expect(normalizeCursorQuotaResponse('404 page not found').credentials).toEqual([]);
    expect(normalizeCursorQuotaResponse(null)).toEqual({
      generatedAt: null,
      refreshIntervalSeconds: null,
      credentials: [],
    });
  });
});

describe('Cursor display rules', () => {
  test('percent renders like the CLI: rounded, clamped, (0,1) shows 1', () => {
    expect(formatCursorPercent(22.5864)).toBe(23);
    expect(formatCursorPercent(7.8114)).toBe(8);
    expect(formatCursorPercent(0.4)).toBe(1);
    expect(formatCursorPercent(0)).toBe(0);
    expect(formatCursorPercent(104.2)).toBe(100);
    expect(formatCursorPercent(-3)).toBe(0);
  });

  test('dollars use 0 decimals when integral, else 2', () => {
    expect(formatCursorUsd(400)).toBe('$400');
    expect(formatCursorUsd(117.87)).toBe('$117.87');
    expect(formatCursorUsd(282.1)).toBe('$282.10');
    expect(formatCursorUsd(0)).toBe('$0');
  });

  test('reset date is MMM d in UTC', () => {
    expect(formatCursorResetDate(RESET, 'en')).toBe('Oct 30');
    // 00:30 UTC on the 31st is still the 30th in the Americas; UTC wins.
    expect(formatCursorResetDate('2026-10-31T00:30:00Z', 'en')).toBe('Oct 31');
    expect(formatCursorResetDate(null, 'en')).toBe('');
  });

  test('poll error codes map to messages; unknown codes keep the raw code', () => {
    expect(cursorPollErrorMessage('token_expired').key).toBe(
      'cursor_quota.poll_error_token_expired'
    );
    expect(cursorPollErrorMessage('rate_limited (403)').key).toBe(
      'cursor_quota.poll_error_rate_limited'
    );
    expect(cursorPollErrorMessage('http_502')).toEqual({
      key: 'cursor_quota.poll_error_other',
      params: { code: 'http_502' },
    });
  });
});

describe('buildCursorQuotaData', () => {
  test('lists Included, Auto, API with the billing cycle as the period', () => {
    const data = buildCursorQuotaData(live, t);
    expect(data.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['included', 22.5864],
      ['included_auto', 7.8114],
      ['included_api', 100],
    ]);
    expect(data.windows[0]).toMatchObject({
      labelKey: 'cursor_quota.included',
      label: 'cursor_quota.included',
      resetAtMs: Date.parse(RESET),
      periodHours: 720,
    });
    expect(data).toMatchObject({
      resetsAt: RESET,
      plan: { label: 'Team' },
      onDemand: { limitKind: 'fixed', limitUsd: 400 },
      pollError: '',
    });
  });

  test('a never-polled entry has no windows and keeps its poll error', () => {
    const data = buildCursorQuotaData(expired, t);
    expect(data.windows).toEqual([]);
    expect(data.onDemand).toBeNull();
    expect(data.resetsAt).toBeNull();
    expect(data.pollError).toBe('token_expired');
  });

  test('without a cycle start or reset the period falls back to 30 days', () => {
    const data = buildCursorQuotaData(member, t);
    expect(data.windows[0]).toMatchObject({
      resetAtMs: null,
      periodHours: CURSOR_DEFAULT_PERIOD_HOURS,
    });
  });
});

describe('credential matching and classification', () => {
  test('matches by auth_index, then by file name', () => {
    expect(findCursorQuotaEntry(response.credentials, cursorFile())?.authIndex).toBe('3');
    expect(
      findCursorQuotaEntry(response.credentials, cursorFile({ auth_index: '5', name: 'x' }))
        ?.authIndex
    ).toBe('5');
    expect(
      findCursorQuotaEntry(
        response.credentials,
        cursorFile({ auth_index: undefined, name: 'cursor-expired@example.com.json' })
      )?.authIndex
    ).toBe('4');
    expect(
      findCursorQuotaEntry(response.credentials, cursorFile({ auth_index: '99', name: 'y' }))
    ).toBeUndefined();
  });

  test('cursor credentials get a Cursor card; disabled ones do not', () => {
    const entries = classifyQuotaFiles([
      cursorFile(),
      cursorFile({ name: 'off.json', disabled: true }),
      { name: 'claude.json', provider: 'claude' } as AuthFileItem,
    ]);
    expect(entries.map((entry) => [entry.file.name, entry.type])).toEqual([
      ['claude.json', 'claude'],
      ['cursor-user@example.com.json', 'cursor'],
    ]);
  });
});

describe('CURSOR_CONFIG.fetchQuota', () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  test('refreshes the one credential and builds its state', async () => {
    const refresh = spyOn(cursorQuotaApi, 'refresh').mockResolvedValue([live]);
    const get = spyOn(cursorQuotaApi, 'get');
    spies.push(refresh, get);
    const data = await CURSOR_CONFIG.fetchQuota(cursorFile(), t);
    expect(refresh).toHaveBeenCalledWith('3');
    expect(get).not.toHaveBeenCalled();
    expect(CURSOR_CONFIG.buildSuccessState(data)).toMatchObject({
      status: 'success',
      windows: [{ id: 'included' }, { id: 'included_auto' }, { id: 'included_api' }],
    });
  });

  for (const status of [404, 429, 503]) {
    test(`refresh ${status} falls back to the poller snapshot`, async () => {
      spies.push(
        spyOn(cursorQuotaApi, 'refresh').mockRejectedValue(statusError(status)),
        spyOn(cursorQuotaApi, 'get').mockResolvedValue(response)
      );
      const data = await CURSOR_CONFIG.fetchQuota(cursorFile(), t);
      expect(data.windows[0].usedPercent).toBe(22.5864);
    });
  }

  test('an entry with no data and a poll error is an error card', async () => {
    spies.push(spyOn(cursorQuotaApi, 'refresh').mockResolvedValue([expired]));
    await expect(CURSOR_CONFIG.fetchQuota(cursorFile({ auth_index: '4' }), t)).rejects.toThrow(
      'cursor_quota.poll_error_token_expired'
    );
  });

  test('a missing endpoint surfaces as a 404 error (the update-required message)', async () => {
    spies.push(
      spyOn(cursorQuotaApi, 'refresh').mockRejectedValue(statusError(404)),
      spyOn(cursorQuotaApi, 'get').mockRejectedValue(statusError(404))
    );
    await expect(CURSOR_CONFIG.fetchQuota(cursorFile(), t)).rejects.toMatchObject({
      status: 404,
    });
  });

  test('other refresh failures are errors, and untracked credentials say so', async () => {
    spies.push(spyOn(cursorQuotaApi, 'refresh').mockRejectedValue(statusError(500)));
    await expect(CURSOR_CONFIG.fetchQuota(cursorFile(), t)).rejects.toMatchObject({
      status: 500,
    });
    spies.splice(0).forEach((spy) => spy.mockRestore());

    spies.push(
      spyOn(cursorQuotaApi, 'refresh').mockResolvedValue([]),
      spyOn(cursorQuotaApi, 'get').mockResolvedValue({ ...response, credentials: [] })
    );
    await expect(CURSOR_CONFIG.fetchQuota(cursorFile(), t)).rejects.toThrow(
      'cursor_quota.not_tracked'
    );
  });
});

describe('Cursor in the timeline and recovery ordering', () => {
  const state = CURSOR_CONFIG.buildSuccessState(buildCursorQuotaData(live, t));

  test('the lane is the monthly billing cycle of the Included window', () => {
    const lane = buildTimelineLane({
      name: 'c',
      displayName: 'c',
      provider: 'cursor',
      quota: state,
      maxPeriodHours: 14 * 24,
    });
    expect(lane.anchorMs).toBe(Date.parse(RESET));
    expect(lane.periodHours).toBe(720);
    expect(lane.remaining).toBe(77);
    // The lane displays USED, like the card (23% / 8% / 100%), not remaining.
    expect(lane.used).toBe(23);
    expect(lane.limits.map((limit) => limit.used)).toEqual([23, 8, 100]);
  });

  test('the timeline labels the bar and pills with the used share', async () => {
    await i18n.changeLanguage('en');
    const html = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        entries: [{ file: cursorFile(), type: 'cursor' }],
        quotaFor: () => state,
        displayNameFor: (name: string) => name,
        resolvedTheme: 'light',
        now: Date.parse('2026-10-21T09:00:00Z'),
      })
    );
    expect(html).toMatch(/<b>23% used<\/b>/);
    expect(html).toMatch(/<b>8% used<\/b>/);
    expect(html).toMatch(/<b>100% used<\/b>/);
    expect(html).toMatch(/<span style="width:23%"><\/span><span>23% used · /);
    expect(html).toMatch(/23% used · \d\d\/\d\d \d\d:\d\d/);
    expect(html).not.toMatch(/77% ·|<b>77%<\/b>/);
    expect(html).not.toContain('remaining');
  });

  test('Claude lanes keep showing what remains', () => {
    const lane = buildTimelineLane({
      name: 'a',
      displayName: 'a',
      provider: 'claude',
      quota: {
        status: 'success',
        windows: [
          { label: '7-day', usedPercent: 25, resetAtMs: Date.parse(RESET), periodHours: 168 },
        ],
      },
    });
    expect(lane.remaining).toBe(75);
    expect(lane.used).toBeUndefined();
    expect(lane.limits).toEqual([{ label: '7-day', remaining: 75 }]);
  });

  test('every window reports the cycle end as a recovery instant', () => {
    expect(collectQuotaRowInstants('cursor', state).map((instant) => instant.atMs)).toEqual([
      Date.parse(RESET),
      Date.parse(RESET),
      Date.parse(RESET),
    ]);
  });
});

describe('CursorQuotaBody', () => {
  const classes = bindQuotaClasses(
    Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
    'test-host'
  );
  const render = (quota: CursorQuotaState) =>
    renderToStaticMarkup(createElement(CursorQuotaBody, { quota, classes }));

  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  test('renders the /usage rows with USED percentages', () => {
    const html = render(CURSOR_CONFIG.buildSuccessState(buildCursorQuotaData(live, t)));
    expect(html).toContain('Team');
    expect(html).toContain('· $40/mo');
    expect(html).toContain('Included');
    expect(html).toContain('23% used');
    expect(html).toContain('8% used');
    expect(html).toContain('100% used');
    expect(html).toContain('On-Demand');
    expect(html).toContain('$117.87 / $400');
    expect(html).toContain('$282.13 remaining');
    expect(html).toContain('Resets Oct 30');
    // Bars fill with the used share; a full API bucket is the low (red) tone.
    expect(html).toContain('width:100%');
    expect(html).toMatch(/quotaBarFillLow" style="width:100%/);
  });

  test('team members without a personal limit show only what they spent', () => {
    const html = render(CURSOR_CONFIG.buildSuccessState(buildCursorQuotaData(member, t)));
    expect(html).toContain('1% used');
    expect(html).toContain('$0');
    expect(html).toContain('No personal limit');
    // Stale data stays visible with the poll error as a notice.
    expect(html).toContain('Cursor rate-limited the usage check');
    expect(html).not.toContain('Resets');
  });

  test('a never-polled credential explains why there are no numbers', () => {
    const html = render(CURSOR_CONFIG.buildSuccessState(buildCursorQuotaData(expired, t)));
    expect(html).toContain('Cursor login expired. Log in again.');
    expect(html).not.toContain('Included');
  });
});
