// Send one signed test event to a running ingestion API.
//   node scripts/send-test.mjs <endpoint> <keyId> <secret> <source>
import { createHmac, randomUUID } from 'node:crypto';

const [endpoint, keyId, secret, source] = process.argv.slice(2);
if (!endpoint || !keyId || !secret || !source) {
  console.error('usage: node scripts/send-test.mjs <endpoint> <keyId> <secret> <source>');
  process.exit(1);
}

const events = [
  {
    eventId: randomUUID(),
    source,
    scope: 'product_improvement',
    type: 'page.viewed',
    userId: 'test-user-1',
    ts: new Date().toISOString(),
    schemaVersion: 1,
    data: { path: '/' },
    context: { lib: 'send-test' },
  },
];

const body = JSON.stringify({ events });
const ts = Math.floor(Date.now() / 1000).toString();
const signature = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

const res = await fetch(`${endpoint.replace(/\/$/, '')}/ingest/batch`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-pandora-key': keyId,
    'x-pandora-source': source,
    'x-pandora-timestamp': ts,
    'x-pandora-signature': signature,
  },
  body,
});

console.log('status:', res.status);
console.log(await res.text());
