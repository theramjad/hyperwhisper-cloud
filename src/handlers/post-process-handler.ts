// POST-PROCESS HANDLER
// Handler for POST /post-process endpoint - standalone text correction via Groq Llama
//
// This endpoint accepts raw transcription text and applies AI-powered post-processing
// using Groq Llama 3.3 70B. It can be called independently of /transcribe, allowing
// clients to:
// 1. Process text from any source (not just HyperWhisper transcriptions)
// 2. Re-process existing transcriptions with different prompts
// 3. Apply corrections in a separate step from transcription
//
// BILLING:
// Each call deducts credits based on Groq token usage (~$0.001/request)
// This is separate from /transcribe billing

import type { Env, PostProcessRequest, PostProcessResponse } from '../types';
import { Logger } from '../utils/logger';
import { roundToTenth, retryWithBackoff } from '../utils/utils';
import { getCORSHeaders } from '../middleware/handlers';
import {
  requestGroqChat,
  buildCorrectionRequest,
} from '../api/groq-client';
import {
  extractCorrectedText,
  buildTranscriptUserContent,
  stripCleanMarkers,
} from '../utils/text-processing';
import {
  validateAndGetCredits,
  recordUsage,
  calculateCreditsForCost,
  hasSufficientBalance,
} from '../billing/stripe-billing';
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
// CONSTANTS
// ============================================================================

// Estimated credits for post-processing (based on average Groq usage)
// Actual cost is ~$0.001 per request = ~1 credit
const ESTIMATED_POST_PROCESS_CREDITS = 1.0;

// Maximum text length to process (prevent abuse)
const MAX_TEXT_LENGTH = 100000; // ~25,000 words

// ============================================================================
// MAIN HANDLER
// ============================================================================

/**
 * POST-PROCESS HANDLER
 * Handles POST /post-process requests for text correction
 *
 * Request Body (JSON):
 * {
 *   "text": "raw transcription to correct",
 *   "prompt": "system prompt for correction",
 *   "license_key": "xxx" OR "device_id": "xxx"
 * }
 *
 * Response:
 * {
 *   "corrected": "corrected text",
 *   "cost": { "usd": 0.001, "credits": 1.0 }
 * }
 *
 * @param request - Incoming HTTP request
 * @param env - Environment variables
 * @param ctx - Execution context for waitUntil
 * @param logger - Logger instance
 * @param clientIP - Client IP address
 * @returns HTTP response with corrected text
 */
export async function handlePostProcess(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  logger: Logger,
  clientIP: string
): Promise<Response> {
  const requestId = crypto.randomUUID();

  try {
    // ========================================================================
    // STEP 1: Check if IP is blocked
    // ========================================================================
    if (await isIPBlocked(env.RATE_LIMITER, clientIP)) {
      logger.log('warn', 'Blocked IP attempted post-process access', { ip: clientIP });
      return new Response(JSON.stringify({
        error: 'Access denied',
        message: 'Your IP has been temporarily blocked due to abuse'
      }), {
        status: 403,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 2: Validate Content-Type
    // ========================================================================
    const contentType = request.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      logger.log('warn', 'Invalid Content-Type for post-process', { contentType });
      return new Response(JSON.stringify({
        error: 'Invalid Content-Type',
        message: 'Content-Type must be application/json',
        received: contentType
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 3: Parse and validate request body
    // ========================================================================
    let body: PostProcessRequest;

    try {
      body = await request.json() as PostProcessRequest;
    } catch (parseError) {
      logger.log('warn', 'Failed to parse JSON body', {
        error: parseError instanceof Error ? parseError.message : 'Unknown error'
      });
      return new Response(JSON.stringify({
        error: 'Invalid JSON',
        message: 'Request body must be valid JSON'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // Validate required fields
    if (!body.text || typeof body.text !== 'string') {
      logger.log('warn', 'Missing or invalid text field');
      return new Response(JSON.stringify({
        error: 'Missing field',
        message: 'Request body must include "text" field as a string'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    if (!body.prompt || typeof body.prompt !== 'string') {
      logger.log('warn', 'Missing or invalid prompt field');
      return new Response(JSON.stringify({
        error: 'Missing field',
        message: 'Request body must include "prompt" field as a string'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    const text = body.text.trim();
    const prompt = body.prompt.trim();

    // Validate text length
    if (text.length === 0) {
      logger.log('warn', 'Empty text field');
      return new Response(JSON.stringify({
        error: 'Empty text',
        message: 'Text field cannot be empty'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    if (text.length > MAX_TEXT_LENGTH) {
      logger.log('warn', 'Text exceeds maximum length', { length: text.length, max: MAX_TEXT_LENGTH });
      return new Response(JSON.stringify({
        error: 'Text too long',
        message: `Text must be ${MAX_TEXT_LENGTH} characters or less. Your text is ${text.length} characters.`,
        max_length: MAX_TEXT_LENGTH,
        actual_length: text.length
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // Validate prompt length
    if (prompt.length === 0) {
      logger.log('warn', 'Empty prompt field');
      return new Response(JSON.stringify({
        error: 'Empty prompt',
        message: 'Prompt field cannot be empty'
      }), {
        status: 400,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    const licenseKey = body.license_key;
    const deviceId = body.device_id;

    logger.log('info', 'Post-process request', {
      textLength: text.length,
      promptLength: prompt.length,
      hasLicenseKey: !!licenseKey,
      hasDeviceId: !!deviceId,
    });

    // ========================================================================
    // STEP 4: Validate authentication
    // ========================================================================
    if (!licenseKey && !deviceId) {
      logger.log('warn', 'Post-process request rejected - no identifier provided');
      return new Response(JSON.stringify({
        error: 'Identifier required',
        message: 'Request body must include either "license_key" or "device_id"'
      }), {
        status: 401,
        headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
      });
    }

    // ========================================================================
    // STEP 5: Validate credits
    // ========================================================================
    let isLicensed = false;
    let isTrial = false;
    let licensedCredits = 0;

    const estimatedCredits = ESTIMATED_POST_PROCESS_CREDITS;

    if (licenseKey) {
      // LICENSED USER: Validate with Next.js API and check credit balance
      logger.log('info', 'Processing post-process request for licensed user');

      // Validate license and get credit balance (with cache)
      const validation = await validateAndGetCredits(
        env.LICENSE_CACHE,
        licenseKey,
        env.HYPERWHISPER_API_URL,
        env.HYPERWHISPER_API_KEY,
        logger
      );

      if (!validation.isValid) {
        logger.log('warn', 'Invalid license key provided for post-process');
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
        logger.log('warn', 'Insufficient balance for licensed user (post-process)', {
          balance: balanceCredits,
          estimated: estimatedCredits
        });

        return new Response(JSON.stringify({
          error: 'Insufficient credits',
          message: `You have ${balanceCredits.toFixed(1)} credits remaining. Post-processing requires approximately ${estimatedCredits.toFixed(1)} credits.`,
          credits_remaining: balanceCredits,
          credits_per_minute: CREDITS_PER_MINUTE,
        }), {
          status: 402, // Payment Required
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      logger.log('info', 'Licensed user authorized for post-process', {
        balance: balanceCredits,
        estimated: estimatedCredits
      });

    } else if (deviceId) {
      // TRIAL USER: Check device credits AND IP rate limit
      isTrial = true;

      logger.log('info', 'Processing post-process request for trial user', { deviceId });

      // Check device credit balance
      const deviceBalance = await getDeviceBalance(env.DEVICE_CREDITS, deviceId, logger);

      if (!hasDeviceSufficientCredits(deviceBalance, estimatedCredits)) {
        logger.log('warn', 'Insufficient device credits for trial user (post-process)', {
          deviceId,
          balance: deviceBalance.creditsRemaining,
          estimated: estimatedCredits
        });

        return new Response(JSON.stringify({
          error: 'Insufficient credits',
          message: `Your trial has ${deviceBalance.creditsRemaining.toFixed(1)} credits remaining. Post-processing requires approximately ${estimatedCredits.toFixed(1)} credits. Please upgrade to continue.`,
          credits_remaining: deviceBalance.creditsRemaining,
          credits_used: deviceBalance.creditsUsed,
          total_allocated: deviceBalance.totalAllocated,
          credits_per_minute: CREDITS_PER_MINUTE,
        }), {
          status: 402, // Payment Required
          headers: { ...getCORSHeaders(), 'content-type': 'application/json' }
        });
      }

      // Check IP rate limit (anti-abuse)
      const rateLimitStatus = await checkRateLimit(
        env.RATE_LIMITER,
        clientIP,
        estimatedCredits,
        logger
      );

      if (!rateLimitStatus.allowed) {
        logger.log('warn', 'IP rate limit exceeded for trial user (post-process)', {
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

      logger.log('info', 'Trial user authorized for post-process', {
        deviceId,
        deviceCredits: deviceBalance.creditsRemaining,
        ipQuotaRemaining: rateLimitStatus.creditsRemaining
      });
    }

    // ========================================================================
    // STEP 6: Validate Groq API key
    // ========================================================================
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

    // ========================================================================
    // STEP 7: Call Groq for post-processing (with retry)
    // ========================================================================
    const correctionStartTime = Date.now();
    const userContent = buildTranscriptUserContent(text);
    const basePayload = buildCorrectionRequest(prompt, userContent);

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
          });
        }
      }
    );

    const correctedText = stripCleanMarkers(extractCorrectedText(correctionResponse.raw));
    const correctionLatencyMs = Date.now() - correctionStartTime;
    const costUsd = correctionResponse.costUsd;

    logger.log('info', 'Post-processing complete', {
      correctionLatencyMs,
      promptTokens: correctionResponse.usage?.prompt_tokens,
      completionTokens: correctionResponse.usage?.completion_tokens,
      costUsd,
      inputLength: text.length,
      outputLength: correctedText.length,
    });

    // ========================================================================
    // STEP 8: Calculate actual cost and deduct credits
    // ========================================================================
    const actualCredits = roundToTenth(calculateCreditsForCost(costUsd));

    // Update usage tracking
    if (isLicensed && licenseKey) {
      // LICENSED USER: Record usage via Next.js API
      ctx.waitUntil(
        recordUsage(
          env.HYPERWHISPER_API_URL,
          env.HYPERWHISPER_API_KEY,
          licenseKey,
          actualCredits,
          {
            post_processing_cost_usd: costUsd,
            total_cost_usd: costUsd,
            input_length: text.length,
            output_length: correctedText.length,
            endpoint: '/post-process',
          },
          logger
        )
      );

      logger.log('info', 'Usage event queued for recording (post-process)', {
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

      logger.log('info', 'Usage tracked for trial user (post-process)', {
        deviceId,
        ip: clientIP,
        credits: actualCredits
      });
    }

    // ========================================================================
    // STEP 9: Return response
    // ========================================================================
    const requestLatencyMs = logger.getElapsedTime();

    logger.log('info', 'Post-process request completed successfully', {
      requestLatencyMs,
      correctionLatencyMs,
      costUsd,
      creditsDebited: actualCredits,
      isLicensed,
    });

    const response: PostProcessResponse = {
      corrected: correctedText,
      cost: {
        usd: costUsd,
        credits: actualCredits,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        ...getCORSHeaders(),
        'content-type': 'application/json',
        'X-Request-ID': requestId,
        'X-Total-Cost-Usd': costUsd.toFixed(6),
        'X-Credits-Used': actualCredits.toFixed(1),
      }
    });

  } catch (error) {
    logger.log('error', 'Post-process request failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined
    });

    return new Response(JSON.stringify({
      error: 'Post-processing failed',
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
