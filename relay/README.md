# relay

Cloudflare Worker at `alerts.usero.io` that turns a JSON alert from the CLI into a plain-text email via AWS SES.

- `POST /send` with `{ to, window, pct, threshold, resets_at, other_window?, burn?, tz? }`. First call for an address sends a confirmation link (one per 7 days) and returns `202 {status:"confirmation_sent"}`. Confirmed addresses get the alert, capped at 20 a day (`429` past that). 200 requests per IP per day.
- `GET /confirm?e=&sig=&exp=` marks the address confirmed.

Local: copy `SES_AWS_ACCESS_KEY_ID`, `SES_AWS_SECRET_ACCESS_KEY`, `CONFIRM_SECRET` into `.dev.vars`, add `DRY_RUN=1` to log emails instead of sending, then `npm run dev`. Deploys go through `.github/workflows/relay.yml`, never `wrangler deploy` by hand.
