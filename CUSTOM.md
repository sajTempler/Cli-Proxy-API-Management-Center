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

### How the Cursor tab works

- Contract: `/Users/szymon/private/CLIProxyAPI` branch `feat/cursor-usage`,
  `docs/cursor/USAGE-TRACKING.md` section 5. `GET /v8/management/quota/cursor` is the poller
  snapshot; `POST /v8/management/quota/cursor/refresh {auth_index}` polls Cursor now.
- Cards: one per `type: "cursor"` credential from `/credentials` (every cursor auth file also
  appears in the quota response, so no synthetic entries). Matched by `auth_index`, then name.
- Fetch (`src/features/quota/providers/cursor/data.ts`): a card refresh POSTs `refresh` for its
  `auth_index`; on 404/429/503 it falls back to the shared GET snapshot. A missing endpoint ends
  as a 404 error, which the card shows as "update CPA".
- Normalizer: `src/services/api/cursorQuota.ts`. Body: `cursor/CursorQuotaBody.tsx` (bars fill
  with the share USED, as Cursor shows them). Display rules (percent rounding, `$` decimals,
  `Resets MMM d` in UTC) live in `data.ts` and are tested in `tests/cursorQuota.test.ts`.
- Timeline: `windows[]` (Included, Auto, API) carry `resetAtMs` and `periodHours` = billing cycle
  length, so the lane is the monthly cycle bar. Like the card, the lane shows percent USED
  (`lane.used`, `limit.used`, labelled `cursor_quota.used_percent`); other providers show remaining.
