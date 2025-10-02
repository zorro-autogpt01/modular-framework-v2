import fetch from "node-fetch";

export async function notifyWebhooks(webhooks, event, payload) {
  const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
  await Promise.allSettled(
    (webhooks || []).map(h =>
      fetch(h.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(h.secret ? { "X-Webhook-Secret": h.secret } : {})
        },
        body
      })
    )
  );
}
