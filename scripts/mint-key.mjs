// Generate an ingestion key for a source and print the SQL to register it.
//   node scripts/mint-key.mjs <source>
import { randomBytes } from 'node:crypto';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/mint-key.mjs <source>');
  process.exit(1);
}

const keyId = `pk_${source}_${randomBytes(6).toString('hex')}`;
const secret = randomBytes(32).toString('hex');

console.log('keyId :', keyId);
console.log('secret:', secret);
console.log('\n(store the secret securely — the source SDK config needs it)\n');
console.log('SQL:');
console.log(
  `insert into api_keys (key_id, source, secret, name) values ('${keyId}', '${source}', '${secret}', '${source} ingestion');`
);
