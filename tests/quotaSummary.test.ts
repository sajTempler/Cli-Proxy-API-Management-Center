/**
 * Provider summary card: normalization of the `summary` block of
 * GET /v8/management/quota/{claude,cursor} and the card built from it.
 * Claude counts REMAINING weekly quota; Cursor counts USED included quota,
 * like its card.
 */

import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { apiClient } from '@/services/api/client';
import { normalizeQuotaSummary, quotaSummaryApi } from '@/services/api/quotaSummary';
import {
  QUOTA_SUMMARY_SLOT_COUNT,
  buildQuotaSummaryView,
  isQuotaSummaryProvider,
} from '@/features/quota/summary';
import { QuotaSummaryCard } from '@/features/quota/components/QuotaSummaryCard';
import claudeFixture from './fixtures/claude-quota-summary.json';
import cursorFixture from './fixtures/cursor-quota.json';

const NOW = Date.parse('2026-10-21T04:00:00Z');
const label = (segment: { email: string; name: string }) => segment.email || segment.name;

describe('normalizeQuotaSummary', () => {
  test('reads the Claude weekly keys and names segments from credentials', () => {
    const summary = normalizeQuotaSummary('claude', claudeFixture);
    expect(summary).toMatchObject({
      credentials: 6,
      loaded: 5,
      window: 'seven_day',
      remainingPercentSum: 409,
      capacityPercent: 500,
      nextResetAt: '2026-10-22T04:00:00Z',
      onDemandUsedUsdSum: null,
    });
    expect(summary.segments).toHaveLength(5);
    expect(summary.segments[0]).toEqual({
      authIndex: 'a1',
      remainingPercent: 100,
      name: 'claude-a1.json',
      email: 'one@example.com',
    });
  });

  test('reads the Cursor keys, including on-demand spend', () => {
    const summary = normalizeQuotaSummary('cursor', cursorFixture);
    expect(summary).toMatchObject({
      credentials: 3,
      loaded: 1,
      window: 'included',
      remainingPercentSum: 77.41,
      capacityPercent: 100,
      onDemandUsedUsdSum: 117.87,
      nextResetAt: '2026-10-30T22:31:53Z',
    });
    expect(summary.segments).toEqual([
      {
        authIndex: '3',
        remainingPercent: 77.41,
        name: 'cursor-user@example.com.json',
        email: 'user@example.com',
      },
    ]);
  });

  test('degrades an unknown payload to an empty summary', () => {
    expect(normalizeQuotaSummary('claude', null)).toEqual({
      credentials: 0,
      loaded: 0,
      window: '',
      remainingPercentSum: 0,
      capacityPercent: 0,
      segments: [],
      nextResetAt: null,
      onDemandUsedUsdSum: null,
    });
  });

  test('get() reads the provider endpoint', async () => {
    const spy = spyOn(apiClient, 'get').mockResolvedValue(claudeFixture as never);
    try {
      const summary = await quotaSummaryApi.get('claude');
      expect(spy).toHaveBeenCalledWith('/quota/claude');
      expect(summary.capacityPercent).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('buildQuotaSummaryView', () => {
  test('Claude sums remaining weekly quota, one slot per account', () => {
    const view = buildQuotaSummaryView('claude', normalizeQuotaSummary('claude', claudeFixture));
    expect(view.measure).toBe('remaining');
    expect(view.windowLabelKey).toBe('claude_quota.seven_day');
    expect(view.totalPercent).toBe(409);
    expect(view.capacityPercent).toBe(500);
    expect(view.accounts).toBe(5);
    expect(view.credentials).toBe(6);
    expect(view.segments.map((segment) => segment.widthPercent)).toEqual([20, 19, 17.6, 14, 11.2]);
    expect(view.segments.map((segment) => segment.slot)).toEqual([1, 2, 3, 4, 5]);
    expect(view.nextResetMs).toBe(Date.parse('2026-10-22T04:00:00Z'));
  });

  test('Cursor shows the share used, rounded like its card', () => {
    const view = buildQuotaSummaryView('cursor', normalizeQuotaSummary('cursor', cursorFixture));
    expect(view.measure).toBe('used');
    expect(view.windowLabelKey).toBe('cursor_quota.included');
    expect(view.totalPercent).toBe(23);
    expect(view.segments[0]).toMatchObject({ percent: 23, widthPercent: 22.59, slot: 1 });
    expect(view.onDemandUsd).toBe(117.87);
    expect(view.nextResetMs).toBe(Date.parse('2026-10-30T22:31:53Z'));
  });

  test('a single Fable account fills its own pool', () => {
    const view = buildQuotaSummaryView('claude', {
      credentials: 1,
      loaded: 1,
      window: 'seven_day_fable',
      remainingPercentSum: 53,
      capacityPercent: 100,
      segments: [{ authIndex: 'x', remainingPercent: 53, name: 'x.json', email: '' }],
      nextResetAt: null,
      onDemandUsedUsdSum: null,
    });
    expect(view.windowLabelKey).toBe('claude_quota.seven_day_fable');
    expect(
      buildQuotaSummaryView('claude', {
        ...normalizeQuotaSummary('claude', claudeFixture),
        nextResetAt: '2026-10-22T03:59:59.713998Z',
      }).nextResetMs
    ).toBe(Date.parse('2026-10-22T04:00:00Z'));
    expect(view.totalPercent).toBe(53);
    expect(view.segments[0].widthPercent).toBe(53);
    expect(view.nextResetMs).toBeNull();
  });

  test('accounts past the palette share the neutral slot instead of cycling', () => {
    const segments = Array.from({ length: QUOTA_SUMMARY_SLOT_COUNT + 2 }, (_, index) => ({
      authIndex: String(index),
      remainingPercent: 100,
      name: '',
      email: '',
    }));
    const view = buildQuotaSummaryView('claude', {
      credentials: segments.length,
      loaded: segments.length,
      window: 'seven_day',
      remainingPercentSum: segments.length * 100,
      capacityPercent: segments.length * 100,
      segments,
      nextResetAt: null,
      onDemandUsedUsdSum: null,
    });
    expect(view.segments.slice(-3).map((segment) => segment.slot)).toEqual([8, 0, 0]);
    const width = view.segments.reduce((sum, segment) => sum + segment.widthPercent, 0);
    expect(width).toBeCloseTo(100, 5);
  });

  test('only Claude and Cursor have a summary', () => {
    expect(isQuotaSummaryProvider('claude')).toBe(true);
    expect(isQuotaSummaryProvider('cursor')).toBe(true);
    expect(isQuotaSummaryProvider('codex')).toBe(false);
    expect(isQuotaSummaryProvider('all')).toBe(false);
  });
});

describe('QuotaSummaryCard', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  const render = (provider: 'claude' | 'cursor', fixture: unknown) =>
    renderToStaticMarkup(
      createElement(QuotaSummaryCard, {
        provider,
        summary: normalizeQuotaSummary(provider, fixture),
        loading: false,
        now: NOW,
        accountLabel: label,
      })
    );

  test('Claude: remaining sum, capacity, accounts, next reset, one segment each', () => {
    const html = render('claude', claudeFixture);
    expect(html).toContain('Weekly remaining · 7-day limit');
    expect(html).toContain('409%');
    expect(html).toContain('of 500% across 5 accounts');
    expect(html).toContain('in 1 day');
    expect(html).toContain('1 account not polled yet');
    expect(html.match(/data-slot="\d"/g)?.length).toBe(10); // 5 segments + 5 swatches
    expect(html).toContain('title="one@example.com: 100% remaining"');
    expect(html).toContain('claude-a3.json');
  });

  test('Cursor: used share, on-demand spend, singular account', () => {
    const html = render('cursor', cursorFixture);
    expect(html).toContain('Included usage');
    expect(html).toContain('23%');
    expect(html).toContain('used of 100% across 1 account');
    expect(html).toContain('$117.87');
    expect(html).toContain('title="user@example.com: 23% used"');
    expect(html).toContain('2 accounts not polled yet');
  });

  test('no summary yet: a skeleton while loading, nothing otherwise', () => {
    const props = { provider: 'claude' as const, summary: null, now: NOW, accountLabel: label };
    expect(
      renderToStaticMarkup(createElement(QuotaSummaryCard, { ...props, loading: false }))
    ).toBe('');
    expect(
      renderToStaticMarkup(createElement(QuotaSummaryCard, { ...props, loading: true }))
    ).not.toBe('');
  });

  test('every locale has the summary strings', () => {
    for (const language of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const fixed = i18n.getFixedT(language);
      for (const key of ['title_remaining', 'title_used', 'next_reset', 'no_reset', 'on_demand']) {
        expect(i18n.exists(`quota_summary.${key}`, { lng: language })).toBe(true);
      }
      expect(fixed('quota_summary.of_capacity_used', { capacity: 100, count: 2 })).not.toContain(
        'quota_summary'
      );
    }
  });
});
