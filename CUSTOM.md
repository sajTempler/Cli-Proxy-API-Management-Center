# Custom fork notes

This fork (`origin` = sajTempler) builds the management panel served by the local CLIProxyAPI.
Shared repository guidance stays in `AGENTS.md`; this file only covers fork-specific workflow.

## Branch model

- `main` tracks `upstream/main` (router-for-me) and carries no local commits. Never commit to it.
- `custom` holds every local change. It was cut from the `v1.26.6` release tag, the release whose
  `management.html` asset (sha256 `46aedbbc…2e63`) the proxy was serving before the switch.

## Build and deploy

```bash
scripts/deploy-local.sh             # bun install --frozen-lockfile, bun run build, install
SKIP_BUILD=1 scripts/deploy-local.sh   # install the existing dist/index.html only
```

The script copies `dist/index.html` to
`/Users/szymon/private/CLIProxyAPI/static/custom/management.html` (override with `PANEL_TARGET`).
It uses the bun version pinned in `package.json`, through `mise exec` when the bun shim has no
default version. The proxy reads the file from disk on each request, so no proxy restart is needed.

Proxy-side wiring (already in place, outside this repo):

- `/Users/szymon/private/CLIProxyAPI/.env`:
  `MANAGEMENT_STATIC_PATH=/Users/szymon/private/CLIProxyAPI/static/custom/management.html`
- `/Users/szymon/private/CLIProxyAPI/config.yaml`: `management.disable-auto-update-panel: true`,
  so the GitHub auto-updater never overwrites the custom build. If the file is missing, the proxy
  still downloads the upstream release into that path on first access; rerun the script afterwards.
- Proxy restarts go through `/Users/szymon/private/CLIProxyAPI/.worktrees/deploy/scripts/deploy-local.sh`
  only. They are needed for `.env` changes, not for panel updates.

To check what is being served:
`curl -s http://127.0.0.1:8317/management.html | shasum -a 256` should match `dist/index.html`.

## Pulling upstream

```bash
git fetch upstream --tags
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout custom && git rebase vX.Y.Z    # or: git merge vX.Y.Z; prefer release tags over main
bun run verify && scripts/deploy-local.sh
git push --force-with-lease origin custom   # only needed after a rebase
```

## Adding a provider quota tab

### Where tabs come from

The Quota page (`/#/quota`) lists one card per credential returned by
`GET /v8/management/credentials` (`authFilesApi.list()` in `src/services/api/authFiles.ts`).
`classifyQuotaFiles` in `src/features/quota/logic.ts` assigns each file to a provider using that
provider's `filterFn`, and each provider found becomes a tab.

| Concern | File |
| --- | --- |
| Tab order and ids | `src/features/quota/constants.ts` (`QUOTA_TAB_ORDER`, `QuotaTabId`) |
| Provider union and store contract | `src/features/quota/providers/types.ts` (`QuotaProviderType`, `QuotaStore`, `QuotaProviderData`) |
| Adapter registry (data + Body) | `src/features/quota/providers/index.ts` (`QUOTA_ADAPTERS`) |
| File → provider classification | `src/features/quota/logic.ts` (`QUOTA_FILTER_MAP`) |
| Per-provider store subscription | `src/features/quota/QuotaPage.tsx` (`quotaByType`) |
| Quota cache | `src/stores/useQuotaStore.ts` |
| State types | `src/types/quota.ts` |
| Card shell, meter, reset label | `src/features/quota/components/{QuotaCard,QuotaMeter,QuotaResetLabel}.tsx` |
| Timeline lanes and reset ordering | `src/features/quota/quotaTimelineModel.ts` (`buildTimelineLane`), `src/features/quota/resetSchedule.ts` (`collectQuotaRowInstants`), `src/features/quota/components/QuotaTimeline.tsx` |
| Tab label and icon | `src/features/authFiles/constants.ts` (`getTypeLabel` → `auth_files.filter_<type>`, `AUTH_FILE_ICONS`), `src/assets/icons/` |
| Strings | `src/i18n/locales/*.json` (all six), under `<provider>_quota.*` |

### How the Claude tab works

- Data: `src/features/quota/providers/claude/data.ts` (`CLAUDE_CONFIG`, `fetchClaudeQuota`,
  `buildClaudeQuotaWindows`), with normalization in `src/services/api/claudeUsage.ts` and the
  constants in `src/utils/quota/constants.ts`.
- Card: `src/features/quota/providers/claude/ClaudeQuotaBody.tsx` (plus `ClaudeResetGrants*.tsx`
  for reset-grant credits).
- Endpoint: the panel does not call `/v8/management/quota/claude`. It calls
  `POST /v8/management/requests/api-call` with
  `{ authIndex, method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage', header }`, so the
  proxy substitutes the credential's token for `$TOKEN$`. The response is
  `{ status_code, header, body }`. `body` is Anthropic's payload:
  `five_hour` / `seven_day` / … `{ utilization, resets_at }`, `extra_usage { is_enabled,
  monthly_limit, used_credits, utilization, currency }`, dollar windows `{ limit_dollars,
  used_dollars, remaining_dollars, utilization, resets_at }`, and `limits[]` (Fable weekly).
  A second api-call to `/api/oauth/profile` resolves the plan badge.
- State (`ClaudeQuotaState`): `windows[] { id, label, labelKey, usedPercent, resetLabel,
  resetAtMs, periodHours }`, `extraUsage`, `dollarWindows`, `planType`, `observedAt`. The timeline
  reads `windows[].resetAtMs` and `periodHours` (5 h session, 168 h weekly).
- The backend's own `GET /v8/management/quota/claude` (deploy/local only) returns
  `{ provider, generated_at, strategy, refresh_interval_seconds, summary, credentials[] }`. Each
  credential has `{ auth_index, name, email, plan, routing, windows: { five_hour | seven_day |
  seven_day_fable: { used_percent, remaining_percent, resets_at, status, observed_at, source } },
  last_poll_at, next_poll_at, poll_error }`. That endpoint, not api-call, is the model for Cursor.

### Minimum change set for a `cursor` tab

The data comes from `GET /v8/management/quota/cursor`, which the backend task will define. A
proposed shape, following `/quota/claude` (snake_case, RFC 3339 UTC, percentages 0–100):

```json
{
  "provider": "cursor",
  "generated_at": "2026-10-21T10:00:00Z",
  "accounts": [{
    "id": "acct-1", "email": "me@example.com", "plan": "pro",
    "resets_at": "2026-11-05T00:00:00Z",
    "included": { "used_percent": 42.0, "auto": { "used_percent": 30.0 }, "api": { "used_percent": 12.0 } },
    "on_demand": { "enabled": true, "spent_cents": 1234, "limit_cents": 5000 },
    "observed_at": "2026-10-21T09:59:00Z", "error": ""
  }]
}
```

1. `src/services/api/cursorQuota.ts`: `getCursorQuota()` using `apiClient.get('/quota/cursor')`,
   normalizing snake_case to camelCase and narrowing `unknown` (same pattern as `claudeUsage.ts`).
   Export it from `src/services/api/index.ts`.
2. `src/types/quota.ts`: `CursorQuotaState { status, windows[] (included, auto, api; periodHours
   = 24 * 30, resetAtMs from resets_at), onDemand { enabled, spentCents, limitCents } | null,
   plan, observedAt, error?, errorStatus? }`.
3. `src/features/quota/providers/types.ts`: add `'cursor'` to `QuotaProviderType`; add
   `cursorQuota` and `setCursorQuota` to `QuotaStore`. Implement both, plus the clear and
   omit paths, in `src/stores/useQuotaStore.ts`.
4. `src/features/quota/providers/cursor/data.ts`: `CURSOR_CONFIG: QuotaProviderData`. Its
   `filterFn` matches `type === 'cursor'`, and `fetchQuota` picks the matching account from the
   endpoint response. Add `cursor/CursorQuotaBody.tsx` with a `QuotaMeter` for Included %, Auto
   and API sub-rows, an On-Demand `$spent / $limit` row, and a `QuotaResetLabel`.
5. Register it in `providers/index.ts` (`QUOTA_ADAPTERS`), `logic.ts` (`QUOTA_FILTER_MAP`),
   `constants.ts` (`QUOTA_TAB_ORDER`), and `QuotaPage.tsx` (`quotaByType` and its dependencies).
6. Entry source: Cursor accounts are not proxy credentials, so `/credentials` never returns them
   and `classifyQuotaFiles` would produce an empty tab. In `QuotaPage.loadFiles`, after
   `authFilesApi.list()`, append synthetic `AuthFileItem`s
   (`{ name: 'cursor:<id>', type: 'cursor', provider: 'cursor', email }`) built from
   `/quota/cursor`. Do this only on success, and keep the existing stale-request guard.
   `fetchQuota` should reuse the response cached for that load rather than refetching per card.
7. Timeline: add `'cursor'` to the `provider === 'claude' || provider === 'codex'` windows branch
   in `quotaTimelineModel.ts` and to the matching branch in `resetSchedule.ts`. Both read
   `windows[].resetAtMs` and `periodHours`.
8. Label and icon: `auth_files.filter_cursor` in all six locales, `src/assets/icons/cursor.svg`,
   and an `AUTH_FILE_ICONS.cursor` entry.
9. i18n: `cursor_quota.{title, empty_title, empty_desc, idle, loading, load_failed, included,
   auto, api, on_demand, on_demand_disabled, reset}` in all six locale files.
10. Tests: `tests/cursorQuota.test.ts` for the normalizer and `CURSOR_CONFIG` state builders
    (follow `tests/kimiMonthlyQuota.test.ts`), then `bun run verify`.
