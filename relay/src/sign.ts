const enc = new TextEncoder()

async function hmac(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg))
	return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000

export async function confirmLink(baseUrl: string, secret: string, email: string, now = Date.now()): Promise<string> {
	const exp = String(now + CONFIRM_TTL_MS)
	const sig = await hmac(secret, `${email}\n${exp}`)
	const u = new URL('/confirm', baseUrl)
	u.searchParams.set('e', email)
	u.searchParams.set('sig', sig)
	u.searchParams.set('exp', exp)
	return u.toString()
}

export async function verifyConfirm(secret: string, email: string, sig: string, exp: string, now = Date.now()): Promise<boolean> {
	if (!/^\d{1,16}$/.test(exp) || Number(exp) < now) return false
	const expected = await hmac(secret, `${email}\n${exp}`)
	if (expected.length !== sig.length) return false
	// Constant-time compare
	let diff = 0
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
	return diff === 0
}
