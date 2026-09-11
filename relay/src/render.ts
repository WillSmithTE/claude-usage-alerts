import type { SendRequest } from './validate'

export const FOOTER = 'Will. I build Usero (usero.io), a feedback tool for product teams. This script came out of watching my own limits while working on it.'

const WINDOW_LABEL = { five_hour: '5h', seven_day: 'weekly' } as const

export function formatTime(iso: string, tz: string | undefined, now: Date): string {
	const d = new Date(iso)
	const zone = tz ?? 'UTC'
	const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' })
	const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(d).toLowerCase().replace(' ', '')
	if (sameDay.format(d) === sameDay.format(now)) return time
	const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(d)
	return `${day} ${time}`
}

export function relative(fromIso: string, now: Date): string {
	return formatMinutes(Math.max(0, Math.round((new Date(fromIso).getTime() - now.getTime()) / 60000)))
}

export function formatMinutes(mins: number): string {
	if (mins < 60) return `${mins} min`
	const h = Math.floor(mins / 60)
	const m = mins % 60
	if (h >= 24) {
		const days = Math.floor(h / 24)
		return `${days}d ${h % 24}h`
	}
	return `${h}h${String(m).padStart(2, '0')}`
}

function minutesBetween(a: string, b: string): number {
	return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)
}

export function subject(req: SendRequest, now = new Date()): string {
	return `Claude ${WINDOW_LABEL[req.window]} window at ${Math.round(req.pct)}%, resets ${formatTime(req.resets_at, req.tz, now)}`
}

export function body(req: SendRequest, now = new Date()): string {
	const label = WINDOW_LABEL[req.window]
	const other = req.window === 'five_hour' ? 'weekly' : '5h'
	const lines: string[] = []
	lines.push(`Your Claude ${label} window is at ${Math.round(req.pct)}%. It resets at ${formatTime(req.resets_at, req.tz, now)}, in ${relative(req.resets_at, now)}.`)
	if (req.burn?.runs_out_at) {
		const gap = minutesBetween(req.burn.runs_out_at, req.resets_at)
		const tail = gap > 0 ? `, ${formatMinutes(gap)} before the reset` : ''
		lines.push(`At the pace of the last 30 minutes you run out around ${formatTime(req.burn.runs_out_at, req.tz, now)}${tail}.`)
	}
	if (req.other_window) {
		lines.push(`Your ${other} window is at ${Math.round(req.other_window.pct)}%, resets ${formatTime(req.other_window.resets_at, req.tz, now)}.`)
	}
	lines.push(advice(req))
	lines.push('')
	lines.push('--')
	lines.push(FOOTER)
	return lines.join('\n')
}

function advice(req: SendRequest): string {
	if (req.pct >= 100) return 'You are out until the reset. Anything queued can wait for it.'
	if (req.pct >= 90) return 'Finish what is open and hold anything big until after the reset.'
	if (req.window === 'seven_day') return 'Worth pacing the rest of the week if you have larger jobs planned.'
	return 'No action needed yet, this is a heads up so the limit does not land mid task.'
}

export function confirmSubject(to: string): string {
	return `Confirm Claude usage alerts for ${to}`
}

export function confirmBody(link: string, to: string): string {
	return [
		`Someone (probably you) set up claude-usage-alerts to email ${to} when a Claude Code usage window crosses a threshold.`,
		'',
		`Confirm here: ${link}`,
		'',
		'The link works for 7 days. If this was not you, ignore this email and nothing else will be sent.',
		'',
		'--',
		FOOTER,
	].join('\n')
}
