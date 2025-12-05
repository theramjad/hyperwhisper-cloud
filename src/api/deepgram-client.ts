// DEEPGRAM API CLIENT MODULE
// Handles API interactions with Deepgram Nova-3 for speech-to-text transcription
//
// KEY DIFFERENCES FROM GROQ WHISPER:
// 1. Authentication: Uses "Token {key}" header instead of "Bearer {key}"
// 2. Request body: Raw binary audio instead of multipart/form-data
// 3. Content-Type: Set to actual audio MIME type (e.g., "audio/mp4")
// 4. Custom vocabulary: Uses "keyterm" or "keywords" query parameter (see below)
// 5. Response format: Nested structure (results.channels[0].alternatives[0])
//
// VOCABULARY BOOSTING (KEYTERM for Nova-3):
// - KEYTERM: Monolingual only, Nova-3, up to 90% KRR improvement
//   Used when language is explicitly specified (e.g., language=en)
// - NONE: Nova-3 with auto-detect has no vocabulary support
//   (keywords parameter is rejected by Nova-3, keyterm is ignored with detect_language=true)
//
// PRICING (Nova-3 Batch):
// - $0.0043 per minute of audio (billed per second)
// - ~2.3x more expensive than Groq Whisper ($0.00185/min)
// - But offers better accuracy and vocabulary boosting features

import type { Env, TranscriptionRequest, WhisperSegment } from '../types';
import type {
  DeepgramResponse,
  DeepgramUtterance,
} from '../types';
import { Logger } from '../utils/logger';
import { safeReadText } from '../utils/utils';
import { computeDeepgramTranscriptionCost } from '../billing/cost-calculator';

// Deepgram API configuration
const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-3';

// Maximum number of keywords Deepgram accepts per request
// Frontend should also enforce this limit to provide better UX
const MAX_KEYWORDS = 100;

// Default boost intensifier for keywords (1.0 = no boost, 2.0 = double boost)
// 1.5 provides moderate boost without over-emphasizing terms
const DEFAULT_KEYWORD_INTENSIFIER = 1.5;

// MIME type mapping for Content-Type header
// Deepgram requires the actual audio MIME type, not multipart/form-data
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

const DEFAULT_AUDIO_MIME = 'audio/mp4';

// Transcription result type (compatible with existing interface)
export type TranscriptionResult = {
  text: string;
  source: string;
  response: DeepgramResponse;
  durationSeconds: number;
  language?: string;
  segments?: WhisperSegment[];
  costUsd: number;
};

/**
 * MIME TYPE NORMALIZATION
 * Ensures we send a valid Content-Type header to Deepgram
 *
 * @param inputMimeType - MIME type from the uploaded file
 * @param fallbackFileName - Filename to infer type from if MIME is missing
 * @returns Normalized MIME type string
 */
function normalizeMimeType(
  inputMimeType: string | undefined,
  fallbackFileName: string | undefined
): string {
  const candidate = inputMimeType?.toLowerCase().trim();

  // Check if we have a direct mapping for this MIME type
  if (candidate) {
    const mapped = MIME_OVERRIDES[candidate];
    if (mapped) {
      return mapped;
    }
  }

  // Try to infer from filename extension
  if (fallbackFileName) {
    const lowered = fallbackFileName.toLowerCase();
    if (lowered.endsWith('.wav')) return 'audio/wav';
    if (lowered.endsWith('.mp3') || lowered.endsWith('.mpeg') || lowered.endsWith('.mpga')) return 'audio/mpeg';
    if (lowered.endsWith('.flac')) return 'audio/flac';
    if (lowered.endsWith('.ogg')) return 'audio/ogg';
    if (lowered.endsWith('.opus')) return 'audio/opus';
    if (lowered.endsWith('.webm')) return 'audio/webm';
    if (lowered.endsWith('.m4a') || lowered.endsWith('.mp4')) return 'audio/mp4';
  }

  return DEFAULT_AUDIO_MIME;
}

/**
 * KEYWORD CONVERSION
 * Converts free-form initial_prompt text to Deepgram keywords format
 *
 * BACKWARDS COMPATIBLE - handles both old and new app formats:
 *
 * OLD FORMAT (bullet list from older app versions):
 *   "- HyperWhisper\n- SwiftUI\n- Claude"
 *
 * NEW FORMAT (comma-separated from newer app versions):
 *   "HyperWhisper,SwiftUI,Claude"
 *
 * OUTPUT (Deepgram format):
 *   "HyperWhisper:1.5,SwiftUI:1.5,Claude:1.5"
 *
 * RULES:
 * 1. Split on common delimiters (commas, newlines, semicolons)
 * 2. Strip bullet prefixes (- or *) for backwards compatibility
 * 3. Trim whitespace from each term
 * 4. Filter out empty or too-long terms (max 50 chars per term)
 * 5. Apply default intensifier (1.5) for moderate boost
 * 6. Cap at MAX_KEYWORDS (100) - frontend should also enforce this
 * 7. URL-encode each term to handle special characters
 *
 * @param initialPrompt - Free-form text with vocabulary terms
 * @returns URL-encoded keywords string for Deepgram query parameter
 */
function convertInitialPromptToKeywords(initialPrompt: string): string {
  // Split on common delimiters used in vocabulary lists
  const terms = initialPrompt
    .split(/[,\n;]+/)
    .map(t => {
      // Strip bullet prefixes for backwards compatibility with old app format
      // Old format: "- term" or "* term"
      // New format: "term" (no prefix)
      return t.trim().replace(/^[-*]\s*/, '');
    })
    .filter(t => {
      // Filter out invalid terms:
      // - Empty strings
      // - Terms longer than 50 characters (likely sentences, not vocabulary)
      // - Terms that are just whitespace
      return t.length > 0 && t.length <= 50 && /\S/.test(t);
    })
    .slice(0, MAX_KEYWORDS); // Deepgram's hard limit

  if (terms.length === 0) {
    return '';
  }

  // KEYTERM FORMAT (Nova-3):
  // Plain strings WITHOUT intensifiers - just comma-separated terms
  // Example: "term1,term2,term3"
  // Unlike old 'keywords' parameter, keyterms don't use :1.5 suffix
  // NOTE: Don't URL-encode here - URLSearchParams.set() handles encoding automatically
  return terms.join(',');
}

/**
 * UTTERANCE TO SEGMENT CONVERSION
 * Converts Deepgram utterances to Whisper-compatible segments
 *
 * This maintains compatibility with existing code that expects WhisperSegment[]
 * for timeline/segment display in the client app
 *
 * @param utterances - Array of Deepgram utterance objects
 * @returns Array of Whisper-compatible segment objects
 */
function convertUtterancesToSegments(utterances: DeepgramUtterance[]): WhisperSegment[] {
  return utterances.map((u, i) => ({
    id: i,
    start: u.start,
    end: u.end,
    text: u.transcript,
    // Note: Deepgram provides per-word confidence, we use utterance-level
    // These fields are optional in WhisperSegment
  }));
}

/**
 * BUILD DEEPGRAM API URL
 * Constructs the full URL with query parameters for the /listen endpoint
 *
 * Parameters explained:
 * - model: nova-3 (latest, best accuracy)
 * - smart_format: true (adds punctuation, capitalization, formatting)
 * - utterances: true (groups words by natural speech breaks)
 * - detect_language: true (auto-detect when language not specified)
 * - language: BCP-47 code (when explicitly specified)
 *
 * VOCABULARY BOOSTING - KEYTERM VS KEYWORDS:
 * Deepgram provides two different vocabulary boosting mechanisms:
 *
 * 1. KEYTERM (Nova-3 Only):
 *    - Parameter: keyterm=TERM:BOOST
 *    - Nova-3 ONLY supports keyterm (does NOT support keywords parameter)
 *    - Only works when language is explicitly specified (monolingual transcription)
 *    - Provides up to 90% improvement in Keyword Recall Rate (KRR)
 *    - When detect_language=true, keyterm is SILENTLY IGNORED by Deepgram
 *    - Nova-3 with auto-detect: No vocabulary support (keywords rejected, keyterm ignored)
 *    - Maximum 500 tokens across all keyterms
 *    - Best for: Named entities, product names, industry jargon, acronyms
 *
 * 2. KEYWORDS (Nova-2, Nova-1, Enhanced):
 *    - Parameter: keywords=TERM:BOOST
 *    - Works with Nova-2, Nova-1, Enhanced models (all languages)
 *    - Nova-3 does NOT support this parameter - will return 400 error
 *    - Provides moderate boost to recognition accuracy
 *    - Recommended max 200 terms
 *    - Compatible with: detect_language=true (multilingual mode)
 *
 * SELECTION LOGIC FOR NOVA-3:
 * - Language explicitly specified → Use 'keyterm' (monolingual, 90% KRR improvement)
 * - Language "auto" or not specified → No vocabulary parameter (keyterm ignored, keywords rejected)
 *
 * @param language - ISO language code or "auto" for detection
 * @param vocabularyTerms - Pre-formatted terms string (term:intensifier format)
 * @returns Full URL with query parameters
 */
function buildDeepgramUrl(language: string | undefined, vocabularyTerms: string): string {
  const params = new URLSearchParams();

  // Model selection - Nova-3 is the latest and most accurate
  params.set('model', DEEPGRAM_MODEL);

  // Smart formatting includes:
  // - Punctuation and capitalization
  // - Currency formatting ($1,234.56)
  // - Phone number formatting
  // - Date/time formatting
  params.set('smart_format', 'true');

  // Utterances segment transcript by natural speech breaks
  // This provides data similar to Whisper's segments[]
  params.set('utterances', 'true');

  // LANGUAGE HANDLING:
  // Determines both the transcription language AND vocabulary boosting method
  //
  // Two modes:
  // 1. MONOLINGUAL (language explicitly specified):
  //    - Sets language=CODE parameter
  //    - Uses 'keyterm' for vocabulary (90% KRR improvement)
  //
  // 2. MULTILINGUAL (language "auto" or not specified):
  //    - Enables detect_language=true
  //    - Uses 'keywords' for vocabulary (works with detection)
  //    - Deepgram returns detected_language in response
  const isMonolingual = language && language.toLowerCase() !== 'auto';

  if (isMonolingual) {
    // MONOLINGUAL MODE: Force specific language
    // Deepgram uses BCP-47 codes (same as Whisper)
    params.set('language', language.toLowerCase());
  } else {
    // MULTILINGUAL MODE: Enable automatic language detection
    // Deepgram will return detected_language in the response
    params.set('detect_language', 'true');
  }

  // VOCABULARY BOOSTING FOR NOVA-3:
  // Nova-3 uses 'keyterm' parameter (NOT 'keywords' - that's for older models)
  //
  // KEYTERM PROMPTING:
  // - Works with BOTH monolingual and multilingual transcription
  // - Up to 90% improvement in Keyword Recall Rate (KRR)
  // - No intensifiers needed (plain strings, not term:1.5 format)
  // - Max 500 tokens total, recommended 20-50 terms for best results
  //
  // Reference: https://developers.deepgram.com/docs/keyterm
  // "Keyterm Prompting is available for both monolingual and multilingual transcription"
  if (vocabularyTerms.length > 0) {
    params.set('keyterm', vocabularyTerms);
  }

  return `${DEEPGRAM_API_URL}?${params.toString()}`;
}

/**
 * MAIN TRANSCRIPTION FUNCTION
 * Sends audio to Deepgram Nova-3 and returns normalized result
 *
 * FLOW:
 * 1. Use raw binary audio directly (no base64 decode needed)
 * 2. Normalize MIME type for Content-Type header
 * 3. Convert initial_prompt to keywords format
 * 4. Build API URL with query parameters
 * 5. Send POST request with binary body
 * 6. Parse response and normalize to TranscriptionResult
 *
 * MEMORY OPTIMIZATION:
 * Audio is now passed as raw Uint8Array from index.ts, eliminating:
 * - Base64 encoding overhead (33% size increase)
 * - Base64 decoding step here
 * - Multiple memory copies
 * This reduces memory usage by ~65% for large audio files.
 *
 * ERROR HANDLING:
 * - 401: Invalid API key
 * - 402: Insufficient Deepgram account funds
 * - 429: Rate limit (100 concurrent requests max)
 * - 400: Bad request / unsupported format
 *
 * @param requestData - Transcription request with audio and options
 * @param env - Environment variables including DEEPGRAM_API_KEY
 * @param logger - Logger instance for request tracking
 * @param estimatedSeconds - Pre-calculated duration estimate for fallback
 * @returns TranscriptionResult compatible with existing interface
 */
export async function transcribeWithDeepgram(
  requestData: TranscriptionRequest,
  env: Env,
  logger: Logger,
  estimatedSeconds: number
): Promise<TranscriptionResult> {
  // STEP 1: Use raw binary audio directly (already Uint8Array from index.ts)
  // No base64 decoding needed - saves memory and CPU
  const audioBytes = requestData.audio;

  // STEP 2: Normalize MIME type for Content-Type header
  const mimeType = normalizeMimeType(requestData.audioMimeType, requestData.audioFileName);

  // STEP 3: Convert initial_prompt to Deepgram keywords format
  const keywords = requestData.initial_prompt
    ? convertInitialPromptToKeywords(requestData.initial_prompt)
    : '';

  // STEP 4: Build URL with query parameters
  const url = buildDeepgramUrl(requestData.language, keywords);

  // Determine vocabulary boosting method for logging
  // KEYTERM: Monolingual only (language explicitly specified), 90% KRR improvement
  // NONE: Multilingual/auto-detect (Nova-3 doesn't support keywords, keyterm is ignored)
  const isMonolingual = requestData.language && requestData.language.toLowerCase() !== 'auto';
  const vocabularyMethod = (keywords.length > 0 && isMonolingual) ? 'keyterm' : 'none';

  // Log detailed request information before sending to Deepgram
  logger.log('info', 'Dispatching Deepgram transcription to API', {
    endpoint: url,
    model: DEEPGRAM_MODEL,
    fileSize: audioBytes.byteLength,
    fileMimeType: mimeType,
    language: requestData.language || 'auto',
    languageMode: isMonolingual ? 'monolingual' : 'multilingual',
    vocabularyMethod,  // 'keyterm' (monolingual), 'keywords' (multilingual), or 'none'
    vocabularyTermCount: keywords ? keywords.split(',').length : 0,
    estimatedDurationSeconds: estimatedSeconds,
  });

  // STEP 5: Send POST request with raw binary body
  // Key differences from Groq:
  // - Authorization: "Token {key}" not "Bearer {key}"
  // - Content-Type: actual audio MIME type, not multipart/form-data
  // - Body: raw binary ArrayBuffer, not FormData
  //
  // NOTE: Cloudflare Workers fetch() expects ArrayBuffer, not Uint8Array
  // We create a new ArrayBuffer and copy the bytes to ensure correct typing
  const audioBuffer = new ArrayBuffer(audioBytes.byteLength);
  new Uint8Array(audioBuffer).set(audioBytes);

  const deepgramResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': mimeType,
    },
    body: audioBuffer,
  });

  // Handle API errors
  if (!deepgramResponse.ok) {
    const errorText = await safeReadText(deepgramResponse);
    logger.log('error', 'Deepgram transcription failed', {
      status: deepgramResponse.status,
      statusText: deepgramResponse.statusText,
      endpoint: url,
      errorText,
    });

    // Provide specific error messages for known status codes
    if (deepgramResponse.status === 401) {
      throw new Error('Deepgram API key is invalid or expired');
    }
    if (deepgramResponse.status === 402) {
      throw new Error('Deepgram account has insufficient funds');
    }
    if (deepgramResponse.status === 429) {
      throw new Error('Deepgram rate limit exceeded (max 100 concurrent requests)');
    }

    throw new Error(`Deepgram transcription failed with status ${deepgramResponse.status}`);
  }

  // STEP 6: Parse response and normalize
  const responseJson = (await deepgramResponse.json()) as DeepgramResponse;

  // Extract transcript from nested response structure
  const channel = responseJson.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const transcript = alternative?.transcript || '';

  // NO SPEECH DETECTED:
  // When Deepgram returns a valid response but with empty transcript,
  // this means no speech was detected in the audio (silence, background noise)
  // Return a valid response with source='no_speech' so client can display friendly message
  if (!transcript || transcript.trim().length === 0) {
    logger.log('info', 'No speech detected in audio', {
      deepgramRequestId: responseJson.metadata?.request_id,
      duration: responseJson.metadata?.duration,
    });

    return {
      text: '',
      source: 'no_speech',
      response: responseJson,
      durationSeconds: 0,
      language: channel?.detected_language,
      segments: [],
      costUsd: 0,
    };
  }

  // Calculate duration and cost
  const durationSeconds = responseJson.metadata?.duration ?? estimatedSeconds;
  const costUsd = computeDeepgramTranscriptionCost(durationSeconds);

  // Convert utterances to Whisper-compatible segments for client compatibility
  const segments = responseJson.results?.utterances
    ? convertUtterancesToSegments(responseJson.results.utterances)
    : [];

  logger.log('info', 'Deepgram transcription successful', {
    deepgramRequestId: responseJson.metadata?.request_id,
    durationSeconds,
    detectedLanguage: channel?.detected_language,
    languageConfidence: channel?.language_confidence,
    transcriptLength: transcript.length,
    utteranceCount: responseJson.results?.utterances?.length ?? 0,
    costUsd,
  });

  return {
    text: transcript,
    source: 'deepgram_nova3',
    response: responseJson,
    durationSeconds,
    language: channel?.detected_language,
    segments,
    costUsd,
  };
}

// ============================================================================
// STREAMING TRANSCRIPTION FUNCTION
// ============================================================================

/**
 * STREAMING TRANSCRIPTION RESULT
 * Simplified response type for the /transcribe streaming endpoint
 */
export type StreamingTranscriptionResult = {
  text: string;
  language?: string;
  durationSeconds: number;
  costUsd: number;
  requestId?: string;
  source: string;
};

/**
 * STREAMING TRANSCRIPTION FUNCTION
 * Pipes audio stream directly to Deepgram without buffering
 *
 * KEY MEMORY OPTIMIZATION:
 * In Cloudflare Workers, `request.body` is a `ReadableStream<Uint8Array>`.
 * When passed directly to `fetch(url, { body: request.body })`, it pipes
 * through without loading into memory. This reduces memory usage from
 * ~34MB (2x file size) to ~0MB for large files.
 *
 * This function accepts:
 * 1. ReadableStream<Uint8Array> - Direct stream pass-through (0 memory)
 * 2. ArrayBuffer - For smaller files or when stream isn't available
 *
 * FLOW:
 * 1. Build Deepgram URL with query parameters
 * 2. Pass audio stream/buffer directly to Deepgram
 * 3. Parse response and return simplified result
 *
 * @param audioBody - ReadableStream or ArrayBuffer of audio data
 * @param contentType - MIME type of the audio (e.g., "audio/mp4")
 * @param language - ISO language code or "auto" for detection
 * @param initialPrompt - Optional comma-separated vocabulary terms
 * @param env - Environment variables including DEEPGRAM_API_KEY
 * @param logger - Logger instance for request tracking
 * @returns StreamingTranscriptionResult with text, language, duration, cost
 */
export async function transcribeWithDeepgramStream(
  audioBody: ReadableStream<Uint8Array> | ArrayBuffer,
  contentType: string,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<StreamingTranscriptionResult> {
  // STEP 1: Convert vocabulary terms to Deepgram keyterm format
  const keywords = initialPrompt
    ? convertInitialPromptToKeywords(initialPrompt)
    : '';

  // STEP 2: Build URL with query parameters
  const url = buildDeepgramUrl(language, keywords);

  // Determine vocabulary boosting method for logging
  const isMonolingual = language && language.toLowerCase() !== 'auto';
  const vocabularyMethod = (keywords.length > 0 && isMonolingual) ? 'keyterm' : 'none';

  // Log request details
  logger.log('info', 'Dispatching streaming Deepgram transcription', {
    endpoint: url,
    model: DEEPGRAM_MODEL,
    contentType,
    language: language || 'auto',
    languageMode: isMonolingual ? 'monolingual' : 'multilingual',
    vocabularyMethod,
    vocabularyTermCount: keywords ? keywords.split(',').length : 0,
    isStreaming: audioBody instanceof ReadableStream,
  });

  // STEP 3: Send POST request with stream/buffer body
  // The magic happens here: fetch() accepts ReadableStream as body
  // Cloudflare pipes the data through without buffering
  const deepgramResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${env.DEEPGRAM_API_KEY}`,
      'Content-Type': contentType,
    },
    body: audioBody,
  });

  // Handle API errors
  if (!deepgramResponse.ok) {
    const errorText = await safeReadText(deepgramResponse);
    logger.log('error', 'Streaming Deepgram transcription failed', {
      status: deepgramResponse.status,
      statusText: deepgramResponse.statusText,
      endpoint: url,
      errorText,
    });

    // Provide specific error messages for known status codes
    if (deepgramResponse.status === 401) {
      throw new Error('Deepgram API key is invalid or expired');
    }
    if (deepgramResponse.status === 402) {
      throw new Error('Deepgram account has insufficient funds');
    }
    if (deepgramResponse.status === 429) {
      throw new Error('Deepgram rate limit exceeded (max 100 concurrent requests)');
    }

    throw new Error(`Deepgram transcription failed with status ${deepgramResponse.status}`);
  }

  // STEP 4: Parse response
  const responseJson = (await deepgramResponse.json()) as DeepgramResponse;

  // Extract transcript from nested response structure
  const channel = responseJson.results?.channels?.[0];
  const alternative = channel?.alternatives?.[0];
  const transcript = alternative?.transcript || '';

  // NO SPEECH DETECTED:
  // Return empty result with source='no_speech' for client to handle gracefully
  if (!transcript || transcript.trim().length === 0) {
    logger.log('info', 'No speech detected in streaming audio', {
      deepgramRequestId: responseJson.metadata?.request_id,
      duration: responseJson.metadata?.duration,
    });

    return {
      text: '',
      language: channel?.detected_language,
      durationSeconds: 0,
      costUsd: 0,
      requestId: responseJson.metadata?.request_id,
      source: 'no_speech',
    };
  }

  // Calculate duration and cost
  const durationSeconds = responseJson.metadata?.duration ?? 0;
  const costUsd = computeDeepgramTranscriptionCost(durationSeconds);

  logger.log('info', 'Streaming Deepgram transcription successful', {
    deepgramRequestId: responseJson.metadata?.request_id,
    durationSeconds,
    detectedLanguage: channel?.detected_language,
    languageConfidence: channel?.language_confidence,
    transcriptLength: transcript.length,
    costUsd,
  });

  return {
    text: transcript,
    language: channel?.detected_language,
    durationSeconds,
    costUsd,
    requestId: responseJson.metadata?.request_id,
    source: 'deepgram_nova3',
  };
}
