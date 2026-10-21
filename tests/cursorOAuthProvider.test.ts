/**
 * Cursor login on the OAuth page: backend v8 `GET /oauth/auth-url?provider=cursor`
 * (CLIProxyAPI internal/api/handlers/management/auth_files_cursor_oauth.go)
 * returns `{ url, state, flow: "device", expires_in }` with no user code; the
 * backend polls Cursor and the panel follows `/oauth/status`. No callback step.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { OAuthFlowDialog } from '@/features/oauth/components/OAuthFlowDialog';
import { OAUTH_PROVIDERS, supportsManualCallback } from '@/features/oauth/providers';
import { apiClient } from '@/services/api/client';
import { oauthApi } from '@/services/api/oauth';

const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } } });

const LOGIN_URL = 'https://cursor.com/loginDeepControl?challenge=fixture&uuid=fixture&mode=login';

describe('Cursor OAuth login', () => {
  test('starts the backend cursor flow without the web-UI callback flag', async () => {
    const response = { status: 'ok', url: LOGIN_URL, state: 'cursor-1', flow: 'device' };
    const get = spyOn(apiClient, 'get').mockResolvedValue(response);
    try {
      expect(await oauthApi.startAuth('cursor')).toEqual(response);
      expect(get).toHaveBeenLastCalledWith('/oauth/auth-url', { params: { provider: 'cursor' } });
    } finally {
      get.mockRestore();
    }
  });

  test('cancels through the shared session endpoint', async () => {
    const del = spyOn(apiClient, 'delete').mockResolvedValue({ status: 'ok', cancelled: true });
    try {
      await oauthApi.cancelSession('cursor-1');
      expect(del).toHaveBeenLastCalledWith('/oauth/session', { params: { state: 'cursor-1' } });
    } finally {
      del.mockRestore();
    }
  });

  test('is a built-in tile with no manual callback', () => {
    const cursor = OAUTH_PROVIDERS.find((provider) => provider.id === 'cursor');
    expect(cursor).toMatchObject({ kind: 'builtin', label: 'Cursor', flow: 'browser' });
    expect(cursor && supportsManualCallback(cursor)).toBe(false);
  });

  test('the dialog shows the login link and no device-code or callback step', () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(OAuthFlowDialog, {
          open: true,
          providerId: 'cursor',
          heading: { title: en.auth_login.cursor_oauth_title, caption: 'Browser', icon: '' },
          state: { status: 'waiting', url: LOGIN_URL, state: 'cursor-1' },
          text: (suffix: string) => i18n.t(`auth_login.cursor_${suffix}`),
          supportsCallback: false,
          onStart: () => {},
          onCancel: () => {},
          onCallbackChange: () => {},
          onCallbackSubmit: () => {},
          onViewAuthFiles: () => {},
          onClose: () => {},
        })
      )
    );
    expect(markup).toContain('cursor.com');
    expect(markup).toContain(en.auth_login.cursor_open_link);
    expect(markup).toContain(en.auth_login.cursor_oauth_status_waiting);
    expect(markup).not.toContain(en.auth_login.step_enter_device_code);
    expect(markup).not.toContain(en.auth_login.oauth_callback_label);
    expect(markup).not.toContain('auth_login.');
  });

  test('every locale has the cursor login strings', () => {
    for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      const translations = JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8'));
      for (const suffix of [
        'oauth_title',
        'oauth_button',
        'oauth_hint',
        'open_link',
        'copy_link',
        'oauth_status_waiting',
        'oauth_status_success',
        'oauth_status_error',
        'oauth_start_error',
        'oauth_polling_error',
      ]) {
        expect(translations.auth_login[`cursor_${suffix}`]).toBeTruthy();
      }
    }
  });
});
