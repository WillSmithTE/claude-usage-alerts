#!/usr/bin/env node
// Usage threshold alerts for Claude Code. Runs as (or wraps) the statusline command.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const WINDOWS = { five_hour: '5h', seven_day: 'wk' }
const WINDOW_SECS = { five_hour: 5 * 3600, seven_day: 7 * 86400 }
const DEFAULT_THRESHOLDS = { five_hour: [90], seven_day: [50, 75, 90, 100] }
const DEFAULT_RELAY = 'https://alerts.usero.io/send'
const PACE_MARGIN = 15
const SAMPLE_KEEP_SECS = 30 * 60
const SAMPLE_MIN_GAP_SECS = 10

const ANSI = { dim: '\x1b[2m', yellow: '\x1b[33m', redBold: '\x1b[1;31m', reset: '\x1b[0m' }

// ---------- paths / config ----------

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}
export const configPath = () => path.join(claudeDir(), 'usage-alerts.json')
export const settingsPath = () => path.join(claudeDir(), 'settings.json')
export const stateDir = () => path.join(claudeDir(), 'usage-alerts')

export function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
}

export function loadConfig() {
  return readJson(configPath(), {})
}

export function thresholdsFor(config, window) {
  const list = config.thresholds?.[window]
  return Array.isArray(list) && list.length ? [...list].sort((a, b) => a - b) : DEFAULT_THRESHOLDS[window]
}

// Channel config: true (all thresholds), false (off), or an array of thresholds.
export function channelWants(config, channel, threshold) {
  const v = config.channels?.[channel]
  if (v === undefined || v === true) return true
  if (Array.isArray(v)) return v.includes(threshold)
  return false
}

export function timezone(config) {
  return config.tz || Intl.DateTimeFormat().resolvedOptions().timeZone
}

// ---------- threshold logic ----------

export function elapsedWindowPct(window, resetsAt, now) {
  const len = WINDOW_SECS[window]
  return Math.min(100, Math.max(0, ((now - (resetsAt - len)) / len) * 100))
}

// Weekly alerts fire only when usage is well ahead of the week's elapsed time, or at 90+.
export function passesPace(window, pct, resetsAt, now) {
  if (window !== 'seven_day') return true
  return pct >= 90 || pct - elapsedWindowPct(window, resetsAt, now) > PACE_MARGIN
}

// Returns the single highest threshold that pct has crossed and that has not fired yet.
export function selectThreshold(thresholds, pct, fired = () => false) {
  const crossed = thresholds.filter((t) => pct >= t)
  if (!crossed.length) return null
  const top = Math.max(...crossed)
  return fired(top) ? null : top
}

export function markerName(window, resetsAt, threshold) {
  return `${window}-${resetsAt}-${threshold}`
}

// 'wx' makes the create atomic: exactly one tick wins per marker.
export function claimMarker(dir, name) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.closeSync(fs.openSync(path.join(dir, name), 'wx'))
    return true
  } catch {
    return false
  }
}

export function pruneMarkers(dir, now) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    const m = /^(five_hour|seven_day)-(\d+)-\d+$/.exec(n)
    if (m && Number(m[2]) < now) fs.rmSync(path.join(dir, n), { force: true })
  }
}

// ---------- burn rate ----------

export function parseSamples(text) {
  return text
    .split('\n')
    .map((l) => l.split(','))
    .filter((p) => p.length === 3)
    .map(([ts, window, pct]) => ({ ts: Number(ts), window, pct: Number(pct) }))
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.pct))
}

export function serializeSamples(samples) {
  return samples.map((s) => `${s.ts},${s.window},${s.pct}`).join('\n') + (samples.length ? '\n' : '')
}

// Appends one sample per window, throttled, and drops anything older than 30 minutes.
export function recordSamples(samples, windows, now) {
  let out = samples.filter((s) => now - s.ts <= SAMPLE_KEEP_SECS)
  for (const [window, pct] of Object.entries(windows)) {
    const last = out.filter((s) => s.window === window).at(-1)
    if (last && now - last.ts < SAMPLE_MIN_GAP_SECS) continue
    out.push({ ts: now, window, pct })
  }
  return out
}

// Linear projection over the recent samples; null when flat, too short, or past the reset.
export function projectRunsOut(samples, window, pct, resetsAt, now) {
  let recent = samples.filter((s) => s.window === window && now - s.ts <= SAMPLE_KEEP_SECS)
  // A drop means the window reset mid-log; only use samples after it.
  for (let i = recent.length - 1; i > 0; i--) {
    if (recent[i].pct < recent[i - 1].pct) {
      recent = recent.slice(i)
      break
    }
  }
  if (recent.length < 2) return null
  const first = recent[0]
  const last = recent.at(-1)
  const span = last.ts - first.ts
  if (span < 60 || last.pct <= first.pct) return null
  const rate = (last.pct - first.pct) / span
  const runsOutAt = Math.round(now + (100 - pct) / rate)
  return runsOutAt < resetsAt ? runsOutAt : null
}

// ---------- rendering ----------

export function formatReset(resetsAt, now, tz) {
  const d = new Date(resetsAt * 1000)
  const opts = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }
  if (resetsAt - now > 86400) opts.weekday = 'short'
  return new Intl.DateTimeFormat('en-US', opts).format(d).replace(/,?\s+(AM|PM)$/i, (_, ap) => ap.toLowerCase())
}

export function renderSegment(rateLimits, now, tz, color = true) {
  const parts = []
  for (const [window, label] of Object.entries(WINDOWS)) {
    const w = rateLimits?.[window]
    if (typeof w?.used_percentage !== 'number') continue
    const pct = Math.floor(w.used_percentage)
    let text = `${label} ${pct}%`
    if (pct >= 90 && typeof w.resets_at === 'number') text += ` ↻${formatReset(w.resets_at, now, tz)}`
    if (color) {
      const c = pct >= 90 ? ANSI.redBold : pct >= 75 ? ANSI.yellow : pct < 50 ? ANSI.dim : ''
      if (c) text = c + text + ANSI.reset
    }
    parts.push(text)
  }
  return parts.join(' · ')
}

// ---------- alert pipeline ----------

export function buildPayload(rateLimits, window, threshold, samples, tz, now) {
  const w = rateLimits[window]
  const pct = Math.floor(w.used_percentage)
  const otherKey = window === 'five_hour' ? 'seven_day' : 'five_hour'
  const other = rateLimits[otherKey]
  return {
    window,
    pct,
    threshold,
    resets_at: w.resets_at,
    other_window:
      typeof other?.used_percentage === 'number'
        ? { pct: Math.floor(other.used_percentage), resets_at: other.resets_at }
        : null,
    burn: { runs_out_at: pct >= 75 ? projectRunsOut(samples, window, pct, w.resets_at, now) : null },
    tz,
  }
}

// Decides which alerts (if any) a tick should fire. Pure apart from marker files.
export function checkThresholds(rateLimits, config, dir, samples, now, claim = claimMarker) {
  const alerts = []
  for (const window of Object.keys(WINDOWS)) {
    const w = rateLimits?.[window]
    if (typeof w?.used_percentage !== 'number' || typeof w?.resets_at !== 'number') continue
    const pct = Math.floor(w.used_percentage)
    const t = selectThreshold(thresholdsFor(config, window), pct, (th) =>
      fs.existsSync(path.join(dir, markerName(window, w.resets_at, th))),
    )
    if (t === null || !passesPace(window, pct, w.resets_at, now)) continue
    if (!claim(dir, markerName(window, w.resets_at, t))) continue
    alerts.push(buildPayload(rateLimits, window, t, samples, timezone(config), now))
  }
  return alerts
}

function tick(input, thenCmd) {
  let data = null
  try {
    data = JSON.parse(input)
  } catch {}
  const config = loadConfig()
  const now = Math.floor(Date.now() / 1000)
  const rl = data?.rate_limits
  let segment = ''
  try {
    if (rl) {
      const dir = stateDir()
      const samplesFile = path.join(dir, 'samples.log')
      const raw = fs.existsSync(samplesFile) ? fs.readFileSync(samplesFile, 'utf8') : ''
      const current = {}
      for (const window of Object.keys(WINDOWS)) {
        if (typeof rl[window]?.used_percentage === 'number') current[window] = rl[window].used_percentage
      }
      const samples = recordSamples(parseSamples(raw), current, now)
      const text = serializeSamples(samples)
      if (text !== raw) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(samplesFile, text)
      }
      const alerts = checkThresholds(rl, config, dir, samples, now)
      if (alerts.length) pruneMarkers(dir, now)
      for (const payload of alerts) fireDetached(payload)
      segment = renderSegment(rl, now, timezone(config))
    }
  } catch {}

  let prefix = ''
  if (thenCmd) {
    try {
      const r = spawnSync(thenCmd, { shell: true, input, encoding: 'utf8' })
      prefix = (r.stdout || '').replace(/\s+$/, '')
    } catch {}
  }
  process.stdout.write(prefix && segment ? `${prefix}  ${segment}` : prefix + segment)
}

function fireDetached(payload) {
  const self = process.argv[1]
  spawn(process.execPath, [self, '--fire', JSON.stringify(payload)], { detached: true, stdio: 'ignore' }).unref()
}

// ---------- channels (run in the detached child) ----------

export function toastText(payload) {
  const name = payload.window === 'five_hour' ? '5h' : 'Weekly'
  let body = `${name} usage is at ${payload.pct}% (crossed ${payload.threshold}%). Resets ${formatReset(payload.resets_at, Math.floor(Date.now() / 1000), payload.tz)}.`
  if (payload.burn?.runs_out_at) body += ` At this pace it runs out around ${formatReset(payload.burn.runs_out_at, 0, payload.tz)}.`
  return { title: `Claude Code: ${name.toLowerCase()} limit at ${payload.threshold}%`, body }
}

function toast({ title, body }) {
  const run = (cmd, args, env) =>
    new Promise((resolve) => execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 10000 }, () => resolve()))
  if (process.platform === 'darwin') {
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return run('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`])
  }
  if (process.platform === 'linux') return run('notify-send', [title, body])
  if (process.platform === 'win32') {
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
$t.Item(0).AppendChild($x.CreateTextNode($env:CUA_TITLE)) | Out-Null
$t.Item(1).AppendChild($x.CreateTextNode($env:CUA_BODY)) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Claude Code').Show([Windows.UI.Notifications.ToastNotification]::new($x))`
    return run('powershell', ['-NoProfile', '-Command', ps], { CUA_TITLE: title, CUA_BODY: body })
  }
  return Promise.resolve()
}

async function post(url, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
  } catch {}
}

async function fire(payload, config, log = () => {}) {
  const t = payload.threshold
  const jobs = []
  if (channelWants(config, 'toast', t)) {
    log('toast')
    jobs.push(toast(toastText(payload)))
  }
  if (config.webhook && channelWants(config, 'webhook', t)) {
    log(`webhook ${config.webhook}`)
    jobs.push(post(config.webhook, { ...toastText(payload), ...payload }))
  }
  if (config.email && channelWants(config, 'email', t)) {
    const relay = config.relay || DEFAULT_RELAY
    log(`email ${config.email} via ${relay}`)
    jobs.push(post(relay, { to: config.email, ...payload }))
  }
  await Promise.all(jobs)
}

// ---------- init / uninstall / test ----------

function shellQuote(s) {
  return process.platform === 'win32' ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`
}

// Prefer the bare command; fall back to an absolute path when it is not on PATH (npx installs).
function selfCommand() {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(probe, ['claude-usage-alerts'], { encoding: 'utf8' })
  if (r.status === 0) return 'claude-usage-alerts'
  return `${shellQuote(process.execPath)} ${shellQuote(path.resolve(process.argv[1]))}`
}

// Interactive prompt, or one answer per stdin line when piped (readline drops pending questions on EOF).
async function prompter() {
  if (process.stdin.isTTY) {
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout })
    return { ask: (q) => rl.question(q), close: () => rl.close() }
  }
  const lines = fs.readFileSync(0, 'utf8').split('\n')
  return { ask: (q) => (process.stdout.write(q + '\n'), lines.shift() ?? ''), close: () => {} }
}

async function init() {
  const p = await prompter()
  const config = loadConfig()
  const email = (await p.ask(`Email for alerts${config.email ? ` [${config.email}]` : ' (blank to skip)'}: `)).trim()
  const webhook = (await p.ask(`Webhook URL${config.webhook ? ` [${config.webhook}]` : ' (blank to skip)'}: `)).trim()
  p.close()
  if (email) config.email = email
  if (webhook) config.webhook = webhook

  const settings = readJson(settingsPath(), {})
  const prev = settings.statusLine
  const alreadyOurs = typeof prev?.command === 'string' && /claude-usage-alerts/.test(prev.command)
  if (prev && !alreadyOurs) config.previousStatusLine = prev
  let command = selfCommand()
  const wrapped = alreadyOurs ? config.previousStatusLine?.command : prev?.command
  if (wrapped) command += ` --then ${shellQuote(wrapped)}`
  settings.statusLine = { type: 'command', command }
  writeJson(settingsPath(), settings)
  writeJson(configPath(), config)

  console.log(`\nConfig written to ${configPath()}`)
  console.log(`statusLine.command is now: ${command}`)
  if (wrapped) console.log(`Your previous statusline (${wrapped}) still runs first; uninstall restores it.`)
  if (email) console.log(`\nFirst email to ${email} is a confirmation link. Run "claude-usage-alerts test" to send it now.`)
  console.log('Restart Claude Code (or open a new session) to see the segment.')
}

function uninstall() {
  const config = loadConfig()
  const settings = readJson(settingsPath(), {})
  if (config.previousStatusLine) settings.statusLine = config.previousStatusLine
  else delete settings.statusLine
  writeJson(settingsPath(), settings)
  delete config.previousStatusLine
  writeJson(configPath(), config)
  console.log(`Restored statusLine in ${settingsPath()}. Config kept at ${configPath()}; delete it if you like.`)
}

async function test() {
  const config = loadConfig()
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    window: 'five_hour',
    pct: 91,
    threshold: 90,
    resets_at: now + 2 * 3600,
    other_window: { pct: 48, resets_at: now + 3 * 86400 },
    burn: { runs_out_at: now + 50 * 60 },
    tz: timezone(config),
  }
  console.log('Firing a fake 5h 91% alert to:')
  await fire(payload, config, (line) => console.log(`  ${line}`))
  if (!config.email && !config.webhook) console.log('  (no email or webhook configured; run init to add them)')
  console.log('Done.')
}

// ---------- entry ----------

async function main(argv) {
  const [cmd, ...rest] = argv
  if (cmd === 'init') return init()
  if (cmd === 'uninstall') return uninstall()
  if (cmd === 'test') return test()
  if (cmd === '--fire') {
    try {
      await fire(JSON.parse(rest[0]), loadConfig())
    } catch {}
    return
  }
  if (cmd === '--help' || cmd === '-h') {
    console.log('usage: claude-usage-alerts [init|uninstall|test] | [--then "<statusline cmd>"] < statusline.json')
    return
  }
  const thenIdx = argv.indexOf('--then')
  const thenCmd = thenIdx >= 0 ? argv[thenIdx + 1] : null
  let input = ''
  try {
    input = fs.readFileSync(0, 'utf8')
  } catch {}
  tick(input, thenCmd)
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {})
}
