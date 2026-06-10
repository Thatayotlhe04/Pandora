import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export async function getObject(key: string): Promise<Buffer> {
  const res = await getR2().send(
    new GetObjectCommand({ Bucket: getEnv().R2_BUCKET, Key: key })
  );
  if (!res.Body) throw new Error(`r2: empty body for key ${key}`);
  return Buffer.from(await res.Body.transformToByteArray());
}

/** Presigned GET URL valid for `expiresIn` seconds (default 1 hour). */
export function getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
  return awsGetSignedUrl(
    getR2(),
    new GetObjectCommand({ Bucket: getEnv().R2_BUCKET, Key: key }),
    { expiresIn }
  );
}