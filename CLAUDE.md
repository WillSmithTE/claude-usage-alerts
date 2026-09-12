# claude-usage-alerts

Open-source Claude Code usage alerts (statusline segment + toast/webhook/email at thresholds). Two parts, one repo:

- `bin/claude-usage-alerts.js`: the npm CLI. Single ESM file, Node 18+, zero deps. Tests in `test/alerts.test.js`.
- `relay/`: Cloudflare Worker at `https://alerts.usero.io` that sends the emails. Owned and paid for by Will (Usero).

Product decisions and history: `~/Documents/docs/pm/tasks/claude-usage-alerts.md`.

## Conventions

- Follow `~/.claude/CLAUDE.md` (no `git add -A`, explicit paths, commit to main, no em dashes, no "genuinely").
- Short one-line code comments only where non-obvious.
- No opt-out wording for the Usero footer anywhere (README, email, code). It is opt-in by design (confirm-first).
- Never mention the footer in toast or webhook payloads.

## Releasing the CLI (npm)

Trusted publishing (OIDC) from `.github/workflows/publish.yml`, registered on npmjs.com for repo `WillSmithTE/claude-usage-alerts`
and that filename. Bump `version` in `package.json`, commit, push to main. The workflow publishes with `--provenance`.
No NPM_TOKEN exists and local `npm publish` needs a passkey tap, so do not publish locally.
`npm test` must pass on Node 22 (the runner): keep the script as `node --test test/alerts.test.js`, since a directory arg
fails on 22 and bare `node --test` also picks up `relay/test/*.test.ts`.

## Deploying the relay

CI only: `.github/workflows/relay.yml` deploys on push to main when `relay/**` changes (secrets `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID` on the repo, token `claude-usage-alerts-ci`). Never `wrangler deploy` by hand.

- Worker `claude-usage-alerts-relay`, KV `RELAY_KV` (`f57d540d65e24ac695d1931251ef38a7`).
- Sends via AWS SES from `notifications@usero.io` with the same SES creds as `~/projects/feedback`.
- Worker secrets: `SES_AWS_ACCESS_KEY_ID`, `SES_AWS_SECRET_ACCESS_KEY`, `CONFIRM_SECRET`. Local values in `relay/.dev.vars`
  (gitignored). **Set them with `printf '%s' "$v" | npx wrangler secret put NAME`**, never `echo`: a trailing newline once
  broke all three at the same time (SES `InvalidClientTokenId`, confirm links 400).
- `wrangler.jsonc` has BOTH a custom domain and an explicit `alerts.usero.io/*` route. The usero.io zone carries a `*/*`
  Workers route to the main Usero app (needed for Cloudflare for SaaS customer domains) and it beats custom domains on
  their own. Keep the explicit route.
- Local dev: `cd relay && npx wrangler dev` with `DRY_RUN=1` in `.dev.vars` so nothing is emailed.
- Flow: first `POST /send` for an address emails a confirm link (HMAC, 7 days) and stores `addr:<email>=pending` only after
  the send succeeds; `GET /confirm` marks confirmed; then 20 alerts/address/day, 200/IP/day.
- To reset an address during testing: `npx wrangler kv key delete --namespace-id <id> --remote "addr:<email>"`.

## Payload contract (CLI -> relay)

`POST /send` JSON: `to, window ("five_hour"|"seven_day"), pct, threshold, resets_at, other_window?, burn?, tz?`.
Dates are epoch seconds from the CLI; the relay also accepts ISO strings. Keep `render.ts` and the CLI's `--fire` payload in sync.

## Known gaps

- `init --help` runs init instead of printing usage.
- Windows and Linux toasts are untested.
- 100% threshold is unverified (unknown whether Claude Code still emits statusline updates once limited).
- No README GIF yet.
