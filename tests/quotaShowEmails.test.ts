/**
 * "Show emails" on the Quota page: masked by default on cards, timeline and
 * summary; search still matches full values; the choice persists per browser.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import {
  QUOTA_SHOW_EMAILS_KEY,
  formatAccountName,
  maskEmails,
  readShowEmails,
  writeShowEmails,
} from '@/features/quota/privacy';
import { QuotaHeader } from '@/features/quota/components/QuotaHeader';
import { QuotaTimeline } from '@/features/quota/components/QuotaTimeline';
import { filterEntriesBySearch, type QuotaFileEntry } from '@/features/quota/logic';

const FILE = 'claude-90b1d5e2-someone@example.com.json';
const MASKED = 'claude-90b1d5e2-s•••@e•••.com.json';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let values: Map<string, string>;

beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
});

afterEach(() => {
  writeShowEmails(false);
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('maskEmails', () => {
  test('masks the email inside a credential file name, keeping the prefix', () => {
    expect(maskEmails(FILE)).toBe(MASKED);
  });

  test('masks plain emails and every email in a label', () => {
    expect(maskEmails('first.last@corp.example.org')).toBe('f•••@c•••.example.org');
    expect(maskEmails('a@b.io · c@d.io')).toBe('a•••@b•••.io · c•••@d•••.io');
  });

  test('leaves names without an email alone', () => {
    expect(maskEmails('codex-team.json')).toBe('codex-team.json');
    expect(maskEmails('')).toBe('');
  });
});

describe('show-emails preference', () => {
  test('defaults to masked and persists the choice in localStorage', () => {
    expect(readShowEmails()).toBe(false);
    expect(formatAccountName(FILE)).toBe(MASKED);
    writeShowEmails(true);
    expect(values.get(QUOTA_SHOW_EMAILS_KEY)).toBe('true');
    expect(readShowEmails()).toBe(true);
    expect(formatAccountName(FILE)).toBe(FILE);
    writeShowEmails(false);
    expect(readShowEmails()).toBe(false);
  });

  test('unreadable storage falls back to masked', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => {},
      },
    });
    expect(readShowEmails()).toBe(false);
    expect(() => writeShowEmails(true)).not.toThrow();
  });
});

describe('Quota page rendering', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  const entry: QuotaFileEntry = {
    file: { name: FILE, type: 'claude', email: 'someone@example.com' },
    type: 'claude',
  };

  test('header toggle reports its state', () => {
    const props = {
      totalCount: 1,
      loadedCount: 0,
      attentionCount: 0,
      refreshing: false,
      disableControls: false,
      onRefreshAll: () => {},
      onShowEmailsChange: () => {},
    };
    const off = renderToStaticMarkup(createElement(QuotaHeader, { ...props, showEmails: false }));
    expect(off).toContain('aria-pressed="false"');
    expect(off).toContain('Show emails');
    const on = renderToStaticMarkup(createElement(QuotaHeader, { ...props, showEmails: true }));
    expect(on).toContain('aria-pressed="true"');
  });

  test('card head and page wiring pass names through the formatter (source contract)', async () => {
    // QuotaCard binds SCSS module classes at import, which bun:test cannot load.
    const card = await Bun.file('src/features/quota/components/QuotaCard.tsx').text();
    expect(card).toContain('formatName(getQuotaDisplayName(file))');
    const page = await Bun.file('src/features/quota/QuotaPage.tsx').text();
    expect(page).toContain('formatName={formatName}');
    expect(page).toContain('displayNameFor={formatName}');
    expect(page).toMatch(/formatName\(segment\.email/);
  });

  test('timeline lanes use the formatted name', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaTimeline, {
        entries: [entry],
        displayNameFor: maskEmails,
        resolvedTheme: 'light',
        now: Date.parse('2026-10-21T12:00:00Z'),
        quotaFor: () => ({
          status: 'success',
          windows: [
            {
              id: 'seven_day',
              label: '7-day',
              usedPercent: 25,
              resetAtMs: Date.parse('2026-10-24T12:00:00Z'),
              periodHours: 168,
            },
          ],
        }),
      } as never)
    );
    expect(html).toContain(MASKED);
    expect(html).not.toContain('someone@');
  });

  test('search still matches the full email while names are masked', () => {
    expect(filterEntriesBySearch([entry], 'someone@example')).toHaveLength(1);
    expect(filterEntriesBySearch([entry], 's•••')).toHaveLength(0);
  });
});
