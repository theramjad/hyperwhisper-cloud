// POST-PROCESS HANDLER
// Handler for POST /post-process endpoint - standalone text correction via Groq Llama
//
// FLOW:
// 1. Pipeline: IP check → Auth → Credit validation
// 2. Validate JSON body (text, prompt)
// 3. Call Groq for correction
// 4. Deduct credits (background)
// 5. Return response

import type { Env, PostProcessRequest, PostProcessResponse } from '../types';
import {
  createContext,
  checkIPBlocked,
  validateAuth,
  validateCredits,
  deductCredits,
  errorResponse,
  CORS_HEADERS,
  type AuthInput,
} from '../pipeline';
import { roundToTenth, retryWithBackoff } from '../utils/utils';
import { requestGroqChat, buildCorrectionRequest } from '../api/groq-client';
import {
  extractCorrectedText,
  buildTranscriptUserContent,
  stripCleanMarkers,
} from '../utils/text-processing';
import { calculateCreditsForCost } from '../billing/billing';

// Estimated credits for post-processing (~$0.001/request)
const ESTIMATED_POST_PROCESS_CREDITS = 1.0;
const MAX_TEXT_LENGTH = 100000; // ~25,000 words

/**
 * Handle POST /post-process - standalone text correction
 */
export async function handlePostProcess(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  _logger: unknown,
  clientIP: string
): Promise<Response> {
  const ctx = createContext(request, env, executionCtx, clientIP);

  try {
    // =========================================================================
    // PIPELINE: IP Check
    // =========================================================================

    const ipCheck = await checkIPBlocked(ctx);
    if (!ipCheck.ok) return ipCheck.response;

    // =========================================================================
    // PARSE JSON BODY
    // =========================================================================

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return errorResponse(400, 'Invalid Content-Type', 'Content-Type must be application/json');
    }

    const parseResult = await parseRequestBody(ctx, request);
    if (!parseResult.ok) return parseResult.response;
    const { text, prompt, licenseKey, deviceId } = parseResult.value;

    // =========================================================================
    // PIPELINE: Auth → Credits
    // =========================================================================

    const authInput: AuthInput = { licenseKey, deviceId };
    const auth = await validateAuth(ctx, authInput);
    if (!auth.ok) return auth.response;

    const credits = await validateCredits(ctx, auth.value, ESTIMATED_POST_PROCESS_CREDITS);
    if (!credits.ok) return credits.response;

    ctx.logger.log('info', 'Post-process starting - sending transcript to Groq for AI correction', {
      textLength: text.length,
      userType: auth.value.type,
      model: 'llama-3.3-70b-versatile',
    });

    // =========================================================================
    // CALL GROQ
    // =========================================================================

    const startTime = Date.now();
    const userContent = buildTranscriptUserContent(text);
    const payload = buildCorrectionRequest(prompt, userContent);

    const groqResponse = await retryWithBackoff(
      () => requestGroqChat(ctx.env, payload, ctx.logger, ctx.requestId),
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        onRetry: (attempt, error, delayMs) => {
          ctx.logger.log('warn', 'Groq API call failed - retrying with exponential backoff', {
            attempt,
            error: error.message,
            delayMs,
            nextRetryIn: `${delayMs}ms`,
          });
        },
      }
    );

    const correctedText = stripCleanMarkers(extractCorrectedText(groqResponse.raw));
    const latencyMs = Date.now() - startTime;
    const costUsd = groqResponse.costUsd;

    ctx.logger.log('info', 'Post-processing complete - Groq correction successful', {
      latencyMs,
      costUsd,
      inputLength: text.length,
      outputLength: correctedText.length,
      compressionRatio: (correctedText.length / text.length * 100).toFixed(1) + '%',
    });

    // =========================================================================
    // DEDUCT CREDITS (background)
    // =========================================================================

    const actualCredits = roundToTenth(calculateCreditsForCost(costUsd));

    ctx.ctx.waitUntil(
      deductCredits(ctx, auth.value, actualCredits, {
        post_processing_cost_usd: costUsd,
        input_length: text.length,
        output_length: correctedText.length,
        endpoint: '/post-process',
      })
    );

    // =========================================================================
    // RETURN RESPONSE
    // =========================================================================

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
        ...CORS_HEADERS,
        'content-type': 'application/json',
        'X-Request-ID': ctx.requestId,
        'X-Total-Cost-Usd': costUsd.toFixed(6),
        'X-Credits-Used': actualCredits.toFixed(1),
      },
    });

  } catch (error) {
    ctx.logger.log('error', 'Post-process failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return errorResponse(500, 'Post-processing failed',
      error instanceof Error ? error.message : 'Unknown error',
      { requestId: ctx.requestId }
    );
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

interface ParsedBody {
  text: string;
  prompt: string;
  licenseKey?: string;
  deviceId?: string;
}

/**
 * Parse and validate request body.
 */
async function parseRequestBody(
  ctx: import('../pipeline').RequestContext,
  request: Request
): Promise<import('../pipeline').PipelineResult<ParsedBody>> {

  let body: PostProcessRequest;

  try {
    body = await request.json() as PostProcessRequest;
  } catch {
    ctx.logger.log('warn', 'Invalid JSON body');
    return { ok: false, response: errorResponse(400, 'Invalid JSON', 'Request body must be valid JSON') };
  }

  // Validate text
  if (!body.text || typeof body.text !== 'string') {
    return { ok: false, response: errorResponse(400, 'Missing field', 'Request body must include "text" field') };
  }

  const text = body.text.trim();
  if (text.length === 0) {
    return { ok: false, response: errorResponse(400, 'Empty text', 'Text field cannot be empty') };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      response: errorResponse(400, 'Text too long',
        `Text must be ${MAX_TEXT_LENGTH} characters or less`,
        { max_length: MAX_TEXT_LENGTH, actual_length: text.length }
      ),
    };
  }

  // Validate prompt
  if (!body.prompt || typeof body.prompt !== 'string') {
    return { ok: false, response: errorResponse(400, 'Missing field', 'Request body must include "prompt" field') };
  }

  const prompt = body.prompt.trim();
  if (prompt.length === 0) {
    return { ok: false, response: errorResponse(400, 'Empty prompt', 'Prompt field cannot be empty') };
  }

  return {
    ok: true,
    value: {
      text,
      prompt,
      licenseKey: body.license_key,
      deviceId: body.device_id,
    },
  };
}
