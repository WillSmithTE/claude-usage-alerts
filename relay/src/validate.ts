export type Window = 'five_hour' | 'seven_day'

export interface SendRequest {
	to: string
	window: Window
	pct: number
	threshold: number
	resets_at: string
	other_window?: { pct: number; resets_at: string }
	burn?: { runs_out_at: string | null }
	tz?: string
}

export class ValidationError extends Error {}

const EMAIL_RE = /^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i

export function isEmail(value: unknown): value is string {
	return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value) && !value.includes('..')
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pct(v: unknown, field: string): number {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) throw new ValidationError(`${field} must be a number 0-1000`)
	return v
}

// The CLI sends epoch seconds; ISO strings are accepted too. Normalised to ISO.
function isoDate(v: unknown, field: string): string {
	if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString()
	if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new ValidationError(`${field} must be epoch seconds or an ISO date string`)
	return v
}

function isTz(v: string): boolean {
	try {
		new Intl.DateTimeFormat('en', { timeZone: v })
		return true
	} catch {
		return false
	}
}

export function parseSendRequest(body: unknown): SendRequest {
	if (!isObject(body)) throw new ValidationError('body must be a JSON object')
	if (!isEmail(body.to)) throw new ValidationError('to must be an email address')
	if (body.window !== 'five_hour' && body.window !== 'seven_day') throw new ValidationError('window must be five_hour or seven_day')
	const out: SendRequest = {
		to: body.to.toLowerCase(),
		window: body.window,
		pct: pct(body.pct, 'pct'),
		threshold: pct(body.threshold, 'threshold'),
		resets_at: isoDate(body.resets_at, 'resets_at'),
	}
	if (body.other_window !== undefined) {
		if (!isObject(body.other_window)) throw new ValidationError('other_window must be an object')
		out.other_window = { pct: pct(body.other_window.pct, 'other_window.pct'), resets_at: isoDate(body.other_window.resets_at, 'other_window.resets_at') }
	}
	if (body.burn !== undefined) {
		if (!isObject(body.burn)) throw new ValidationError('burn must be an object')
		out.burn = { runs_out_at: body.burn.runs_out_at === null ? null : isoDate(body.burn.runs_out_at, 'burn.runs_out_at') }
	}
	if (body.tz !== undefined) {
		if (typeof body.tz !== 'string' || body.tz.length > 64 || !isTz(body.tz)) throw new ValidationError('tz must be an IANA timezone')
		out.tz = body.tz
	}
	return out
}
