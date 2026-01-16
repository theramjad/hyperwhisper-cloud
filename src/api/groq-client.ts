// GROQ API CLIENT MODULE
// Handles API interactions with Groq for:
// - Whisper transcription (STT): whisper-large-v3
// - Chat completion (Llama post-processing): llama-3.3-70b-versatile

import type { Env, GroqUsage, WhisperResponse, WhisperSegment } from '../types';
import { Logger } from '../utils/logger';
import { safeReadText, isRecord } from '../utils/utils';
import { computeGroqChatCost, computeGroqTranscriptionCost, isGroqUsage, deriveDurationSeconds } from '../billing/cost-calculator';
import { extractTranscriptionText } from '../utils/text-processing';

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_CHAT_MODEL = 'llama-3.3-70b-versatile';
const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3';

// =============================================================================
// TRANSCRIPTION TYPES
// =============================================================================

// Unified result type matching other STT providers
export type StreamingTranscriptionResult = {
  text: string;
  language?: string;
  durationSeconds: number;
  costUsd: number;
  requestId?: string;
  source: string;
};

// MIME type mappings for FormData uploads
const MIME_OVERRIDES: Record<string, string> = {
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/mpga': 'audio/mpeg',
  'audio/flac': 'audio/flac',
  'audio/x-flac': 'audio/flac',
  'audio/ogg': 'audio/ogg',
  'audio/opus': 'audio/opus',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/webm': 'audio/webm',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/webm': '.webm',
};

const DEFAULT_AUDIO_MIME = 'audio/mp4';
const DEFAULT_AUDIO_EXTENSION = EXTENSION_BY_MIME[DEFAULT_AUDIO_MIME];

// =============================================================================
// CHAT TYPES
// =============================================================================

// Chat message types
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export type CorrectionRequestPayload = {
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
};

/**
 * Call Groq's chat completions API for post-processing and return cost + raw payload
 */
export async function requestGroqChat(
  env: Env,
  payload: CorrectionRequestPayload,
  logger: Logger,
  requestId: string
): Promise<{ raw: unknown; usage?: GroqUsage; costUsd: number }> {
  const baseUrl = getGroqBaseUrl(env);
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = GROQ_CHAT_MODEL;

  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      ...payload,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    logger.log('error', 'Groq API returned error - post-processing failed', {
      requestId,
      status: response.status,
      statusText: response.statusText,
      endpoint: chatUrl,
      errorText,
      model: model,
      action: 'Will retry with exponential backoff if attempts remain',
    });
    throw new Error(`Groq chat failed with status ${response.status}`);
  }

  const json = await response.json();
  const usage = isRecord(json) && isGroqUsage(json['usage']) ? json['usage'] : undefined;
  const costUsd = usage ? computeGroqChatCost(usage) : 0;

  return {
    raw: json,
    usage,
    costUsd,
  };
}

/**
 * Assemble the chat-completions payload used for post-processing
 */
export function buildCorrectionRequest(systemPrompt: string, userContent: string): CorrectionRequestPayload {
  return {
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userContent,
      }
    ],
    temperature: 0,
    max_tokens: 32768,
  };
}

/**
 * Resolve the Groq base URL, defaulting to the public API endpoint
 */
function getGroqBaseUrl(env: Env): string {
  const candidate = env.GROQ_BASE_URL?.trim();
  if (candidate && candidate.length > 0) {
    return candidate.replace(/\/+$/, '');
  }

  return DEFAULT_GROQ_BASE_URL;
}

// =============================================================================
// TRANSCRIPTION FUNCTIONS
// =============================================================================

/**
 * Transcribe audio from a stream/buffer using Groq Whisper API.
 * Matches signature of other STT providers for interchangeability.
 *
 * @param audioBody - Audio data as stream or buffer
 * @param contentType - MIME type of the audio
 * @param contentLength - Size in bytes (for logging)
 * @param language - ISO-639-1 code or undefined for auto-detect
 * @param initialPrompt - Comma-separated vocabulary terms
 * @param env - Worker environment
 * @param logger - Logger instance
 */
export async function transcribeWithGroqFromStream(
  audioBody: ReadableStream<Uint8Array> | ArrayBuffer,
  contentType: string,
  contentLength: number,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<StreamingTranscriptionResult> {
  // Buffer the stream to create FormData
  let audioBuffer: ArrayBuffer;
  if (audioBody instanceof ArrayBuffer) {
    audioBuffer = audioBody;
  } else {
    const chunks: Uint8Array[] = [];
    const reader = audioBody.getReader();
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
    audioBuffer = combined.buffer;
  }

  return transcribeWithGroq(
    new Uint8Array(audioBuffer),
    contentType,
    undefined,
    language,
    initialPrompt,
    env,
    logger
  );
}

/**
 * Transcribe audio from a URL using Groq Whisper API.
 * Fetches the audio first, then sends to Groq (Groq doesn't support URL input).
 *
 * @param audioUrl - Presigned URL to fetch audio from
 * @param language - ISO-639-1 code or undefined for auto-detect
 * @param initialPrompt - Comma-separated vocabulary terms
 * @param env - Worker environment
 * @param logger - Logger instance
 */
export async function transcribeWithGroqFromUrl(
  audioUrl: string,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<StreamingTranscriptionResult> {
  logger.log('info', 'Fetching audio from URL for Groq transcription', {
    urlPrefix: audioUrl.substring(0, 50) + '...',
  });

  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio from URL: ${response.status}`);
  }

  const audioBuffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || 'audio/mp4';

  return transcribeWithGroq(
    new Uint8Array(audioBuffer),
    contentType,
    undefined,
    language,
    initialPrompt,
    env,
    logger
  );
}

/**
 * Core transcription function using Groq Whisper API.
 *
 * @param audioBytes - Raw audio data
 * @param audioMimeType - MIME type of the audio
 * @param audioFileName - Original filename (optional)
 * @param language - ISO-639-1 code or undefined for auto-detect
 * @param initialPrompt - Comma-separated vocabulary terms
 * @param env - Worker environment
 * @param logger - Logger instance
 */
async function transcribeWithGroq(
  audioBytes: Uint8Array,
  audioMimeType: string | undefined,
  audioFileName: string | undefined,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<StreamingTranscriptionResult> {
  const baseUrl = getGroqBaseUrl(env);
  const transcriptionUrl = `${baseUrl}/audio/transcriptions`;
  const model = GROQ_TRANSCRIPTION_MODEL;

  const { mimeType, extension } = normalizeMimeType(audioMimeType, audioFileName);
  const fileName = resolveFileName(audioFileName, extension);

  // Create FormData with audio file
  const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
  new Uint8Array(audioBuffer).set(audioBytes);

  const blob = new Blob([audioBuffer], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');

  // Only send language if explicitly specified (not "auto")
  // When omitted, Groq's Whisper performs automatic language detection
  if (language && language.toLowerCase() !== 'auto') {
    formData.append('language', language);
  }

  // Send vocabulary as prompt (Whisper uses this for context/biasing)
  if (initialPrompt) {
    formData.append('prompt', initialPrompt);
  }

  logger.log('info', 'Dispatching Groq Whisper transcription', {
    endpoint: transcriptionUrl,
    model,
    fileName,
    fileSize: audioBytes.byteLength,
    fileMimeType: mimeType,
    language: language || 'auto',
    hasInitialPrompt: !!initialPrompt,
    initialPromptLength: initialPrompt?.length || 0,
  });

  const groqResponse = await fetch(transcriptionUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: formData,
  });

  if (!groqResponse.ok) {
    const errorText = await safeReadText(groqResponse);
    logger.log('error', 'Groq Whisper transcription failed', {
      status: groqResponse.status,
      statusText: groqResponse.statusText,
      endpoint: transcriptionUrl,
      model,
      errorText,
    });

    if (groqResponse.status === 401) {
      throw new Error('Groq API key is invalid or expired');
    }
    if (groqResponse.status === 429) {
      throw new Error('Groq rate limit exceeded');
    }

    throw new Error(`Groq transcription failed with status ${groqResponse.status}`);
  }

  const responseJson = (await groqResponse.json()) as WhisperResponse;
  const extraction = extractTranscriptionText(responseJson);

  // NO SPEECH DETECTED:
  // When Groq returns a valid response but with empty text, this means
  // no speech was detected in the audio (silence, background noise, etc.)
  if (!extraction) {
    logger.log('info', 'No speech detected in audio', {
      responseKeys: isRecord(responseJson) ? Object.keys(responseJson) : 'non-object',
    });

    return {
      text: '',
      source: 'no_speech',
      durationSeconds: 0,
      language: responseJson.language,
      costUsd: 0,
    };
  }

  // Calculate duration and cost
  const detectedDuration = deriveDurationSeconds(responseJson.segments, responseJson.duration);
  const durationSeconds = detectedDuration ?? 0;
  const costUsd = computeGroqTranscriptionCost(durationSeconds);

  return {
    text: extraction.text,
    source: extraction.source,
    durationSeconds,
    language: responseJson.language,
    costUsd,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Normalize MIME type for Groq Whisper API compatibility.
 */
function normalizeMimeType(
  inputMimeType: string | undefined,
  fallbackFileName: string | undefined
): { mimeType: string; extension: string } {
  const candidate = inputMimeType?.toLowerCase().trim();
  if (candidate) {
    const mapped = MIME_OVERRIDES[candidate] || (candidate in EXTENSION_BY_MIME ? candidate : undefined);
    if (mapped) {
      return {
        mimeType: mapped,
        extension: EXTENSION_BY_MIME[mapped] ?? DEFAULT_AUDIO_EXTENSION,
      };
    }
  }

  if (fallbackFileName) {
    const lowered = fallbackFileName.toLowerCase();
    for (const [mime, extension] of Object.entries(EXTENSION_BY_MIME)) {
      if (lowered.endsWith(extension)) {
        return { mimeType: mime, extension };
      }
    }
  }

  return { mimeType: DEFAULT_AUDIO_MIME, extension: DEFAULT_AUDIO_EXTENSION };
}

/**
 * Resolve filename with correct extension for FormData upload.
 */
function resolveFileName(originalName: string | undefined, requiredExtension: string): string {
  const fallback = `audio-${Date.now()}${requiredExtension}`;
  if (!originalName) {
    return fallback;
  }

  const sanitized = originalName.replace(/[\r\n]/g, '').trim();
  if (sanitized.length === 0) {
    return fallback;
  }

  const lowered = sanitized.toLowerCase();
  if (requiredExtension && !lowered.endsWith(requiredExtension)) {
    const dotIndex = sanitized.lastIndexOf('.');
    if (dotIndex === -1) {
      return `${sanitized}${requiredExtension}`;
    }
    return `${sanitized.slice(0, dotIndex)}${requiredExtension}`;
  }

  return sanitized;
}
