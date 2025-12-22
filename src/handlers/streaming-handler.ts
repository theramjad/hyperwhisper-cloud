// STREAMING TRANSCRIPTION HANDLER
// Handler for POST /transcribe endpoint - zero-buffer streaming to Deepgram
//
// FLOW:
// 1. Pipeline: IP check → Auth → Credit validation
// 2. Validate streaming-specific headers (Content-Type, Content-Length)
// 3. Transcribe via Deepgram (streaming or R2 for large files)
// 4. Deduct credits (background)
// 5. Return response

import type { Env, StreamingTranscriptionResponse } from '../types';
import {
  createContext,
  checkIPBlocked,
  validateAuth,
  extractAuthFromQuery,
  validateCredits,
  deductCredits,
  estimateCreditsFromSize,
  jsonResponse,
  errorResponse,
  CORS_HEADERS,
  fileTooLargeResponse,
  missingContentLengthResponse,
  invalidContentTypeResponse,
} from '../pipeline';
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
import { calculateCreditsForCost } from '../billing/billing';
import { roundToTenth } from '../utils/utils';

// Large files (>30MB) use R2 upload path instead of direct streaming
// Cloudflare Workers chunked encoding causes issues with Deepgram for large files
const LARGE_FILE_THRESHOLD = 30 * 1024 * 1024; // 30MB
const MAX_AUDIO_SIZE = 2 * 1024 * 1024 * 1024; // 2GB (Deepgram limit)

/**
 * Handle POST /transcribe - streaming transcription
 */
export async function handleStreamingTranscription(
  request: Request,
  env: Env,
  executionCtx: ExecutionContext,
  _logger: unknown, // Deprecated: context creates its own logger
  clientIP: string
): Promise<Response> {
  const ctx = createContext(request, env, executionCtx, clientIP);

  try {
    // =========================================================================
    // PIPELINE: IP Check → Auth → Credits
    // =========================================================================

    const ipCheck = await checkIPBlocked(ctx);
    if (!ipCheck.ok) return ipCheck.response;

    // Validate streaming-specific headers BEFORE auth (fail fast)
    const headerValidation = validateStreamingHeaders(ctx);
    if (!headerValidation.ok) return headerValidation.response;
    const { contentType, contentLength } = headerValidation.value;

    const authInput = extractAuthFromQuery(ctx);
    const auth = await validateAuth(ctx, authInput);
    if (!auth.ok) return auth.response;

    const estimatedCredits = estimateCreditsFromSize(contentLength);
    const credits = await validateCredits(ctx, auth.value, estimatedCredits);
    if (!credits.ok) return credits.response;

    // Extract optional params
    const language = ctx.url.searchParams.get('language') || undefined;
    const mode = ctx.url.searchParams.get('mode') || undefined;
    const initialPrompt = ctx.url.searchParams.get('initial_prompt') || undefined;

    ctx.logger.log('info', 'Streaming transcription starting', {
      contentLength,
      language: language || 'auto',
      userType: auth.value.type,
    });

    // =========================================================================
    // TRANSCRIBE
    // =========================================================================

    const audioBody = request.body;
    if (!audioBody) {
      return errorResponse(400, 'Empty body', 'Request body is empty');
    }

    const transcriptionResult = await transcribeAudio(
      ctx, audioBody, contentType, contentLength, language, initialPrompt
    );

    // =========================================================================
    // HANDLE RESULT
    // =========================================================================

    // No speech detected - return early with zero cost
    if (transcriptionResult.source === 'no_speech') {
      ctx.logger.log('info', 'No speech detected');
      return buildResponse(ctx, transcriptionResult, 0);
    }

    // Calculate actual credits and deduct in background
    const actualCredits = roundToTenth(calculateCreditsForCost(transcriptionResult.costUsd));

    ctx.ctx.waitUntil(
      deductCredits(ctx, auth.value, actualCredits, {
        audio_duration_seconds: transcriptionResult.durationSeconds,
        transcription_cost_usd: transcriptionResult.costUsd,
        language: transcriptionResult.language ?? language ?? 'auto',
        mode,
        endpoint: '/transcribe',
        streaming: true,
      })
    );

    ctx.logger.log('info', 'Streaming transcription complete', {
      duration: transcriptionResult.durationSeconds,
      credits: actualCredits,
    });

    return buildResponse(ctx, transcriptionResult, actualCredits);

  } catch (error) {
    ctx.logger.log('error', 'Streaming transcription failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return errorResponse(500, 'Transcription failed',
      error instanceof Error ? error.message : 'Unknown error',
      { requestId: ctx.requestId }
    );
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

interface HeaderValidation {
  contentType: string;
  contentLength: number;
}

/**
 * Validate streaming-specific headers (Content-Type, Content-Length).
 */
function validateStreamingHeaders(ctx: import('../pipeline').RequestContext):
  import('../pipeline').PipelineResult<HeaderValidation> {

  const contentType = ctx.request.headers.get('content-type') || '';

  if (!contentType.startsWith('audio/')) {
    ctx.logger.log('warn', 'Invalid Content-Type', { contentType });
    return { ok: false, response: invalidContentTypeResponse('audio/*', contentType) };
  }

  const contentLengthHeader = ctx.request.headers.get('content-length');
  if (!contentLengthHeader) {
    ctx.logger.log('warn', 'Missing Content-Length');
    return { ok: false, response: missingContentLengthResponse() };
  }

  const contentLength = parseInt(contentLengthHeader, 10);
  if (isNaN(contentLength) || contentLength <= 0) {
    ctx.logger.log('warn', 'Invalid Content-Length', { contentLengthHeader });
    return { ok: false, response: errorResponse(400, 'Invalid Content-Length', 'Content-Length must be a positive integer') };
  }

  if (contentLength > MAX_AUDIO_SIZE) {
    ctx.logger.log('warn', 'File too large', { contentLength });
    return { ok: false, response: fileTooLargeResponse(contentLength, MAX_AUDIO_SIZE) };
  }

  return { ok: true, value: { contentType, contentLength } };
}

/**
 * Transcribe audio using appropriate path (direct stream or R2 for large files).
 */
async function transcribeAudio(
  ctx: import('../pipeline').RequestContext,
  audioBody: ReadableStream<Uint8Array>,
  contentType: string,
  contentLength: number,
  language?: string,
  initialPrompt?: string
): Promise<StreamingTranscriptionResult> {

  if (contentLength >= LARGE_FILE_THRESHOLD) {
    return transcribeViaR2(ctx, audioBody, contentType, language, initialPrompt);
  }

  return transcribeWithDeepgramStream(
    audioBody,
    contentType,
    contentLength,
    language,
    initialPrompt,
    ctx.env,
    ctx.logger
  );
}

/**
 * Large file path: Upload to R2, send URL to Deepgram.
 */
async function transcribeViaR2(
  ctx: import('../pipeline').RequestContext,
  audioBody: ReadableStream<Uint8Array>,
  contentType: string,
  language?: string,
  initialPrompt?: string
): Promise<StreamingTranscriptionResult> {

  ctx.logger.log('info', 'Using R2 upload path for large file');

  const r2Key = generateR2Key(contentType);

  try {
    // Upload to R2
    await uploadToR2(ctx.env.AUDIO_BUCKET, r2Key, audioBody, contentType);
    ctx.logger.log('info', 'Audio uploaded to R2', { r2Key });

    // Generate presigned URL
    const bucketName = ctx.env.ENVIRONMENT === 'production'
      ? 'hyperwhisper-audio-temp-prod'
      : 'hyperwhisper-audio-temp-dev';

    const presignedUrl = await generateR2PresignedUrl(
      ctx.env.R2_ACCOUNT_ID,
      ctx.env.R2_ACCESS_KEY_ID,
      ctx.env.R2_SECRET_ACCESS_KEY,
      bucketName,
      r2Key,
      15 * 60 // 15 min expiry
    );

    // Transcribe via URL
    const result = await transcribeWithDeepgramUrl(
      presignedUrl,
      language,
      initialPrompt,
      ctx.env,
      ctx.logger
    );

    // Cleanup R2 (non-blocking)
    ctx.ctx.waitUntil(
      deleteFromR2(ctx.env.AUDIO_BUCKET, r2Key).catch(err => {
        ctx.logger.log('warn', 'Failed to delete R2 file', { r2Key, error: String(err) });
      })
    );

    return result;

  } catch (error) {
    // Cleanup on error
    ctx.ctx.waitUntil(deleteFromR2(ctx.env.AUDIO_BUCKET, r2Key).catch(() => {}));
    throw error;
  }
}

/**
 * Build the response object.
 */
function buildResponse(
  ctx: import('../pipeline').RequestContext,
  result: StreamingTranscriptionResult,
  credits: number
): Response {

  const response: StreamingTranscriptionResponse = {
    text: result.text,
    language: result.language,
    duration: result.durationSeconds,
    cost: {
      usd: result.costUsd,
      credits,
    },
    metadata: {
      request_id: ctx.requestId,
      stt_provider: 'deepgram-nova3',
    },
    no_speech_detected: result.source === 'no_speech' ? true : undefined,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json',
      'X-Request-ID': ctx.requestId,
      'X-STT-Provider': 'deepgram-nova3',
      'X-Total-Cost-Usd': formatUsd(result.costUsd),
      'X-Credits-Used': credits.toFixed(1),
    },
  });
}
