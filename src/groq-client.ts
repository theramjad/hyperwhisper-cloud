// GROQ API CLIENT MODULE
// Handles API interactions with Groq for transcription and chat completion

import type {
  Env,
  TranscriptionRequest,
  WhisperResponse,
  WhisperSegment,
  GroqUsage,
} from './types';
import { Logger } from './logger';
import { base64ToUint8Array, safeReadText, isRecord } from './utils';
import { extractTranscriptionText } from './text-processing';
import { computeTranscriptionCost, deriveDurationSeconds, computeChatCost, isGroqUsage } from './cost-calculator';

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_TRANSCRIPTION_MODEL = 'whisper-large-v3';
const GROQ_CHAT_MODEL = 'llama-3.3-70b-versatile';

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

// Transcription result type
export type TranscriptionResult = {
  text: string;
  source: string;
  response: WhisperResponse;
  durationSeconds: number;
  language?: string;
  segments?: WhisperSegment[];
  costUsd: number;
};

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
 * Send the audio payload to Groq's transcription endpoint and normalize the response
 */
export async function transcribeWithGroq(
  requestData: TranscriptionRequest,
  env: Env,
  logger: Logger,
  estimatedSeconds: number
): Promise<TranscriptionResult> {
  const baseUrl = getGroqBaseUrl(env);
  const transcriptionUrl = `${baseUrl}/audio/transcriptions`;
  const model = GROQ_TRANSCRIPTION_MODEL;

  const { mimeType, extension } = normalizeMimeType(requestData.audioMimeType, requestData.audioFileName);
  const fileName = resolveFileName(requestData.audioFileName, extension);

  const audioBytes = base64ToUint8Array(requestData.audio);
  const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
  new Uint8Array(audioBuffer).set(audioBytes);

  const blob = new Blob([audioBuffer], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType });

  const formData = new FormData();
  formData.append('file', file);
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');

  // Only send language to Groq if explicitly specified (not "auto")
  // When language is omitted, Groq's Whisper API performs automatic language detection
  if (requestData.language && requestData.language.toLowerCase() !== 'auto') {
    formData.append('language', requestData.language);
  }

  if (requestData.initial_prompt) {
    formData.append('prompt', requestData.initial_prompt);
  }

  // Log detailed request information before sending to Groq
  logger.log('info', 'Dispatching Groq transcription to API', {
    endpoint: transcriptionUrl,
    model,
    fileName,
    fileSize: audioBytes.byteLength,
    fileMimeType: mimeType,
    language: requestData.language || 'auto',
    hasInitialPrompt: !!requestData.initial_prompt,
    initialPromptLength: requestData.initial_prompt?.length || 0,
    estimatedDurationSeconds: estimatedSeconds,
    formDataFields: {
      file: fileName,
      model,
      response_format: 'verbose_json',
      language: requestData.language || '(omitted for auto-detect)',
    },
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
    logger.log('error', 'Groq transcription failed', {
      status: groqResponse.status,
      statusText: groqResponse.statusText,
      endpoint: transcriptionUrl,
      model,
      errorText,
    });

    throw new Error(`Groq transcription failed with status ${groqResponse.status}`);
  }

  const responseJson = (await groqResponse.json()) as WhisperResponse;
  const extraction = extractTranscriptionText(responseJson);

  // NO SPEECH DETECTED:
  // When Groq returns a valid response but with empty text, this means
  // no speech was detected in the audio (silence, background noise, etc.)
  // Instead of throwing an error, we return a valid response with source='no_speech'
  // so the client can display a friendly "No speech detected" message
  if (!extraction) {
    logger.log('info', 'No speech detected in audio', {
      responseKeys: isRecord(responseJson) ? Object.keys(responseJson) : 'non-object',
    });

    return {
      text: '',
      source: 'no_speech',
      response: responseJson,
      durationSeconds: 0,
      language: responseJson.language,
      segments: [],
      costUsd: 0,
    };
  }

  const detectedDuration = deriveDurationSeconds(responseJson.segments, responseJson.duration);
  const fallbackSeconds = Math.max(estimatedSeconds, 12);
  const durationSeconds = detectedDuration ?? fallbackSeconds;
  const costUsd = computeTranscriptionCost(durationSeconds);

  return {
    text: extraction.text,
    source: extraction.source,
    response: responseJson,
    durationSeconds,
    language: responseJson.language,
    segments: responseJson.segments,
    costUsd,
  };
}

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
    logger.log('error', 'Groq chat request failed', {
      requestId,
      status: response.status,
      statusText: response.statusText,
      endpoint: chatUrl,
      errorText,
    });
    throw new Error(`Groq chat failed with status ${response.status}`);
  }

  const json = await response.json();
  const usage = isRecord(json) && isGroqUsage(json['usage']) ? json['usage'] : undefined;
  const costUsd = usage ? computeChatCost(usage) : 0;

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
    temperature: 0.3,
    max_tokens: 2048,
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
