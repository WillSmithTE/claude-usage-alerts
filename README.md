# claude-usage-alerts

A desktop toast, webhook, or email when your Claude Code usage crosses a threshold, plus a `5h 12% · wk 50%` segment on your statusline.

```sh
npx claude-usage-alerts init
```

`init` asks for an email and an optional webhook URL, then wraps your existing statusline command so it keeps running as before with the usage segment appended. `claude-usage-alerts test` fires a fake 90% alert so you can check each channel. `claude-usage-alerts uninstall` puts your old statusline back.

## Limitations

- Pro and Max subscriptions only. The `rate_limits` data this reads is not present on API-key or Bedrock/Vertex sessions.
- Alerts fire only while a Claude Code session is open. There is no daemon; the check runs each time Claude Code redraws the statusline.
- The numbers are whatever Claude Code reports. This tool does not measure usage itself and keeps no history beyond a 30 minute sample log for the burn-rate estimate.
- The 100% threshold is unverified. It is unknown whether Claude Code still emits statusline updates once you are rate limited.
- Email goes through a small relay at `alerts.usero.io`. The first email to an address is a confirmation link; nothing else is sent until you click it. There is a cap of around 20 emails per address per day.

## How it works

Claude Code passes a JSON blob to the statusline command on every redraw, including `rate_limits.five_hour` and `rate_limits.seven_day` with `used_percentage` and `resets_at`. This script reads that, prints the segment, and on a new threshold crossing spawns a detached child to send the alerts so the statusline never waits on the network.

Each crossing fires once per window. A marker file in `~/.claude/usage-alerts/` keyed by window, reset time and threshold stops repeats, and markers are pruned once the window resets.

## Thresholds

| Window | Default thresholds | Extra rule |
| --- | --- | --- |
| 5 hour | 90 | none |
| 7 day | 50, 75, 90, 100 | fires only when usage is more than 15 points ahead of the elapsed week, or at 90+ regardless |

The weekly pace rule stops the 50% alert from firing when you are at 50% usage halfway through the week, which is exactly on pace. If you open a session already past several thresholds, only the highest one fires.

At 75% and above, the email and webhook include a burn-rate estimate: a linear projection from the last 30 minutes of samples of when the window would hit 100%. It is `null` when usage is flat, there is under a minute of data, or the projection lands after the reset.

## Statusline segment

`5h 12% · wk 50%`. Under 50% is dimmed, 75+ is yellow, 90+ is bold red with the reset time on that window, for example `5h 92% ↻3:40pm`. A weekday is added when the reset is more than a day out. Windows Claude Code does not report are left out; with no `rate_limits` at all the segment is empty.

## Config

`~/.claude/usage-alerts.json` (or under `$CLAUDE_CONFIG_DIR` when set):

```json
{
  "email": "you@example.com",
  "webhook": "https://hooks.example.com/abc",
  "thresholds": { "five_hour": [90], "seven_day": [50, 75, 90, 100] },
  "channels": { "toast": true, "webhook": true, "email": [75, 90, 100] },
  "tz": "Australia/Sydney"
}
```

| Key | Meaning |
| --- | --- |
| `email` | Address for email alerts. Leave out to disable email. |
| `webhook` | URL that receives a JSON POST on each alert. Leave out to disable. |
| `thresholds.five_hour`, `thresholds.seven_day` | Percentages that trigger an alert. Defaults above. |
| `channels.toast`, `channels.webhook`, `channels.email` | `true` (every threshold, the default), `false` (off), or a list of thresholds that channel should fire on. |
| `tz` | IANA timezone for times in alerts and the segment. Defaults to the system timezone. |
| `relay` | Email relay URL. Defaults to `https://alerts.usero.io/send`. |
| `previousStatusLine` | Written by `init`, read by `uninstall`. Leave it alone. |

## Webhook payload

```json
{
  "title": "Claude Code: 5h limit at 90%",
  "body": "5h usage is at 91% (crossed 90%). Resets 3:40pm.",
  "window": "five_hour",
  "pct": 91,
  "threshold": 90,
  "resets_at": 1757900000,
  "other_window": { "pct": 48, "resets_at": 1758300000 },
  "burn": { "runs_out_at": 1757897000 },
  "tz": "Australia/Sydney"
}
```

`window` is `five_hour` or `seven_day`. Times are Unix epoch seconds. `other_window` is `null` when Claude Code did not report the other window.

## Desktop toasts

macOS via `osascript`, Linux via `notify-send`, Windows via a PowerShell toast. If the tool is missing the toast is skipped silently.

## Try it without installing

Pipe a sample statusline payload through the script. Nothing is written to your settings; it only prints the segment (and, on a threshold crossing, fires alerts using whatever config exists).

```sh
echo '{"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1757900000},"seven_day":{"used_percentage":50,"resets_at":1758300000}}}' \
  | npx claude-usage-alerts
```

## Development

```sh
npm test
```

Single file, Node 18+, no dependencies.

## About

Built by Will, who makes Usero (usero.io).

MIT.
