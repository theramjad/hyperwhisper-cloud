// R2 UTILITIES FOR LARGE FILE TRANSCRIPTION
// Handles temporary audio storage for files >30MB that can't be streamed directly to Deepgram
//
// PROBLEM:
// Cloudflare Workers uses Transfer-Encoding: chunked for ReadableStream bodies,
// which causes Deepgram to fail with "Unable to read the entire client request" (422 error)
// for large files (>30MB).
//
// SOLUTION:
// Upload large files to R2, generate presigned URL, let Deepgram fetch directly.
//
// FLOW:
// 1. uploadToR2() - Stream audio from request body to R2 bucket
// 2. generateR2PresignedUrl() - Create signed GET URL for Deepgram to fetch
// 3. deleteFromR2() - Clean up after transcription completes
//
// WHY R2:
// - R2 accepts streams without memory limits
// - Deepgram can fetch from URL (up to 2GB files)
// - R2 egress to external services is free
// - Presigned URLs provide time-limited secure access

import { AwsClient } from 'aws4fetch';

// ============================================================================
// R2 UPLOAD
// ============================================================================

/**
 * Upload audio stream to R2 bucket
 *
 * Uses the R2 bucket binding to stream audio data directly without buffering.
 * The binding handles all authentication automatically.
 *
 * @param bucket - R2 bucket binding from env
 * @param key - Object key (path) in the bucket
 * @param stream - Audio data as ReadableStream
 * @param contentType - MIME type of the audio
 * @returns R2Object metadata on success
 */
export async function uploadToR2(
  bucket: R2Bucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  contentType: string
): Promise<R2Object> {
  const result = await bucket.put(key, stream, {
    httpMetadata: {
      contentType,
    },
  });

  if (!result) {
    throw new Error(`Failed to upload to R2: ${key}`);
  }

  return result;
}

// ============================================================================
// PRESIGNED URL GENERATION
// ============================================================================

/**
 * Generate presigned GET URL for R2 object
 *
 * Deepgram will use this URL to fetch the audio file directly.
 * The URL is signed with AWS v4 signature (R2 is S3-compatible).
 *
 * SECURITY:
 * - URL expires after specified duration (default 15 minutes)
 * - Only GET requests are allowed
 * - Signature prevents tampering with URL parameters
 *
 * @param accountId - Cloudflare account ID
 * @param accessKeyId - R2 API token access key
 * @param secretAccessKey - R2 API token secret
 * @param bucketName - Name of the R2 bucket
 * @param key - Object key in the bucket
 * @param expiresInSeconds - URL validity duration (default 15 minutes)
 * @returns Presigned URL string
 */
export async function generateR2PresignedUrl(
  accountId: string,
  accessKeyId: string,
  secretAccessKey: string,
  bucketName: string,
  key: string,
  expiresInSeconds: number = 15 * 60
): Promise<string> {
  // Create AWS client configured for R2
  // R2 uses S3-compatible API with 'auto' region
  const r2 = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  // Construct R2 endpoint URL
  // Format: https://{account_id}.r2.cloudflarestorage.com/{bucket}/{key}
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const url = new URL(`${endpoint}/${bucketName}/${key}`);

  // Add expiration to query params for signing
  url.searchParams.set('X-Amz-Expires', expiresInSeconds.toString());

  // Sign the request using AWS v4 signature
  // signQuery: true puts the signature in URL params instead of headers
  const signed = await r2.sign(
    new Request(url.toString(), { method: 'GET' }),
    { aws: { signQuery: true } }
  );

  return signed.url;
}

// ============================================================================
// R2 CLEANUP
// ============================================================================

/**
 * Delete object from R2 bucket
 *
 * Called after transcription completes to clean up temporary files.
 * Should be called via ctx.waitUntil() to not block the response.
 *
 * NOTE: R2 lifecycle rules provide a failsafe (auto-delete after 1 day)
 * in case deletion fails or is missed.
 *
 * @param bucket - R2 bucket binding from env
 * @param key - Object key to delete
 */
export async function deleteFromR2(
  bucket: R2Bucket,
  key: string
): Promise<void> {
  await bucket.delete(key);
}

// ============================================================================
// KEY GENERATION
// ============================================================================

/**
 * Generate unique key for temporary audio file
 *
 * Format: temp/{timestamp}-{random}.{extension}
 * The temp/ prefix makes lifecycle rules easier to configure.
 *
 * @param contentType - MIME type to determine file extension
 * @returns Unique object key
 */
export function generateR2Key(contentType: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);

  // Map MIME type to extension
  const extMap: Record<string, string> = {
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/vnd.wave': 'wav',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
    'audio/opus': 'opus',
  };

  const ext = extMap[contentType.toLowerCase()] || 'bin';

  return `temp/${timestamp}-${random}.${ext}`;
}
