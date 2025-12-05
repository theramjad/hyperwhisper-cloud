// STREAMING TRANSCRIPTION HANDLER
// Handler for POST /transcribe endpoint - zero-buffer streaming to Deepgram
//
// KEY MEMORY OPTIMIZATION:
// This handler pipes request.body (ReadableStream) directly to Deepgram
// without buffering the audio in memory. This reduces memory usage from
// ~34MB (2x file size for multipart) to ~0MB for large files.
//
// FLOW:
// 1. Validate Content-Type is audio/*
// 2. Validate Content-Length header exists (required for credit estimation)
// 3. Extract auth and options from query params
// 4. Estimate credits from Content-Length BEFORE consuming stream
// 5. Validate credits (Polar meter or device credits)
// 6. Pipe request.body directly to Deepgram
// 7. Calculate actual cost and deduct credits
// 8. Return simplified response

import type { Env, StreamingTranscriptionResponse } from '../types';
import { Logger } from '../utils/logger';
import { roundToTenth, roundUpToTenth, retryWithBackoff } from '../utils/utils';
import { getCORSHeaders } from '../middleware/handlers';
import {
  transcribeWithDeepgramStream,
  transcribeWithDeepgramUrl,
  StreamingTranscriptionResult,
} from '../api/deepgram-client';
import {
  uploadToR2,
  generateR2PresignedUrl,
  deleteFromR2,
  generateR2Key,
} from '../utils/r2-utils';
import { formatUsd } from '../billing/cost-calculator';
import {
  createPolarClient,
  validateAndGetCustomer,
  getCustomerMeterBalance,
  ingestUsageEvent,
  calculateCreditsForCost,
  hasSufficientBalance,
} from '../billing/polar-billing';
import {
  getDeviceBalance,
  deductDeviceCredits,
  hasDeviceSufficientCredits,
} from '../billing/device-credits';
import {
  checkRateLimit,
  incrementUsage,
  isIPBlocked,
  formatRateLimitHeaders,
} from '../middleware/rate-limiter';
import { CREDITS_PER_MINUTE, TRIAL_CREDIT_ALLOCATION } from '../constants/credits';

// ============================================================================
// CREDIT ESTIMATION
// ============================================================================

// Approximate audio bitrate for credit estimation
// Most compressed audio (m4a, mp3, aac) is ~128kbps = 16KB/sec
// This means ~1MB ≈ 60 seconds of audio
const BYTES_PER_MINUTE_ESTIMATE = 1024 * 1024; // 1MB per minute (conservative)

// LARGE FILE THRESHOLD FOR R2 UPLOAD PATH
// Files larger than this will be uploaded to R2 first, then Deepgram fetches via URL.
// This bypasses Cloudflare Worker streaming issues with large files.
//
// WHY 30MB:
// - Cloudflare Worker streaming fails for large files (>30MB) with Deepgram
// - Most microphone recordings are <10MB (a few minutes)
// - File imports (podcasts, lectures) can be 50-200MB
// - 30MB provides safety margin while keeping small files fast (no R2 overhead)
const LARGE_FILE_THRESHOLD = 30 * 1024 * 1024; // 30MB

/**
 * ESTIMATE CREDITS FROM CONTENT-LENGTH
 * Uses file size to approximate audio duration before consuming the stream
 *
 * This is a rough estimate - actual cost will be calculated from Deepgram's
 * reported duration. We use this to validate credits BEFORE streaming starts.
 *
 * @param contentLength - Content-Length header value in bytes
 * @returns Estimated credits needed
 */
function estimateCreditsFromContentLength(contentLength: number): number {
  // Estimate duration: ~1MB per minute of compressed audio
  const estimatedMinutes = contentLength / BYTES_PER_MINUTE_ESTIMATE;
  const estimatedSeconds = Math.max(10, estimatedMinutes * 60);

  // Convert to credits using shared rate
  const estimatedCredits = (estimatedSeconds / 60) * CREDITS_PER_MINUTE;

  return Math.max(0.1, roundUpToTenth(estimatedCredits));
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * STREAMING TRANSCRIPTION HANDLER
 * Handles POST /transcribe requests with zero-buffer streaming
 *
 * Query Parameters:
 * - license_key: Licensed user authentication (required if no device_id)
 * - device_id: Trial user authentication (required if no license_key)
 * - language: ISO language code or "auto" (optional)
 * - mode: Transcription mode for logging (optional)
 * - initial_prompt: Comma-separated vocabulary terms (optional)
 *
 * Headers:
 * - Content-Type: Must be audio/* (e.g., audio/mp4, audio/mpeg)
 * - Content-Length: Required for credit estimation
 *
 * Body:
 * - Raw binary audio data (streamed directly to Deepgram)
 *
 * @param request - Incoming HTTP request
 * @param env - Environment variables
 * @param ctx - Execution context for waitUntil
 * @param logger - Logger instance
 * @param clientIP - Client IP address
 * @returns HTTP response with transcription result
 */
export async function handleStreamingTranscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  clientIP: string
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url);

  try {
    // ========================================================================
    // STEP 1: Check if IP is blocked
    // ========================================================================
    if (await isIPBlocked(env.RATE_LIMITER, clientIP)) {
      logger.log('warn', 'Blocked IP attempted streaming access', { ip: clientIP });
      return new Response(JSON.stringify({
        error: 'Access denied',
        message: 'Your IP has been temporarily blocked due to abuse'
      }), {
        status: 403,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 2: Validate Content-Type header
    // ========================================================================
    const contentType = request.headers.get('content-type') || '';

    if (!contentType.startsWith('audio/')) {
      logger.log('warn', 'Invalid Content-Type for streaming', { contentType });
      return new Response(JSON.stringify({
        error: 'Invalid Content-Type',
        message: 'Content-Type must be audio/* (e.g., audio/mp4, audio/mpeg, audio/wav)',
        received: contentType
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 3: Validate Content-Length header
    // ========================================================================
    const contentLengthHeader = request.headers.get('content-length');

    if (!contentLengthHeader) {
      logger.log('warn', 'Missing Content-Length header for streaming');
      return new Response(JSON.stringify({
        error: 'Missing Content-Length',
        message: 'Content-Length header is required for streaming transcription'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    const contentLength = parseInt(contentLengthHeader, 10);

    if (isNaN(contentLength) || contentLength <= 0) {
      logger.log('warn', 'Invalid Content-Length value', { contentLengthHeader });
      return new Response(JSON.stringify({
        error: 'Invalid Content-Length',
        message: 'Content-Length must be a positive integer'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // Enforce maximum file size (2 GB - Deepgram's limit)
    const MAX_AUDIO_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB in bytes
    if (contentLength > MAX_AUDIO_SIZE) {
      logger.log('warn', 'Audio file exceeds maximum size', {
        contentLength,
        maxSize: MAX_AUDIO_SIZE,
      });
      return new Response(JSON.stringify({
        error: 'File too large',
        message: `Audio file must be 2 GB or smaller. Your file is ${(contentLength / (1024 * 1024)).toFixed(2)} MB.`,
        max_size_mb: 2048,
        actual_size_mb: parseFloat((contentLength / (1024 * 1024)).toFixed(2))
      }), {
        status: 413, // Payload Too Large
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 4: Extract parameters from query string
    // ========================================================================
    const licenseKey = url.searchParams.get('license_key') || undefined;
    const deviceId = url.searchParams.get('device_id') || undefined;
    const language = url.searchParams.get('language') || undefined;
    const mode = url.searchParams.get('mode') || undefined;
    const initialPrompt = url.searchParams.get('initial_prompt') || undefined;

    logger.log('info', 'Streaming transcription request', {
      contentType,
      contentLength,
      hasLicenseKey: !!licenseKey,
      hasDeviceId: !!deviceId,
      language: language || 'auto',
      mode,
      hasInitialPrompt: !!initialPrompt,
    });

    // ========================================================================
    // STEP 5: Validate authentication
    // ========================================================================
    if (!licenseKey && !deviceId) {
      logger.log('warn', 'Streaming request rejected - no identifier provided');
      return new Response(JSON.stringify({
        error: 'Identifier required',
        message: 'You must provide either a license_key or device_id query parameter'
      }), {
        status: 401,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 6: Estimate credits BEFORE consuming stream
    // ========================================================================
    const estimatedCredits = estimateCreditsFromContentLength(contentLength);

    logger.log('info', 'Credit estimation from Content-Length', {
      contentLength,
      estimatedCredits,
    });

    // ========================================================================
    // STEP 7: Validate credits (licensed vs trial user)
    // ========================================================================
    let customerId: string | null = null;
    let isLicensed = false;
    let isTrial = false;
    let polar: ReturnType<typeof createPolarClient> | null = null;

    if (licenseKey) {
      // LICENSED USER: Validate with Polar and check meter balance
      logger.log('info', 'Processing streaming request for licensed user');

      polar = createPolarClient(env.POLAR_ACCESS_TOKEN, (env as any).ENVIRONMENT);

      // Validate license and get customer ID (with cache)
      const validation = await validateAndGetCustomer(
        polar,
        env.LICENSE_CACHE,
        licenseKey,
        env.POLAR_ORGANIZATION_ID,
        logger
      );

      if (!validation.isValid || !validation.customerId) {
        logger.log('warn', 'Invalid license key provided for streaming');
        return new Response(JSON.stringify({
          error: 'Invalid license',
          message: 'The provided license key is invalid or expired'
        }), {
          status: 401,
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      customerId = validation.customerId;
      isLicensed = true;

      // Check meter balance
      const meterStatus = await getCustomerMeterBalance(
        polar,
        customerId,
        env.POLAR_ORGANIZATION_ID,
        env.POLAR_METER_ID,
        logger
      );

      const balanceCredits = roundToTenth(meterStatus.balance);

      if (!hasSufficientBalance(balanceCredits, estimatedCredits)) {
        logger.log('warn', 'Insufficient balance for licensed user (streaming)', {
          customerId,
          balance: balanceCredits,
          estimated: estimatedCredits
        });

        const minutesRemaining = Math.floor(balanceCredits / CREDITS_PER_MINUTE);
        const minutesRequired = Math.ceil(estimatedCredits / CREDITS_PER_MINUTE);

        return new Response(JSON.stringify({
          error: 'Insufficient credits',
          message: `You have ${balanceCredits.toFixed(1)} credits remaining. This transcription requires approximately ${estimatedCredits.toFixed(1)} credits.`,
          credits_remaining: balanceCredits,
          minutes_remaining: minutesRemaining,
          minutes_required: minutesRequired,
          credits_per_minute: CREDITS_PER_MINUTE,
        }), {
          status: 402, // Payment Required
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      logger.log('info', 'Licensed user authorized for streaming', {
        customerId,
        balance: balanceCredits,
        estimated: estimatedCredits
      });

    } else if (deviceId) {
      // TRIAL USER: Check device credits AND IP rate limit
      isTrial = true;

      logger.log('info', 'Processing streaming request for trial user', { deviceId });

      // STEP 7a: Check device credit balance
      const deviceBalance = await getDeviceBalance(env.DEVICE_CREDITS, deviceId, logger);

      if (!hasDeviceSufficientCredits(deviceBalance, estimatedCredits)) {
        logger.log('warn', 'Insufficient device credits for trial user (streaming)', {
          deviceId,
          balance: deviceBalance.creditsRemaining,
          estimated: estimatedCredits
        });

        const minutesRemaining = Math.floor(deviceBalance.creditsRemaining / CREDITS_PER_MINUTE);
        const minutesRequired = Math.ceil(estimatedCredits / CREDITS_PER_MINUTE);

        return new Response(JSON.stringify({
          error: 'Insufficient credits',
          message: `Your trial has ${deviceBalance.creditsRemaining.toFixed(1)} credits remaining. This transcription requires approximately ${estimatedCredits.toFixed(1)} credits. Please upgrade to continue.`,
          credits_remaining: deviceBalance.creditsRemaining,
          credits_used: deviceBalance.creditsUsed,
          total_allocated: deviceBalance.totalAllocated,
          minutes_remaining: minutesRemaining,
          minutes_required: minutesRequired,
          credits_per_minute: CREDITS_PER_MINUTE,
        }), {
          status: 402, // Payment Required
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      // STEP 7b: Check IP rate limit (anti-abuse)
      const rateLimitStatus = await checkRateLimit(
        env.RATE_LIMITER,
        clientIP,
        estimatedCredits,
        logger
      );

      if (!rateLimitStatus.allowed) {
        logger.log('warn', 'IP rate limit exceeded for trial user (streaming)', {
          deviceId,
          ip: clientIP,
          used: rateLimitStatus.creditsUsed,
          remaining: rateLimitStatus.creditsRemaining
        });

        return new Response(JSON.stringify({
          error: 'Rate limit exceeded',
          message: `IP-based rate limit exceeded. You have used ${rateLimitStatus.creditsUsed.toFixed(1)} of ${TRIAL_CREDIT_ALLOCATION} credits today from this network. Resets at ${rateLimitStatus.resetsAt.toISOString()}.`,
          credits_remaining: rateLimitStatus.creditsRemaining,
          resets_at: rateLimitStatus.resetsAt.toISOString(),
        }), {
          status: 429, // Too Many Requests
          headers: {
            ...getCORSHeaders(),
            ...formatRateLimitHeaders(rateLimitStatus),
            'content-type': 'application/json',
          }
        });
      }

      logger.log('info', 'Trial user authorized for streaming', {
        deviceId,
        deviceCredits: deviceBalance.creditsRemaining,
        ipQuotaRemaining: rateLimitStatus.creditsRemaining
      });
    }

    // ========================================================================
    // STEP 8: Validate API key
    // ========================================================================
    if (!env.DEEPGRAM_API_KEY || env.DEEPGRAM_API_KEY.trim().length === 0) {
      logger.log('error', 'Missing Deepgram API key');
      return new Response(JSON.stringify({
        error: 'Server misconfigured',
        message: 'Deepgram API key is not set on the worker',
        requestId,
      }), {
        status: 500,
        headers: {
          ...getCORSHeaders(),
          'content-type': 'application/json',
          'X-Request-ID': requestId,
        }
      });
    }

    // ========================================================================
    // STEP 9: Transcribe audio (hybrid approach based on file size)
    // ========================================================================
    const sttStartTime = Date.now();

    const audioBody = request.body;

    if (!audioBody) {
      logger.log('error', 'Request body is null for streaming');
      return new Response(JSON.stringify({
        error: 'Empty body',
        message: 'Request body is empty'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // HYBRID TRANSCRIPTION APPROACH:
    // - Small files (<30MB): Stream directly to Deepgram (faster, no R2 overhead)
    // - Large files (>=30MB): Upload to R2, use URL-based transcription (reliable)
    //
    // WHY:
    // Cloudflare Workers uses Transfer-Encoding: chunked for ReadableStream bodies,
    // which causes Deepgram to fail with 422 errors for large files.
    // R2 + URL-based transcription bypasses this entirely.

    let transcriptionResult: StreamingTranscriptionResult;

    if (contentLength >= LARGE_FILE_THRESHOLD) {
      // ====================================================================
      // LARGE FILE PATH: R2 upload + URL-based transcription
      // ====================================================================
      logger.log('info', 'Large file detected, using R2 upload path', {
        contentLength,
        contentLengthMB: (contentLength / (1024 * 1024)).toFixed(2),
        threshold: LARGE_FILE_THRESHOLD,
      });

      // Generate unique key for this audio file
      const r2Key = generateR2Key(contentType);

      try {
        // STEP 9a: Upload audio stream to R2 (streams without buffering)
        await uploadToR2(
          env.AUDIO_BUCKET,
          r2Key,
          audioBody as ReadableStream<Uint8Array>,
          contentType
        );

        logger.log('info', 'Audio uploaded to R2', { r2Key });

        // STEP 9b: Generate presigned URL for Deepgram to fetch
        // Note: We need to get bucket name from wrangler.toml config
        // Since R2Bucket binding doesn't expose the name, we derive it from environment
        const bucketName = (env as any).ENVIRONMENT === 'production'
          ? 'hyperwhisper-audio-temp-prod'
          : 'hyperwhisper-audio-temp-dev';

        const presignedUrl = await generateR2PresignedUrl(
          env.R2_ACCOUNT_ID,
          env.R2_ACCESS_KEY_ID,
          env.R2_SECRET_ACCESS_KEY,
          bucketName,
          r2Key,
          15 * 60 // 15 minute expiry
        );

        logger.log('info', 'Generated presigned URL for Deepgram', {
          r2Key,
          expiresInMinutes: 15,
        });

        // STEP 9c: Send URL to Deepgram (Deepgram fetches from R2)
        transcriptionResult = await transcribeWithDeepgramUrl(
          presignedUrl,
          language,
          initialPrompt,
          env,
          logger
        );

        // STEP 9d: Clean up R2 file after transcription (non-blocking)
        ctx.waitUntil(
          deleteFromR2(env.AUDIO_BUCKET, r2Key).catch(err => {
            logger.log('warn', 'Failed to delete R2 file (will be auto-deleted by lifecycle rule)', {
              r2Key,
              error: String(err),
            });
          })
        );

      } catch (error) {
        // Attempt cleanup on error (non-blocking)
        ctx.waitUntil(
          deleteFromR2(env.AUDIO_BUCKET, r2Key).catch(() => {})
        );
        throw error;
      }

    } else {
      // ====================================================================
      // SMALL FILE PATH: Direct streaming to Deepgram
      // ====================================================================
      logger.log('info', 'Small file, using direct streaming path', {
        contentLength,
        contentLengthMB: (contentLength / (1024 * 1024)).toFixed(2),
        threshold: LARGE_FILE_THRESHOLD,
      });

      transcriptionResult = await transcribeWithDeepgramStream(
        audioBody,
        contentType,
        contentLength,
        language,
        initialPrompt,
        env,
        logger
      );
    }

    const sttLatencyMs = Date.now() - sttStartTime;

    logger.log('info', 'Streaming transcription complete', {
      sttLatencyMs,
      sttProvider: 'deepgram-nova3',
      detectedLanguage: transcriptionResult.language,
      audioDuration: transcriptionResult.durationSeconds,
      textLength: transcriptionResult.text.length,
      costUsd: transcriptionResult.costUsd,
    });

    // ========================================================================
    // STEP 10: Handle no speech detected
    // ========================================================================
    if (transcriptionResult.source === 'no_speech') {
      logger.log('info', 'No speech detected in streaming audio', { sttLatencyMs });

      const response: StreamingTranscriptionResponse = {
        text: '',
        language: transcriptionResult.language,
        duration: 0,
        cost: { usd: 0, credits: 0 },
        metadata: {
          request_id: requestId,
          stt_provider: 'deepgram-nova3',
        },
        no_speech_detected: true,
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
          ...getCORSHeaders(),
          'content-type': 'application/json',
          'X-Request-ID': requestId,
          'X-Credits-Used': '0',
        }
      });
    }

    // ========================================================================
    // STEP 11: Calculate actual cost and deduct credits
    // ========================================================================
    const actualCredits = roundToTenth(calculateCreditsForCost(transcriptionResult.costUsd));

    // Update usage tracking
    if (isLicensed && customerId && polar) {
      // LICENSED USER: Ingest event to Polar
      ctx.waitUntil(
        ingestUsageEvent(
          polar,
          customerId,
          actualCredits,
          {
            audio_duration_seconds: transcriptionResult.durationSeconds,
            transcription_cost_usd: transcriptionResult.costUsd,
            total_cost_usd: transcriptionResult.costUsd,
            language: transcriptionResult.language ?? language ?? 'auto',
            mode,
            endpoint: '/transcribe',
            streaming: true,
          },
          logger
        )
      );

      logger.log('info', 'Usage event queued for Polar (streaming)', {
        customerId,
        credits: actualCredits
      });

    } else if (isTrial && deviceId) {
      // TRIAL USER: Deduct from device credits AND IP quota

      // Deduct from device credits
      ctx.waitUntil(
        deductDeviceCredits(env.DEVICE_CREDITS, deviceId, actualCredits, logger)
      );

      // Also deduct from IP rate limit (anti-abuse)
      ctx.waitUntil(
        incrementUsage(env.RATE_LIMITER, clientIP, actualCredits, logger)
      );

      logger.log('info', 'Usage tracked for trial user (streaming)', {
        deviceId,
        ip: clientIP,
        credits: actualCredits
      });
    }

    // ========================================================================
    // STEP 12: Return response
    // ========================================================================
    const requestLatencyMs = logger.getElapsedTime();

    logger.log('info', 'Streaming request completed successfully', {
      requestLatencyMs,
      sttLatencyMs,
      sttProvider: 'deepgram-nova3',
      transcriptChars: transcriptionResult.text.length,
      costUsd: transcriptionResult.costUsd,
      creditsDebited: actualCredits,
      isLicensed,
    });

    const response: StreamingTranscriptionResponse = {
      text: transcriptionResult.text,
      language: transcriptionResult.language,
      duration: transcriptionResult.durationSeconds,
      cost: {
        usd: transcriptionResult.costUsd,
        credits: actualCredits,
      },
      metadata: {
        request_id: requestId,
        stt_provider: 'deepgram-nova3',
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...getCORSHeaders(),
        'content-type': 'application/json',
        'X-Request-ID': requestId,
        'X-STT-Provider': 'deepgram-nova3',
        'X-Total-Cost-Usd': formatUsd(transcriptionResult.costUsd),
        'X-Credits-Used': actualCredits.toFixed(1),
      }
    });

  } catch (error) {
    logger.log('error', 'Streaming transcription failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });

    return new Response(JSON.stringify({
      error: 'Transcription failed',
      details: error instanceof Error ? error.message : 'Unknown error',
      requestId
    }), {
      status: 500,
      headers: {
        ...getCORSHeaders(),
        'content-type': 'application/json',
        'X-Request-ID': requestId
      }
    });
  }
}
