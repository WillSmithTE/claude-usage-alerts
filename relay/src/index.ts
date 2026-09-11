import { parseSendRequest, ValidationError, isEmail } from './validate'
import { confirmLink, verifyConfirm, CONFIRM_TTL_MS } from './sign'
import { subject, body, confirmSubject, confirmBody } from './render'
import { sendPlainText } from './ses'
import { bumpCounter, keys, utcDay, DAILY_PER_ADDRESS, DAILY_PER_IP } from './limits'

export interface Env {
	RELAY_KV: KVNamespace
	BASE_URL: string
	CONFIRM_SECRET: string
	SES_AWS_ACCESS_KEY_ID: string
	SES_AWS_SECRET_ACCESS_KEY: string
	DRY_RUN?: string
}

const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

async function deliver(env: Env, to: string, subj: string, text: string): Promise<void> {
	if (env.DRY_RUN === '1') {
		console.log(`DRY_RUN email to ${to}\nSubject: ${subj}\n\n${text}`)
		return
	}
	await sendPlainText({ accessKeyId: env.SES_AWS_ACCESS_KEY_ID, secretAccessKey: env.SES_AWS_SECRET_ACCESS_KEY }, to, subj, text)
}

async function handleSend(request: Request, env: Env): Promise<Response> {
	let parsed
	try {
		parsed = parseSendRequest(await request.json().catch(() => null))
	} catch (e) {
		return json(400, { error: e instanceof ValidationError ? e.message : 'invalid request' })
	}
	const day = utcDay()
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
	if (!(await bumpCounter(env.RELAY_KV, keys.ipDay(ip, day), DAILY_PER_IP))) return json(429, { error: 'too many requests from this IP today' })

	const status = await env.RELAY_KV.get(keys.status(parsed.to))
	if (status !== 'confirmed') {
		// One confirmation per address per 7 days, whatever the caller does.
		if (status === 'pending') return json(202, { status: 'confirmation_pending' })
		await env.RELAY_KV.put(keys.status(parsed.to), 'pending', { expirationTtl: CONFIRM_TTL_MS / 1000 })
		const link = await confirmLink(env.BASE_URL, env.CONFIRM_SECRET, parsed.to)
		await deliver(env, parsed.to, confirmSubject(), confirmBody(link))
		return json(202, { status: 'confirmation_sent' })
	}

	if (!(await bumpCounter(env.RELAY_KV, keys.addressDay(parsed.to, day), DAILY_PER_ADDRESS))) return json(429, { error: 'daily alert cap reached for this address' })
	await deliver(env, parsed.to, subject(parsed), body(parsed))
	return json(202, { status: 'sent' })
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const page = (title: string, text: string) =>
	new Response(`<!doctype html><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:32em;margin:4em auto;padding:0 1em"><h1 style="font-size:1.4em">${title}</h1><p>${text}</p>`, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	})

async function handleConfirm(url: URL, env: Env): Promise<Response> {
	const e = (url.searchParams.get('e') ?? '').toLowerCase()
	const sig = url.searchParams.get('sig') ?? ''
	const exp = url.searchParams.get('exp') ?? ''
	if (!isEmail(e) || !(await verifyConfirm(env.CONFIRM_SECRET, e, sig, exp))) {
		return new Response(page('Link expired or invalid', 'Trigger another alert from Claude Code to get a fresh link.').body, { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
	}
	await env.RELAY_KV.put(keys.status(e), 'confirmed')
	return page("You're set", `Usage alerts will go to ${escape(e)}. You can close this tab.`)
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url)
		if (request.method === 'POST' && url.pathname === '/send') return handleSend(request, env)
		if (request.method === 'GET' && url.pathname === '/confirm') return handleConfirm(url, env)
		if (request.method === 'GET' && url.pathname === '/') {
			return new Response('claude-usage-alerts email relay. POST /send from the CLI; see github.com/willsmithte/claude-usage-alerts\n', { headers: { 'Content-Type': 'text/plain' } })
		}
		return new Response('not found', { status: 404 })
	},
} satisfies ExportedHandler<Env>
