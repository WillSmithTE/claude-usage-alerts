import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  selectThreshold,
  thresholdsFor,
  channelWants,
  passesPace,
  elapsedWindowPct,
  markerName,
  claimMarker,
  pruneMarkers,
  checkThresholds,
  recordSamples,
  parseSamples,
  serializeSamples,
  projectRunsOut,
  renderSegment,
  formatReset,
  buildPayload,
  toastText,
} from '../bin/claude-usage-alerts.js'

const NOW = 1_800_000_000
const TZ = 'Australia/Sydney'
const DAY = 86400
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cua-'))

test('threshold selection: highest crossed, unfired threshold', () => {
  const t = [50, 75, 90, 100]
  assert.equal(selectThreshold(t, 49), null)
  assert.equal(selectThreshold(t, 50), 50)
  assert.equal(selectThreshold(t, 95), 90)
  assert.equal(selectThreshold(t, 100), 100)
  assert.equal(selectThreshold(t, 95, (th) => th === 90), null)
  assert.equal(selectThreshold(t, 100, (th) => th === 90), 100)
})

test('thresholds: defaults and per-window overrides', () => {
  assert.deepEqual(thresholdsFor({}, 'five_hour'), [90])
  assert.deepEqual(thresholdsFor({}, 'seven_day'), [50, 75, 90, 100])
  assert.deepEqual(thresholdsFor({ thresholds: { five_hour: [80, 60] } }, 'five_hour'), [60, 80])
  assert.deepEqual(thresholdsFor({ thresholds: { five_hour: [] } }, 'five_hour'), [90])
})

test('channels: true, false, or a threshold list', () => {
  assert.equal(channelWants({}, 'email', 50), true)
  assert.equal(channelWants({ channels: { toast: false } }, 'toast', 90), false)
  assert.equal(channelWants({ channels: { email: [90, 100] } }, 'email', 75), false)
  assert.equal(channelWants({ channels: { email: [90, 100] } }, 'email', 90), true)
})

test('pace rule: weekly fires only when ahead of the week, or at 90+', () => {
  const resetsAt = NOW + 4 * DAY // 3 of 7 days elapsed, ~43%
  assert.ok(Math.abs(elapsedWindowPct('seven_day', resetsAt, NOW) - 42.86) < 0.1)
  assert.equal(passesPace('seven_day', 50, resetsAt, NOW), false) // 7 points ahead
  assert.equal(passesPace('seven_day', 60, resetsAt, NOW), true) // 17 points ahead
  assert.equal(passesPace('seven_day', 90, NOW + 1 * 3600, NOW), true) // end of week, 90 regardless
  assert.equal(passesPace('five_hour', 50, NOW + 3600, NOW), true) // 5h never pace-gated
})

test('markers: wx claim dedupes, prune drops past windows', () => {
  const dir = tmp()
  const name = markerName('five_hour', NOW + 3600, 90)
  assert.equal(name, `five_hour-${NOW + 3600}-90`)
  assert.equal(claimMarker(dir, name), true)
  assert.equal(claimMarker(dir, name), false)
  fs.writeFileSync(path.join(dir, markerName('seven_day', NOW - 10, 50)), '')
  pruneMarkers(dir, NOW)
  assert.deepEqual(fs.readdirSync(dir), [name])
})

test('checkThresholds: fires once per window/reset/threshold', () => {
  const dir = tmp()
  const rl = {
    five_hour: { used_percentage: 91.4, resets_at: NOW + 3600 },
    seven_day: { used_percentage: 20, resets_at: NOW + 6 * DAY },
  }
  const first = checkThresholds(rl, { tz: TZ }, dir, [], NOW)
  assert.equal(first.length, 1)
  assert.equal(first[0].window, 'five_hour')
  assert.equal(first[0].pct, 91)
  assert.equal(first[0].threshold, 90)
  assert.deepEqual(first[0].other_window, { pct: 20, resets_at: NOW + 6 * DAY })
  assert.equal(checkThresholds(rl, { tz: TZ }, dir, [], NOW + 5).length, 0)
  // Same pct, new window: fires again.
  rl.five_hour.resets_at += 5 * 3600
  assert.equal(checkThresholds(rl, { tz: TZ }, dir, [], NOW + 5).length, 1)
})

test('checkThresholds: weekly suppressed by pace writes no marker', () => {
  const dir = tmp()
  const rl = { seven_day: { used_percentage: 50, resets_at: NOW + 4 * DAY } }
  assert.equal(checkThresholds(rl, {}, dir, [], NOW).length, 0)
  assert.deepEqual(fs.readdirSync(dir), [])
  rl.seven_day.used_percentage = 62
  assert.equal(checkThresholds(rl, {}, dir, [], NOW)[0].threshold, 50)
})

test('samples: throttled append, 30 minute retention, round trip', () => {
  let s = recordSamples([], { five_hour: 10, seven_day: 40 }, NOW)
  assert.equal(s.length, 2)
  s = recordSamples(s, { five_hour: 11 }, NOW + 3) // inside the 10s gap
  assert.equal(s.length, 2)
  s = recordSamples(s, { five_hour: 11 }, NOW + 20)
  assert.equal(s.length, 3)
  // 30m01s after the first two samples: they drop, the NOW+20 one stays.
  s = recordSamples(s, { five_hour: 12 }, NOW + 30 * 60 + 1)
  assert.deepEqual(
    s.map((x) => x.ts),
    [NOW + 20, NOW + 30 * 60 + 1],
  )
  assert.deepEqual(parseSamples(serializeSamples(s)), s)
  assert.deepEqual(parseSamples('garbage\n1,five_hour,x\n'), [])
})

test('burn rate: linear projection, null when flat, short, or after reset', () => {
  const samples = [
    { ts: NOW - 1200, window: 'five_hour', pct: 70 },
    { ts: NOW - 600, window: 'five_hour', pct: 75 },
    { ts: NOW, window: 'five_hour', pct: 80 },
  ]
  // 10 points per 1200s, 20 points to go: 2400s.
  assert.equal(projectRunsOut(samples, 'five_hour', 80, NOW + 3600, NOW), NOW + 2400)
  assert.equal(projectRunsOut(samples, 'five_hour', 80, NOW + 2000, NOW), null)
  assert.equal(projectRunsOut(samples, 'seven_day', 80, NOW + 3600, NOW), null)
  const flat = samples.map((s) => ({ ...s, pct: 80 }))
  assert.equal(projectRunsOut(flat, 'five_hour', 80, NOW + 3600, NOW), null)
  const short = [
    { ts: NOW - 30, window: 'five_hour', pct: 79 },
    { ts: NOW, window: 'five_hour', pct: 80 },
  ]
  assert.equal(projectRunsOut(short, 'five_hour', 80, NOW + 3600, NOW), null)
})

test('burn rate: ignores samples from before a window reset', () => {
  const samples = [
    { ts: NOW - 1500, window: 'five_hour', pct: 95 },
    { ts: NOW - 1200, window: 'five_hour', pct: 5 },
    { ts: NOW, window: 'five_hour', pct: 80 },
  ]
  // 75 points per 1200s, 20 to go: 320s.
  assert.equal(projectRunsOut(samples, 'five_hour', 80, NOW + 3600, NOW), NOW + 320)
})

test('buildPayload: burn only at 75+', () => {
  const samples = [
    { ts: NOW - 1200, window: 'five_hour', pct: 50 },
    { ts: NOW, window: 'five_hour', pct: 60 },
  ]
  const rl = { five_hour: { used_percentage: 60, resets_at: NOW + 3600 } }
  assert.deepEqual(buildPayload(rl, 'five_hour', 50, samples, TZ, NOW).burn, { runs_out_at: null })
  rl.five_hour.used_percentage = 76
  assert.equal(typeof buildPayload(rl, 'five_hour', 75, samples, TZ, NOW).burn.runs_out_at, 'number')
})

test('segment: format, colours, reset stamp only at 90+', () => {
  const plain = (rl) => renderSegment(rl, NOW, TZ, false)
  assert.equal(plain({ five_hour: { used_percentage: 12.9, resets_at: NOW + 3600 } }), '5h 12%')
  assert.equal(
    plain({ five_hour: { used_percentage: 12, resets_at: NOW + 1 }, seven_day: { used_percentage: 50, resets_at: NOW + 1 } }),
    '5h 12% · wk 50%',
  )
  assert.equal(plain({ five_hour: { used_percentage: 89.9, resets_at: NOW + 3600 } }), '5h 89%')
  const hot = plain({ five_hour: { used_percentage: 92, resets_at: NOW + 3600 } })
  assert.match(hot, /^5h 92% ↻\d{1,2}:\d{2}(am|pm)$/)
  assert.equal(plain({}), '')
  assert.equal(plain(undefined), '')

  const c = (pct) => renderSegment({ five_hour: { used_percentage: pct, resets_at: NOW + 3600 } }, NOW, TZ)
  assert.ok(c(10).startsWith('\x1b[2m'))
  assert.equal(c(60), '5h 60%')
  assert.ok(c(75).startsWith('\x1b[33m'))
  assert.ok(c(90).startsWith('\x1b[1;31m'))
  assert.ok(c(90).endsWith('\x1b[0m'))
})

test('formatReset: same-day stamp, weekday when more than a day out', () => {
  const at = Date.UTC(2026, 8, 11, 5, 40) / 1000 // 3:40pm Sydney (AEST)
  assert.equal(formatReset(at, at - 3600, TZ), '3:40pm')
  assert.equal(formatReset(at, at - 3 * DAY, TZ), 'Fri 3:40pm')
})

test('toastText: title and body', () => {
  const soon = Math.floor(Date.now() / 1000) + 3600
  const t = toastText({ window: 'five_hour', pct: 91, threshold: 90, resets_at: soon, burn: { runs_out_at: null }, tz: TZ })
  assert.equal(t.title, 'Claude Code: 5h limit at 90%')
  assert.match(t.body, /^5h usage is at 91% \(crossed 90%\)\. Resets \d/)
  const w = toastText({ window: 'seven_day', pct: 77, threshold: 75, resets_at: soon, burn: { runs_out_at: soon - 600 }, tz: TZ })
  assert.match(w.body, /runs out around/)
})
