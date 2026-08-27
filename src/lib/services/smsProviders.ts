import axios from 'axios';

export interface SmsProvider {
  send(recipient: string, body: string): Promise<string>; // resolves to a provider reference
}

/** Dev default — logs instead of sending, so the app runs end-to-end with zero external credentials. */
export class LogSmsProvider implements SmsProvider {
  async send(recipient: string, body: string): Promise<string> {
    const ref = `log-${Date.now()}`;
    console.log(`[SMS:LOG] to=${recipient} ref=${ref}\n${body}`);
    return ref;
  }
}

/**
 * Hubtel SMS Quick API. Endpoint/param names follow Hubtel's documented Quick SMS
 * pattern (clientid/clientsecret/from/to/content over HTTPS GET) — verify against
 * current Hubtel docs before relying on this in production; SMS_PROVIDER=log is the
 * safe default and what the app runs on until real credentials are configured.
 */
export class HubtelSmsProvider implements SmsProvider {
  async send(recipient: string, body: string): Promise<string> {
    const clientId = process.env.HUBTEL_SMS_CLIENT_ID;
    const clientSecret = process.env.HUBTEL_SMS_CLIENT_SECRET;
    const senderId = process.env.HUBTEL_SMS_SENDER_ID || 'HP-Lite';
    if (!clientId || !clientSecret) throw new Error('HUBTEL_SMS_CLIENT_ID/HUBTEL_SMS_CLIENT_SECRET are not configured');

    const response = await axios.get('https://smsc.hubtel.com/v1/messages/send', {
      params: { clientid: clientId, clientsecret: clientSecret, from: senderId, to: recipient, content: body },
      timeout: 10_000,
    });
    return String(response.data?.messageId ?? response.status);
  }
}

export function getSmsProvider(): SmsProvider {
  return process.env.SMS_PROVIDER === 'hubtel' ? new HubtelSmsProvider() : new LogSmsProvider();
}
