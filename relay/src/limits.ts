export const DAILY_PER_ADDRESS = 20
export const DAILY_PER_IP = 200
const DAY_SECONDS = 60 * 60 * 24

export function utcDay(now = new Date()): string {
	return now.toISOString().slice(0, 10)
}

// KV has no atomic increment; a small race over the cap is acceptable here.
export async function bumpCounter(kv: KVNamespace, key: string, cap: number): Promise<boolean> {
	const current = Number((await kv.get(key)) ?? '0')
	if (current >= cap) return false
	await kv.put(key, String(current + 1), { expirationTtl: DAY_SECONDS * 2 })
	return true
}

export const keys = {
	status: (email: string) => `addr:${email}`,
	addressDay: (email: string, day: string) => `sent:${email}:${day}`,
	ipDay: (ip: string, day: string) => `ip:${ip}:${day}`,
}
