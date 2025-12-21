// LEGACY MULTIPART TRANSCRIPTION HANDLER
// Handler for POST / endpoint - buffered multipart form data transcription
//
// This endpoint is kept for backwards compatibility with older client versions (< v2.12.0)
// It reads the entire audio file into memory before processing, which:
// 1. Increases memory usage (up to ~34MB for large files)
// 2. Has a 128MB Cloudflare Worker memory limit
//
// For new clients, use POST /transcribe (streaming) + POST /post-process instead
//
// FLOW:
// 1. Parse multipart form data
// 2. Extract audio file into memory
// 3. Validate auth (license_key or device_id)
// 4. Validate credits (Polar meter or device credits)
// 5. Transcribe with Deepgram Nova-3
// 6. Optional: Post-process with Groq Llama 3.3 70B
// 7. Deduct credits and return response

import type { Env, TranscriptionRequest } from '../types';
import { Logger } from '../utils/logger';
import { parseBoolean, roundToTenth, roundUpToTenth, retryWithBackoff } from '../utils/utils';
import {
  extractCorrectedText,
  buildTranscriptUserContent,
  stripCleanMarkers,
} from '../utils/text-processing';
import { transcribeWithDeepgram } from '../api/deepgram-client';
import {
  requestGroqChat,
  buildCorrectionRequest,
} from '../api/groq-client';
import { formatUsd } from '../billing/cost-calculator';
import {
  validateAndGetCredits,
  recordUsage,
  calculateCreditsForCost,
  hasSufficientBalance,
} from '../billing/billing';
import {
  getDeviceBalance,
  deductDeviceCredits,
  hasDeviceSufficientCredits,
} from '../billing/device-credits';
import { getCORSHeaders } from '../middleware/handlers';
import {
  checkRateLimit,
  incrementUsage,
  isIPBlocked,
  formatRateLimitHeaders,
} from '../middleware/rate-limiter';
import { CREDITS_PER_MINUTE, TRIAL_CREDIT_ALLOCATION } from '../constants/credits';

// ============================================================================
// LEGACY HANDLER EXPORT
// ============================================================================

/**
 * Handle legacy POST / multipart transcription requests
 *
 * This handler:
 * 1. Parses multipart form data containing audio file
 * 2. Validates authentication (license_key or device_id)
 * 3. Checks credit balance
 * 4. Transcribes with Deepgram Nova-3
 * 5. Optionally post-processes with Groq Llama 3.3 70B
 * 6. Deducts credits and returns response
 *
 * @param request - The incoming HTTP request
 * @param env - Cloudflare Worker environment bindings
 * @param ctx - Execution context for background tasks
 * @param logger - Logger instance for this request
 * @param clientIP - Client IP address for rate limiting
 * @returns Response with transcription result or error
 */
export async function handleLegacyTranscription(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  clientIP: string
): Promise<Response> {
  const requestId = logger.getRequestId();

  try {
    // Check if IP is blocked (abuse prevention)
    if (await isIPBlocked(env.RATE_LIMITER, clientIP)) {
      logger.log('warn', 'Blocked IP attempted access', { ip: clientIP });
      return new Response(JSON.stringify({
        error: 'Access denied',
        message: 'Your IP has been temporarily blocked due to abuse'
      }), {
        status: 403,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    const contentType = request.headers.get('content-type') || '';
    let audioSize = 0;
    let requestData: TranscriptionRequest;

    // Parse multipart form data
    if (!contentType.includes('multipart/form-data')) {
      logger.log('warn', 'Unsupported content type', { contentType });
      return new Response(JSON.stringify({ error: 'Content-Type must be multipart/form-data' }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    const formData = await request.formData();

    // Extract audio file
    const audioFile = formData.get('audio');
    if (!audioFile || !(audioFile instanceof File)) {
      logger.log('warn', 'Multipart request missing audio file');
      return new Response(JSON.stringify({ error: 'Audio file required' }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // Read audio file into memory as raw binary (NOT base64)
    // MEMORY OPTIMIZATION: Previously we converted to base64 which:
    // 1. Added 33% size overhead (base64 expansion)
    // 2. Created multiple string copies during encoding
    // 3. Required decoding back to binary in deepgram-client.ts
    // Now we pass raw Uint8Array directly, saving ~65% memory
    const audioArrayBuffer = await audioFile.arrayBuffer();
    const audioBytes = new Uint8Array(audioArrayBuffer);
    audioSize = audioBytes.byteLength;

    // Enforce maximum file size (2 GB - Deepgram's limit)
    // Increased from 25 MB (Groq Whisper limit) to 2 GB for Deepgram Nova-3
    const MAX_AUDIO_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB in bytes
    if (audioSize > MAX_AUDIO_SIZE) {
      logger.log('warn', 'Audio file exceeds maximum size', {
        audioSize,
        maxSize: MAX_AUDIO_SIZE,
        fileName: audioFile.name
      });
      return new Response(JSON.stringify({
        error: 'File too large',
        message: `Audio file must be 2 GB or smaller. Your file is ${(audioSize / (1024 * 1024)).toFixed(2)} MB.`,
        max_size_mb: 2048,
        actual_size_mb: parseFloat((audioSize / (1024 * 1024)).toFixed(2))
      }), {
        status: 413, // Payload Too Large
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    const rawMimeType = typeof audioFile.type === 'string' ? audioFile.type.trim() : '';
    const rawFileName = typeof audioFile.name === 'string' ? audioFile.name.trim() : '';
    let audioMimeType = rawMimeType.length > 0 ? rawMimeType : undefined;
    const audioFileName = rawFileName.length > 0 ? rawFileName : undefined;

    if (!audioMimeType && audioFileName) {
      const lowered = audioFileName.toLowerCase();
      if (lowered.endsWith('.wav')) {
        audioMimeType = 'audio/wav';
      } else if (lowered.endsWith('.mp3') || lowered.endsWith('.mpeg') || lowered.endsWith('.mpga')) {
        audioMimeType = 'audio/mpeg';
      } else if (lowered.endsWith('.flac')) {
        audioMimeType = 'audio/flac';
      } else if (lowered.endsWith('.ogg')) {
        audioMimeType = 'audio/ogg';
      } else if (lowered.endsWith('.opus')) {
        audioMimeType = 'audio/opus';
      } else if (lowered.endsWith('.webm')) {
        audioMimeType = 'audio/webm';
      } else if (lowered.endsWith('.m4a') || lowered.endsWith('.mp4')) {
        audioMimeType = 'audio/mp4';
      }
    }

    // Build TranscriptionRequest from form fields
    // Pass raw binary audio directly (NOT base64) to save memory
    requestData = {
      audio: audioBytes,
      audioMimeType,
      audioFileName,
      device_id: formData.get('device_id') as string | undefined,
      license_key: formData.get('license_key') as string | undefined,
      language: formData.get('language') as string | undefined,
      mode: formData.get('mode') as string | undefined,
      initial_prompt: formData.get('initial_prompt') as string | undefined,
      post_processing_enabled: parseBoolean(formData.get('post_processing_enabled')),
      post_processing_prompt: formData.get('post_processing_prompt') as string | undefined,
    };

    // Normalize optional fields
    if (typeof requestData.post_processing_prompt === 'string') {
      const trimmed = requestData.post_processing_prompt.trim();
      if (trimmed.length === 0) {
        delete requestData.post_processing_prompt;
      } else {
        requestData.post_processing_prompt = trimmed;
      }
    }

    if (typeof requestData.initial_prompt === 'string') {
      const trimmedInitial = requestData.initial_prompt.trim();
      if (trimmedInitial.length === 0) {
        delete requestData.initial_prompt;
      } else {
        requestData.initial_prompt = trimmedInitial;
      }
    }

    logger.log('info', 'Processing multipart request', {
      audioSize,
      audioFileName: audioFile.name,
      language: requestData.language,
      mode: requestData.mode,
      hasLicenseKey: !!requestData.license_key,
      postProcessingEnabled: requestData.post_processing_enabled,
      hasPostProcessingPrompt: !!requestData.post_processing_prompt,
      hasInitialPrompt: !!requestData.initial_prompt,
    });

    // Estimate credits needed (rough estimate before actual processing)
    const estimatedSeconds = Math.max(10, Math.ceil(audioSize / (1024 * 1024) * 60));
    const estimatedCredits = Math.max(
      0.1,
      roundUpToTenth((estimatedSeconds / 60) * CREDITS_PER_MINUTE)
    ); // Shared credits-to-minutes estimate (0.1 credit granularity)

    let isLicensed = false;
    let isTrial = false;
    let deviceId: string | null = null;
    let licensedCredits = 0;

    // CHECK AUTHORIZATION: Require license_key OR device_id (no anonymous access)
    if (!requestData.license_key && !requestData.device_id) {
      logger.log('warn', 'Request rejected - no identifier provided');

      return new Response(JSON.stringify({
        error: 'Identifier required',
        message: 'You must provide either a license_key or device_id'
      }), {
        status: 401,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    if (requestData.license_key) {
      // LICENSED USER: Validate with Next.js API and check credit balance
      logger.log('info', 'Processing request for licensed user');

      // Validate license and get credit balance (with cache)
      const validation = await validateAndGetCredits(
        env.LICENSE_CACHE,
        requestData.license_key,
        env.HYPERWHISPER_API_URL,
        env.HYPERWHISPER_API_KEY,
        logger
      );

      if (!validation.isValid) {
        logger.log('warn', 'Invalid license key provided');

        return new Response(JSON.stringify({
          error: 'Invalid license',
          message: 'The provided license key is invalid or expired'
        }), {
          status: 401,
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      isLicensed = true;
      licensedCredits = validation.credits;

      const balanceCredits = roundToTenth(licensedCredits);

      if (!hasSufficientBalance(balanceCredits, estimatedCredits)) {
        logger.log('warn', 'Insufficient balance for licensed user', {
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

      logger.log('info', 'Licensed user authorized', {
        balance: balanceCredits,
        estimated: estimatedCredits
      });

    } else if (requestData.device_id) {
      // TRIAL USER: Check device credits AND IP rate limit (both must pass)
      deviceId = requestData.device_id;
      isTrial = true;

      logger.log('info', 'Processing request for trial user', {
        deviceId
      });

      // STEP 1: Check device credit balance
      const deviceBalance = await getDeviceBalance(env.DEVICE_CREDITS, deviceId, logger);

      if (!hasDeviceSufficientCredits(deviceBalance, estimatedCredits)) {
        logger.log('warn', 'Insufficient device credits for trial user', {
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

      // STEP 2: Check IP rate limit (anti-abuse)
      const rateLimitStatus = await checkRateLimit(
        env.RATE_LIMITER,
        clientIP,
        estimatedCredits,
        logger
      );

      if (!rateLimitStatus.allowed) {
        logger.log('warn', 'IP rate limit exceeded for trial user', {
          deviceId,
          ip: clientIP,
          used: rateLimitStatus.creditsUsed,
          remaining: rateLimitStatus.creditsRemaining
        });

        return new Response(JSON.stringify({
          error: 'Rate limit exceeded',
          message: `IP-based rate limit exceeded. You have used ${rateLimitStatus.creditsUsed.toFixed(1)} of ${TRIAL_CREDIT_ALLOCATION} credits today from this network (~${Math.round(TRIAL_CREDIT_ALLOCATION / CREDITS_PER_MINUTE)} minutes). Resets at ${rateLimitStatus.resetsAt.toISOString()}.`,
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

      logger.log('info', 'Trial user authorized', {
        deviceId,
        deviceCredits: deviceBalance.creditsRemaining,
        ipQuotaRemaining: rateLimitStatus.creditsRemaining
      });
    }

    // Validate Deepgram API key (required for STT)
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

    // Validate Groq API key (required for post-processing)
    if (!env.GROQ_API_KEY || env.GROQ_API_KEY.trim().length === 0) {
      logger.log('error', 'Missing Groq API key');
      return new Response(JSON.stringify({
        error: 'Server misconfigured',
        message: 'Groq API key is not set on the worker',
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

    // TRANSCRIPTION: Process audio with Deepgram Nova-3 (with retry logic)
    // Deepgram provides better accuracy and keyword boosting compared to Groq Whisper
    logger.log('info', 'Preparing Deepgram transcription request');
    const sttStartTime = Date.now();

    // Wrap transcription in retry logic to handle transient failures
    // This provides resilience against network issues, API timeouts, and temporary service unavailability
    // Retry schedule: 1s, 2s, 4s delays = 4 total attempts over ~7 seconds
    const transcriptionResult = await retryWithBackoff(
      () => transcribeWithDeepgram(requestData, env, logger, estimatedSeconds),
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        onRetry: (attempt, error, delayMs) => {
          logger.log('warn', 'Deepgram transcription retry', {
            attempt,
            maxRetries: 3,
            error: error.message,
            delayMs,
            willRetryAfterMs: delayMs,
          });
        }
      }
    );
    const sttLatencyMs = Date.now() - sttStartTime;

    const baseTranscription = transcriptionResult.text;

    logger.log('info', 'Transcription complete', {
      sttLatencyMs,
      sttProvider: 'deepgram-nova3',
      detectedLanguage: transcriptionResult.language,
      audioDuration: transcriptionResult.durationSeconds,
      textLength: baseTranscription.length,
      segmentCount: transcriptionResult.segments?.length ?? 0,
      transcriptionSource: transcriptionResult.source,
      sttCostUsd: transcriptionResult.costUsd,
    });

    // NO SPEECH DETECTED:
    // When Deepgram returns a valid response but with empty text, return success with a flag
    // instead of treating it as an error. This allows the client to show a friendly message.
    // We don't charge credits for empty transcriptions.
    if (transcriptionResult.source === 'no_speech') {
      logger.log('info', 'No speech detected - returning empty transcription', {
        sttLatencyMs,
      });

      return new Response(JSON.stringify({
        original: '',
        corrected: '',
        no_speech_detected: true,
        requestId,
      }), {
        status: 200,
        headers: {
          ...getCORSHeaders(),
          'content-type': 'application/json',
          'X-Request-ID': requestId,
          'X-Credits-Used': '0',
        }
      });
    }

    // POST-PROCESSING: Optional AI enhancement
    const normalizedSystemPrompt = typeof requestData.post_processing_prompt === 'string'
      ? requestData.post_processing_prompt.trim()
      : undefined;
    let shouldPostProcess = requestData.post_processing_enabled !== false;

    if (shouldPostProcess && (!normalizedSystemPrompt || normalizedSystemPrompt.length === 0)) {
      logger.log('warn', 'Cleanup requested without prompt; skipping');
      shouldPostProcess = false;
    }

    logger.log('info', 'Cleanup configuration', {
      shouldPostProcess,
      hasSystemPrompt: !!normalizedSystemPrompt && normalizedSystemPrompt.length > 0,
      mode: requestData.mode,
      hasInitialPrompt: !!requestData.initial_prompt,
    });

    let correctedText = baseTranscription;
    let cleanupLatencyMs = 0;
    let cleanupCostUsd = 0;

    if (shouldPostProcess) {
      const correctionStartTime = Date.now();
      const systemPrompt = normalizedSystemPrompt!;
      const userContent = buildTranscriptUserContent(baseTranscription);
      const basePayload = buildCorrectionRequest(systemPrompt, userContent);

      try {
        // Wrap post-processing in retry logic to handle transient failures
        // This ensures cleanup/correction step is resilient to temporary API issues
        // Retry schedule: 1s, 2s, 4s delays = 4 total attempts over ~7 seconds
        const correctionResponse = await retryWithBackoff(
          () => requestGroqChat(env, basePayload, logger, requestId),
          {
            maxRetries: 3,
            initialDelayMs: 1000,
            backoffMultiplier: 2,
            onRetry: (attempt, error, delayMs) => {
              logger.log('warn', 'Groq post-processing retry', {
                attempt,
                maxRetries: 3,
                error: error.message,
                delayMs,
                willRetryAfterMs: delayMs,
              });
            }
          }
        );
        correctedText = stripCleanMarkers(extractCorrectedText(correctionResponse.raw));
        cleanupCostUsd = correctionResponse.costUsd;
        cleanupLatencyMs = Date.now() - correctionStartTime;

        logger.log('info', 'Cleanup complete', {
          cleanupLatencyMs,
          promptTokens: correctionResponse.usage?.prompt_tokens,
          completionTokens: correctionResponse.usage?.completion_tokens,
          cleanupCostUsd,
        });
      } catch (postProcessingError) {
        cleanupLatencyMs = Date.now() - correctionStartTime;
        correctedText = baseTranscription;
        shouldPostProcess = false;

        logger.log('error', 'Cleanup failed; returning transcription without correction', {
          error: postProcessingError instanceof Error ? postProcessingError.message : 'Unknown error',
          cleanupLatencyMs,
        });
      }
    } else {
      logger.log('info', 'Cleanup skipped', {
        reason: 'Disabled by client',
      });
    }

    // BILLING: Track usage based on actual cost
    const totalCostUsd = transcriptionResult.costUsd + cleanupCostUsd;
    const actualCredits = roundToTenth(calculateCreditsForCost(totalCostUsd));

    // Update usage tracking
    if (isLicensed && requestData.license_key) {
      // LICENSED USER: Record usage via Next.js API
      ctx.waitUntil(
        recordUsage(
          env.HYPERWHISPER_API_URL,
          env.HYPERWHISPER_API_KEY,
          requestData.license_key,
          actualCredits,
          {
            audio_duration_seconds: transcriptionResult.durationSeconds,
            transcription_cost_usd: transcriptionResult.costUsd,
            post_processing_cost_usd: cleanupCostUsd,
            total_cost_usd: totalCostUsd,
            // Fallback chain: detected language → requested language → 'auto'
            language: transcriptionResult.language ?? requestData.language ?? 'auto',
            mode: requestData.mode,
            post_processing_applied: shouldPostProcess,
          },
          logger
        )
      );

      logger.log('info', 'Usage event queued for recording', {
        credits: actualCredits
      });

    } else if (isTrial && deviceId) {
      // TRIAL USER: Deduct from device credits AND IP quota (dual tracking)

      // Deduct from device credits
      ctx.waitUntil(
        deductDeviceCredits(env.DEVICE_CREDITS, deviceId, actualCredits, logger)
      );

      // Also deduct from IP rate limit (anti-abuse)
      ctx.waitUntil(
        incrementUsage(env.RATE_LIMITER, clientIP, actualCredits, logger)
      );

      logger.log('info', 'Usage tracked for trial user', {
        deviceId,
        ip: clientIP,
        credits: actualCredits
      });
    }

    const requestLatencyMs = logger.getElapsedTime();

    logger.log('info', 'Request completed successfully', {
      requestLatencyMs,
      sttLatencyMs,
      sttProvider: 'deepgram-nova3',
      cleanupLatencyMs,
      rawTranscriptChars: baseTranscription.length,
      cleanTranscriptChars: correctedText.length,
      postProcessingApplied: shouldPostProcess,
      cleanupPromptChars: normalizedSystemPrompt?.length ?? 0,
      sttCostUsd: transcriptionResult.costUsd,
      cleanupCostUsd,
      totalCostUsd,
      creditsDebited: actualCredits,
      isLicensed,
    });

    // Return the final transcription
    return new Response(JSON.stringify({
      original: baseTranscription,
      corrected: correctedText,
      metadata: {
        language: transcriptionResult.language,
        duration: transcriptionResult.durationSeconds,
        segments: transcriptionResult.segments,
        requestId,
        is_licensed: isLicensed,
        stt_provider: 'deepgram-nova3', // Added to track which provider was used
      },
      costs: {
        transcription_usd: transcriptionResult.costUsd,
        post_processing_usd: cleanupCostUsd,
        total_usd: totalCostUsd,
        credits: actualCredits,
      }
    }), {
      headers: {
        ...getCORSHeaders(),
        'content-type': 'application/json',
        'X-Request-ID': requestId,
        'X-STT-Provider': 'deepgram-nova3',
        'X-Transcription-Cost-Usd': formatUsd(transcriptionResult.costUsd),
        'X-Post-Processing-Cost-Usd': formatUsd(cleanupCostUsd),
        'X-Total-Cost-Usd': formatUsd(totalCostUsd),
        'X-Credits-Used': actualCredits.toFixed(1),
      }
    });
  } catch (error) {
    logger.log('error', 'Request failed', {
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
