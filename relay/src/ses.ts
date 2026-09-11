import { AwsClient } from 'aws4fetch'

// Same region + verified sender as Usero (feedback/app/utils/email.server.ts).
const SES_REGION = 'us-west-2'
const SES_ENDPOINT = `https://email.${SES_REGION}.amazonaws.com/`
const FROM = 'Claude usage alerts <notifications@usero.io>'

export interface SesCreds {
	accessKeyId: string
	secretAccessKey: string
}

export function sesBody(to: string, subject: string, text: string): string {
	const p = new URLSearchParams()
	p.set('Action', 'SendEmail')
	p.set('Source', FROM)
	p.set('Destination.ToAddresses.member.1', to)
	p.set('Message.Subject.Data', subject.replace(/[\r\n\t]+/g, ' ').slice(0, 120))
	p.set('Message.Subject.Charset', 'UTF-8')
	p.set('Message.Body.Text.Data', text)
	p.set('Message.Body.Text.Charset', 'UTF-8')
	return p.toString()
}

export async function sendPlainText(creds: SesCreds, to: string, subject: string, text: string): Promise<void> {
	const aws = new AwsClient({ ...creds, region: SES_REGION, service: 'ses', retries: 0 })
	const res = await aws.fetch(SES_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: sesBody(to, subject, text),
	})
	if (!res.ok) throw new Error(`SES ${res.status}: ${(await res.text()).slice(0, 500)}`)
}
