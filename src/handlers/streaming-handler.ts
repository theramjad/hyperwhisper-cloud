// STREAMING TRANSCRIPTION HANDLER
// Handler for POST /transcribe endpoint - Multi-provider STT transcription
//
// PROVIDERS:
// - Deepgram Nova-3 (default): Fast and cost-effective, $0.0055/min
// - ElevenLabs Scribe v2: Higher accuracy, $0.00983/min
// - Groq Whisper large-v3: Cheapest option, $0.00185/min
//
// PROVIDER SELECTION:
// Client sends X-STT-Provider header to choose provider:
// - "deepgram" (default if omitted)
// - "elevenlabs"
// - "groq"
//
// FLOW:
// 1. Pipeline: IP check → Auth → Credit validation
// 2. Validate streaming-specific headers (Content-Type, Content-Length)
// 3. Extract provider from X-STT-Provider header
// 4. Transcribe via selected provider (buffer or R2 for large files)
// 5. Deduct credits (background)
// 6. Return response with X-STT-Provider header

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
  transcribeWithElevenLabsFromStream,
  transcribeWithElevenLabsFromUrl,
  StreamingTranscriptionResult as ElevenLabsResult,
} from '../api/elevenlabs-client';
import {
  transcribeWithDeepgramStream,
  transcribeWithDeepgramUrl,
  StreamingTranscriptionResult as DeepgramResult,
} from '../api/deepgram-client';
import {
  transcribeWithGroqFromStream,
  transcribeWithGroqFromUrl,
  StreamingTranscriptionResult as GroqResult,
  GroqEdgeBlockedError,
} from '../api/groq-client';
import {
  uploadToR2,
  generateR2PresignedUrl,
  deleteFromR2,
  generateR2Key,
} from '../utils/r2-utils';
import { formatUsd } from '../billing/cost-calculator';
import { calculateCreditsForCost } from '../billing/billing';
import { roundToTenth } from '../utils/utils';

// =============================================================================
// PROVIDER CONFIGURATION
// =============================================================================

// Supported STT providers
type STTProvider = 'elevenlabs' | 'deepgram' | 'groq';
const DEFAULT_PROVIDER: STTProvider = 'deepgram';

// Provider display names for response headers
const PROVIDER_NAMES: Record<STTProvider, string> = {
  elevenlabs: 'elevenlabs-scribe-v2',
  deepgram: 'deepgram-nova3',
  groq: 'groq-whisper-large-v3',
};

// R2 thresholds per provider (memory constraints differ)
// ElevenLabs and Groq require FormData (buffering), so need more memory headroom
// Deepgram accepts raw binary stream, so can handle larger files in-memory
const R2_THRESHOLD: Record<STTProvider, number> = {
  elevenlabs: 15 * 1024 * 1024,  // 15MB (FormData buffering overhead)
  deepgram: 30 * 1024 * 1024,    // 30MB (raw binary, less overhead)
  groq: 15 * 1024 * 1024,        // 15MB (FormData buffering like ElevenLabs)
};

// Maximum audio size (applies to all providers)
const MAX_AUDIO_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

// Unified result type (all providers use compatible interface)
type TranscriptionResult = ElevenLabsResult | DeepgramResult | GroqResult;

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

    // Extract provider from header (default: elevenlabs)
    const provider = extractProvider(ctx);

    // Extract optional params
    const language = ctx.url.searchParams.get('language') || undefined;
    const mode = ctx.url.searchParams.get('mode') || undefined;
    const initialPrompt = ctx.url.searchParams.get('initial_prompt') || undefined;

    ctx.logger.log('info', `Streaming transcription pipeline starting - sending audio to ${PROVIDER_NAMES[provider]}`, {
      contentLength,
      language: language || 'auto',
      userType: auth.value.type,
      provider,
      estimatedMinutes: Math.round(contentLength / (1024 * 1024)),
    });

    // =========================================================================
    // TRANSCRIBE
    // =========================================================================

    const audioBody = request.body;
    if (!audioBody) {
      return errorResponse(400, 'Empty body', 'Request body is empty');
    }

    const transcriptionResult = await transcribeAudio(
      ctx, audioBody, contentType, contentLength, provider, language, initialPrompt
    );

    // =========================================================================
    // HANDLE RESULT
    // =========================================================================

    // No speech detected - return early with zero cost
    if (transcriptionResult.source === 'no_speech') {
      ctx.logger.log('info', `${PROVIDER_NAMES[provider]} detected silence - no transcribable speech in audio`, {
        duration: transcriptionResult.durationSeconds,
        action: 'Returning empty transcript with zero cost',
      });
      return buildResponse(ctx, transcriptionResult, 0, provider);
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
        stt_provider: PROVIDER_NAMES[provider],
      })
    );

    ctx.logger.log('info', 'Streaming transcription complete - returning transcript to client', {
      duration: transcriptionResult.durationSeconds,
      credits: actualCredits,
      textLength: transcriptionResult.text.length,
      costUsd: transcriptionResult.costUsd,
      provider,
    });

    return buildResponse(ctx, transcriptionResult, actualCredits, provider);

  } catch (error) {
    ctx.logger.log('error', 'Streaming transcription pipeline failed - internal server error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
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
 * Extract STT provider from X-STT-Provider header.
 * Returns default provider if header is missing or invalid.
 */
function extractProvider(ctx: import('../pipeline').RequestContext): STTProvider {
  const header = ctx.request.headers.get('x-stt-provider')?.toLowerCase().trim();

  if (header === 'deepgram') {
    return 'deepgram';
  }
  if (header === 'elevenlabs') {
    return 'elevenlabs';
  }
  if (header === 'groq') {
    return 'groq';
  }

  // Default or invalid value
  if (header && header !== 'elevenlabs' && header !== 'deepgram' && header !== 'groq') {
    ctx.logger.log('warn', 'Invalid X-STT-Provider header, using default', {
      provided: header,
      default: DEFAULT_PROVIDER,
    });
  }

  return DEFAULT_PROVIDER;
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
 * Transcribe audio using appropriate path (buffered or R2 for large files).
 * Routes to the correct provider based on the provider parameter.
 */
async function transcribeAudio(
  ctx: import('../pipeline').RequestContext,
  audioBody: ReadableStream<Uint8Array>,
  contentType: string,
  contentLength: number,
  provider: STTProvider,
  language?: string,
  initialPrompt?: string
): Promise<TranscriptionResult> {

  // Use provider-specific R2 threshold
  const threshold = R2_THRESHOLD[provider];

  if (contentLength >= threshold) {
    return transcribeViaR2(ctx, audioBody, contentType, provider, language, initialPrompt);
  }

  // Direct stream/buffer path - route to provider
  if (provider === 'deepgram') {
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

  if (provider === 'groq') {
    // Buffer the stream upfront so we can retry with fallback provider
    const audioBuffer = await streamToArrayBuffer(audioBody);

    try {
      return await transcribeWithGroqFromStream(
        audioBuffer,
        contentType,
        contentLength,
        language,
        initialPrompt,
        ctx.env,
        ctx.logger
      );
    } catch (error) {
      if (error instanceof GroqEdgeBlockedError) {
        ctx.logger.log('warn', 'Groq 403 - falling back to Deepgram', {
          originalError: error.message,
          action: 'Retrying with Deepgram Nova-3',
        });
        const result = await transcribeWithDeepgramStream(
          audioBuffer,
          contentType,
          contentLength,
          language,
          initialPrompt,
          ctx.env,
          ctx.logger
        );
        // Mark as fallback for response headers
        (result as TranscriptionResult & { fallbackFrom?: string }).fallbackFrom = 'groq';
        return result;
      }
      throw error;
    }
  }

  // Default: ElevenLabs
  return transcribeWithElevenLabsFromStream(
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
 * Large file path: Upload to R2, send URL to provider.
 */
async function transcribeViaR2(
  ctx: import('../pipeline').RequestContext,
  audioBody: ReadableStream<Uint8Array>,
  contentType: string,
  provider: STTProvider,
  language?: string,
  initialPrompt?: string
): Promise<TranscriptionResult> {

  ctx.logger.log('info', `Using R2 upload path for large file (provider: ${provider})`);

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

    // Transcribe via URL using selected provider
    let result: TranscriptionResult;

    if (provider === 'deepgram') {
      result = await transcribeWithDeepgramUrl(
        presignedUrl,
        language,
        initialPrompt,
        ctx.env,
        ctx.logger
      );
    } else if (provider === 'groq') {
      try {
        result = await transcribeWithGroqFromUrl(
          presignedUrl,
          language,
          initialPrompt,
          ctx.env,
          ctx.logger
        );
      } catch (error) {
        if (error instanceof GroqEdgeBlockedError) {
          ctx.logger.log('warn', 'Groq 403 - falling back to Deepgram', {
            originalError: error.message,
            action: 'Retrying with Deepgram Nova-3',
          });
          result = await transcribeWithDeepgramUrl(
            presignedUrl,
            language,
            initialPrompt,
            ctx.env,
            ctx.logger
          );
          // Mark as fallback for response headers
          (result as TranscriptionResult & { fallbackFrom?: string }).fallbackFrom = 'groq';
        } else {
          throw error;
        }
      }
    } else {
      result = await transcribeWithElevenLabsFromUrl(
        presignedUrl,
        language,
        initialPrompt,
        ctx.env,
        ctx.logger
      );
    }

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
  result: TranscriptionResult,
  credits: number,
  provider: STTProvider
): Response {

  // Check if this was a fallback from another provider
  const fallbackFrom = (result as TranscriptionResult & { fallbackFrom?: string }).fallbackFrom;
  const actualProvider: STTProvider = fallbackFrom ? 'deepgram' : provider;
  const providerName = fallbackFrom
    ? `${PROVIDER_NAMES[actualProvider]} (fallback from ${fallbackFrom})`
    : PROVIDER_NAMES[provider];

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
      stt_provider: providerName,
    },
    no_speech_detected: result.source === 'no_speech' ? true : undefined,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json',
      'X-Request-ID': ctx.requestId,
      'X-STT-Provider': providerName,
      'X-Total-Cost-Usd': formatUsd(result.costUsd),
      'X-Credits-Used': credits.toFixed(1),
    },
  });
}

/**
 * Convert a ReadableStream to ArrayBuffer for reuse across fallback attempts.
 */
async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined.buffer;
}
