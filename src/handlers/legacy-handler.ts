// LEGACY MULTIPART TRANSCRIPTION HANDLER
// Handler for POST / endpoint - buffered multipart form data transcription
//
// BACKWARDS COMPATIBILITY: Kept for older clients (< v2.12.0)
// New clients should use POST /transcribe + POST /post-process
//
// FLOW:
// 1. Pipeline: IP check → Auth → Credit validation
// 2. Parse multipart form data, extract audio
// 3. Transcribe with Deepgram Nova-3
// 4. Optional: Post-process with Groq Llama 3.3 70B
// 5. Deduct credits (background)
// 6. Return response

import type { Env, TranscriptionRequest } from '../types';
import {
  createContext,
  checkIPBlocked,
  validateAuth,
  validateCredits,
  deductCredits,
  estimateCreditsFromSize,
  errorResponse,
  CORS_HEADERS,
  fileTooLargeResponse,
  type AuthInput,
} from '../pipeline';
import { parseBoolean, roundToTenth, retryWithBackoff } from '../utils/utils';
import {
  extractCorrectedText,
  buildTranscriptUserContent,
  stripCleanMarkers,
} from '../utils/text-processing';
import { transcribeWithDeepgram } from '../api/deepgram-client';
import { requestGroqChat, buildCorrectionRequest } from '../api/groq-client';
import { formatUsd } from '../billing/cost-calculator';
import { calculateCreditsForCost } from '../billing/billing';

const MAX_AUDIO_SIZE = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * Handle legacy POST / multipart transcription
 */
export async function handleLegacyTranscription(
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
    // PARSE MULTIPART FORM DATA
    // =========================================================================

    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return errorResponse(400, 'Invalid Content-Type', 'Content-Type must be multipart/form-data');
    }

    const formData = await request.formData();
    const parseResult = await parseFormDataAsync(ctx, formData);
    if (!parseResult.ok) return parseResult.response;
    const { requestData, audioSize } = parseResult.value;

    // =========================================================================
    // PIPELINE: Auth → Credits
    // =========================================================================

    const authInput: AuthInput = {
      licenseKey: requestData.license_key,
      deviceId: requestData.device_id,
    };

    const auth = await validateAuth(ctx, authInput);
    if (!auth.ok) return auth.response;

    const estimatedCredits = estimateCreditsFromSize(audioSize);
    const credits = await validateCredits(ctx, auth.value, estimatedCredits);
    if (!credits.ok) return credits.response;

    ctx.logger.log('info', 'Legacy transcription starting', {
      audioSize,
      language: requestData.language || 'auto',
      userType: auth.value.type,
      postProcessing: requestData.post_processing_enabled,
    });

    // =========================================================================
    // TRANSCRIBE
    // =========================================================================

    const sttStartTime = Date.now();
    const estimatedSeconds = Math.max(10, Math.ceil(audioSize / (1024 * 1024) * 60));

    const transcriptionResult = await retryWithBackoff(
      () => transcribeWithDeepgram(requestData, ctx.env, ctx.logger, estimatedSeconds),
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        onRetry: (attempt, error, delayMs) => {
          ctx.logger.log('warn', 'Deepgram retry', { attempt, error: error.message, delayMs });
        },
      }
    );

    const sttLatencyMs = Date.now() - sttStartTime;

    ctx.logger.log('info', 'Transcription complete', {
      sttLatencyMs,
      duration: transcriptionResult.durationSeconds,
      textLength: transcriptionResult.text.length,
    });

    // No speech detected - return early
    if (transcriptionResult.source === 'no_speech') {
      ctx.logger.log('info', 'No speech detected');
      return buildLegacyResponse(ctx, '', '', transcriptionResult, 0, 0, 0, false);
    }

    // =========================================================================
    // POST-PROCESS (optional)
    // =========================================================================

    const baseTranscription = transcriptionResult.text;
    let correctedText = baseTranscription;
    let cleanupCostUsd = 0;
    let cleanupLatencyMs = 0;
    let postProcessingApplied = false;

    const systemPrompt = requestData.post_processing_prompt?.trim();
    const shouldPostProcess = requestData.post_processing_enabled !== false && !!systemPrompt;

    if (shouldPostProcess) {
      const postProcessResult = await postProcess(
        ctx, baseTranscription, systemPrompt!
      );
      correctedText = postProcessResult.text;
      cleanupCostUsd = postProcessResult.costUsd;
      cleanupLatencyMs = postProcessResult.latencyMs;
      postProcessingApplied = postProcessResult.success;
    }

    // =========================================================================
    // DEDUCT CREDITS (background)
    // =========================================================================

    const totalCostUsd = transcriptionResult.costUsd + cleanupCostUsd;
    const actualCredits = roundToTenth(calculateCreditsForCost(totalCostUsd));

    ctx.ctx.waitUntil(
      deductCredits(ctx, auth.value, actualCredits, {
        audio_duration_seconds: transcriptionResult.durationSeconds,
        transcription_cost_usd: transcriptionResult.costUsd,
        post_processing_cost_usd: cleanupCostUsd,
        total_cost_usd: totalCostUsd,
        language: transcriptionResult.language ?? requestData.language ?? 'auto',
        mode: requestData.mode,
        post_processing_applied: postProcessingApplied,
        endpoint: '/',
      })
    );

    ctx.logger.log('info', 'Legacy transcription complete', {
      totalCostUsd,
      credits: actualCredits,
      postProcessing: postProcessingApplied,
    });

    return buildLegacyResponse(
      ctx,
      baseTranscription,
      correctedText,
      transcriptionResult,
      transcriptionResult.costUsd,
      cleanupCostUsd,
      actualCredits,
      auth.value.type === 'licensed'
    );

  } catch (error) {
    ctx.logger.log('error', 'Legacy transcription failed', {
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

interface ParseResult {
  requestData: TranscriptionRequest;
  audioSize: number;
}

/**
 * Parse multipart form data and extract audio.
 */
async function parseFormDataAsync(
  ctx: import('../pipeline').RequestContext,
  formData: FormData
): Promise<import('../pipeline').PipelineResult<ParseResult>> {

  const audioFile = formData.get('audio');
  if (!audioFile || !(audioFile instanceof File)) {
    ctx.logger.log('warn', 'Missing audio file');
    return { ok: false, response: errorResponse(400, 'Missing audio', 'Audio file required') };
  }

  const audioArrayBuffer = await audioFile.arrayBuffer();
  const audioBytes = new Uint8Array(audioArrayBuffer);
  const audioSize = audioBytes.byteLength;

  if (audioSize > MAX_AUDIO_SIZE) {
    ctx.logger.log('warn', 'File too large', { audioSize });
    return { ok: false, response: fileTooLargeResponse(audioSize, MAX_AUDIO_SIZE) };
  }

  // Infer MIME type
  let audioMimeType = audioFile.type?.trim() || undefined;
  const audioFileName = audioFile.name?.trim() || undefined;

  if (!audioMimeType && audioFileName) {
    audioMimeType = inferMimeType(audioFileName);
  }

  const requestData: TranscriptionRequest = {
    audio: audioBytes,
    audioMimeType,
    audioFileName,
    device_id: (formData.get('device_id') as string) || undefined,
    license_key: (formData.get('license_key') as string) || undefined,
    language: (formData.get('language') as string) || undefined,
    mode: (formData.get('mode') as string) || undefined,
    initial_prompt: normalizeString(formData.get('initial_prompt')),
    post_processing_enabled: parseBoolean(formData.get('post_processing_enabled')),
    post_processing_prompt: normalizeString(formData.get('post_processing_prompt')),
  };

  return { ok: true, value: { requestData, audioSize } };
}

/**
 * Infer MIME type from filename.
 */
function inferMimeType(filename: string): string | undefined {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3') || lower.endsWith('.mpeg') || lower.endsWith('.mpga')) return 'audio/mpeg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.opus')) return 'audio/opus';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4';
  return undefined;
}

/**
 * Normalize string fields (trim, empty → undefined).
 */
function normalizeString(value: FormDataEntryValue | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface PostProcessResult {
  text: string;
  costUsd: number;
  latencyMs: number;
  success: boolean;
}

/**
 * Post-process transcription with Groq.
 */
async function postProcess(
  ctx: import('../pipeline').RequestContext,
  text: string,
  systemPrompt: string
): Promise<PostProcessResult> {
  const startTime = Date.now();

  try {
    const userContent = buildTranscriptUserContent(text);
    const payload = buildCorrectionRequest(systemPrompt, userContent);

    const response = await retryWithBackoff(
      () => requestGroqChat(ctx.env, payload, ctx.logger, ctx.requestId),
      {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        onRetry: (attempt, error, delayMs) => {
          ctx.logger.log('warn', 'Groq retry', { attempt, error: error.message, delayMs });
        },
      }
    );

    const correctedText = stripCleanMarkers(extractCorrectedText(response.raw));
    const latencyMs = Date.now() - startTime;

    ctx.logger.log('info', 'Post-processing complete', {
      latencyMs,
      costUsd: response.costUsd,
    });

    return {
      text: correctedText,
      costUsd: response.costUsd,
      latencyMs,
      success: true,
    };

  } catch (error) {
    const latencyMs = Date.now() - startTime;
    ctx.logger.log('error', 'Post-processing failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      latencyMs,
    });

    return {
      text, // Return original on failure
      costUsd: 0,
      latencyMs,
      success: false,
    };
  }
}

/**
 * Build legacy response format.
 */
function buildLegacyResponse(
  ctx: import('../pipeline').RequestContext,
  original: string,
  corrected: string,
  transcriptionResult: { language?: string; durationSeconds: number; segments?: unknown[] },
  transcriptionCostUsd: number,
  postProcessingCostUsd: number,
  credits: number,
  isLicensed: boolean
): Response {
  const totalCostUsd = transcriptionCostUsd + postProcessingCostUsd;
  const noSpeech = original === '' && corrected === '';

  const body = noSpeech
    ? {
        original: '',
        corrected: '',
        no_speech_detected: true,
        requestId: ctx.requestId,
      }
    : {
        original,
        corrected,
        metadata: {
          language: transcriptionResult.language,
          duration: transcriptionResult.durationSeconds,
          segments: transcriptionResult.segments,
          requestId: ctx.requestId,
          is_licensed: isLicensed,
          stt_provider: 'deepgram-nova3',
        },
        costs: {
          transcription_usd: transcriptionCostUsd,
          post_processing_usd: postProcessingCostUsd,
          total_usd: totalCostUsd,
          credits,
        },
      };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'content-type': 'application/json',
      'X-Request-ID': ctx.requestId,
      'X-STT-Provider': 'deepgram-nova3',
      'X-Transcription-Cost-Usd': formatUsd(transcriptionCostUsd),
      'X-Post-Processing-Cost-Usd': formatUsd(postProcessingCostUsd),
      'X-Total-Cost-Usd': formatUsd(totalCostUsd),
      'X-Credits-Used': credits.toFixed(1),
    },
  });
}
