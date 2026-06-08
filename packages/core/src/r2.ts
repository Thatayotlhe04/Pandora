import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getEnv } from './env.js';

let client: S3Client | null = null;

/** Shared R2 (S3-compatible) client. */
export function getR2(): S3Client {
  if (client) return client;
  const env = getEnv();
  client = new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<void> {
  await getR2().send(
    new PutObjectCommand({
      Bucket: getEnv().R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}
