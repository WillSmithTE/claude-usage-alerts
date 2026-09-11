import { describe, it, expect } from 'vitest'
import { parseSendRequest, ValidationError, isEmail } from '../src/validate'
import { confirmLink, verifyConfirm, CONFIRM_TTL_MS } from '../src/sign'
import { subject, body, FOOTER, relative, formatTime } from '../src/render'
import { bumpCounter } from '../src/limits'
import { sesBody } from '../src/ses'

const now = new Date('2026-09-11T02:00:00Z') // 12:00pm in Australia/Sydney (AEST, UTC+10)
const base = { to: 'A@Example.com', window: 'five_hour', pct: 75, threshold: 75, resets_at: '2026-09-11T05:40:00Z' }

describe('validate', () => {
	it('accepts a minimal payload and lowercases the address', () => {
		const r = parseSendRequest(base)
		expect(r.to).toBe('a@example.com')
		expect(r.window).toBe('five_hour')
	})
	it('accepts epoch seconds for dates and normalises to ISO', () => {
		const r = parseSendRequest({ ...base, resets_at: 1757900000, burn: { runs_out_at: 1757890000 } })
		expect(r.resets_at).toBe('2025-09-15T01:33:20.000Z')
		expect(r.burn?.runs_out_at).toBe('2025-09-14T22:46:40.000Z')
	})
	it('accepts optional fields', () => {
		const r = parseSendRequest({ ...base, other_window: { pct: 40, resets_at: now.toISOString() }, burn: { runs_out_at: null }, tz: 'Australia/Sydney' })
		expect(r.tz).toBe('Australia/Sydney')
		expect(r.burn?.runs_out_at).toBeNull()
	})
	it.each([
		[{ ...base, to: 'nope' }, /to/],
		[{ ...base, window: 'daily' }, /window/],
		[{ ...base, pct: '75' }, /pct/],
		[{ ...base, resets_at: 'soon' }, /resets_at/],
		[{ ...base, tz: 'Mars/Olympus' }, /tz/],
		[{ ...base, burn: { runs_out_at: 'soon' } }, /burn/],
		['string', /object/],
	])('rejects %j', (input, re) => {
		expect(() => parseSendRequest(input)).toThrow(ValidationError)
		expect(() => parseSendRequest(input)).toThrow(re)
	})
	it('isEmail rejects header injection', () => {
		expect(isEmail('a@b.com\r\nBcc: x@y.com')).toBe(false)
		expect(isEmail('a..b@example.com')).toBe(false)
	})
})

describe('sign', () => {
	it('round trips and expires after 7 days', async () => {
		const link = await confirmLink('https://alerts.usero.io', 'secret', 'a@example.com', now.getTime())
		const u = new URL(link)
		expect(u.pathname).toBe('/confirm')
		const [e, sig, exp] = ['e', 'sig', 'exp'].map(k => u.searchParams.get(k)!)
		expect(await verifyConfirm('secret', e, sig, exp, now.getTime())).toBe(true)
		expect(await verifyConfirm('secret', 'b@example.com', sig, exp, now.getTime())).toBe(false)
		expect(await verifyConfirm('other', e, sig, exp, now.getTime())).toBe(false)
		expect(await verifyConfirm('secret', e, sig, exp, now.getTime() + CONFIRM_TTL_MS + 1)).toBe(false)
		expect(await verifyConfirm('secret', e, sig, String(Number(exp) + 1), now.getTime())).toBe(false)
	})
})

describe('render', () => {
	const req = parseSendRequest({ ...base, tz: 'Australia/Sydney', other_window: { pct: 50, resets_at: '2026-09-14T22:00:00Z' }, burn: { runs_out_at: '2026-09-11T05:05:00Z' } })
	it('subject', () => {
		expect(subject(req, now)).toBe('Claude 5h window at 75%, resets 3:40pm')
		expect(subject({ ...req, window: 'seven_day' }, now)).toBe('Claude weekly window at 75%, resets 3:40pm')
	})
	it('body has every line and the footer, no opt-out wording', () => {
		const text = body(req, now)
		expect(text).toContain('Your Claude 5h window is at 75%. It resets at 3:40pm, in 3h40.')
		expect(text).toContain('At the pace of the last 30 minutes you run out around 3:05pm, 35 min before the reset.')
		expect(text).toContain('Your weekly window is at 50%, resets Tue 8:00am.')
		expect(text.endsWith(`\n\n--\n${FOOTER}`)).toBe(true)
		expect(text).not.toMatch(/unsubscribe|opt.out/i)
		expect(text).not.toMatch(/—|genuinely|truly|simply|really/)
	})
	it('omits burn and other-window lines when absent', () => {
		const text = body(parseSendRequest(base), now)
		expect(text).not.toContain('pace of the last')
		expect(text).not.toContain('weekly window is at')
		expect(text).toContain('resets at 5:40am, in 3h40.') // UTC fallback
	})
	it('helpers', () => {
		expect(relative('2026-09-11T02:12:00Z', now)).toBe('12 min')
		expect(relative('2026-09-13T04:00:00Z', now)).toBe('2d 2h')
		expect(formatTime('2026-09-12T02:00:00Z', 'UTC', now)).toBe('Sat 2:00am')
	})
})

describe('limits', () => {
	it('caps the counter', async () => {
		const store = new Map<string, string>()
		const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } as unknown as KVNamespace
		expect(await bumpCounter(kv, 'k', 2)).toBe(true)
		expect(await bumpCounter(kv, 'k', 2)).toBe(true)
		expect(await bumpCounter(kv, 'k', 2)).toBe(false)
	})
})

describe('ses', () => {
	it('builds a plain text SendEmail request', () => {
		const p = new URLSearchParams(sesBody('a@example.com', 'Hi\nthere', 'body'))
		expect(p.get('Action')).toBe('SendEmail')
		expect(p.get('Source')).toBe('Claude usage alerts <notifications@usero.io>')
		expect(p.get('Message.Subject.Data')).toBe('Hi there')
		expect(p.get('Message.Body.Text.Data')).toBe('body')
		expect(p.get('Message.Body.Html.Data')).toBeNull()
	})
})
