import fetch from "node-fetch";

import { logInfo } from './logger.js';

export async function notifyWebhooks(webhooks, event, payload) {
  const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
  const list = webhooks || [];
  const results = await Promise.allSettled(
    list.map(h => fetch(h.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(h.secret ? { "X-Webhook-Secret": h.secret } : {}) },
      body
    }))
  );
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const fail = results.length - ok;
  logInfo('LT webhooks notify', { event, count: list.length, ok, fail });
}
