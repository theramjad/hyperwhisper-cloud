// ELEVENLABS API CLIENT MODULE
// Handles API interactions with ElevenLabs Scribe v2 for speech-to-text transcription
//
// KEY DIFFERENCES FROM DEEPGRAM:
// 1. Authentication: Uses "xi-api-key: {key}" header instead of "Authorization: Token {key}"
// 2. Request body: multipart/form-data instead of raw binary
// 3. Vocabulary: JSON array in 'keyterms' FormData field (works with auto-detect)
// 4. URL upload: FormData 'cloud_storage_url' field instead of JSON body
// 5. Response format: Flat { text, words[] } instead of nested structure
// 6. Language codes: ISO-639-3 (eng, jpn) instead of ISO-639-1 (en, ja)
//
// PRICING (Scribe v2):
// - $0.00983 per minute of audio
// - ~2.3x more expensive than Deepgram ($0.0043/min)
// - Better transcription accuracy

import type { Env, WhisperSegment, ElevenLabsResponse, ElevenLabsWord } from '../types';
import { Logger } from '../utils/logger';
import { safeReadText } from '../utils/utils';
import { computeElevenLabsTranscriptionCost } from '../billing/cost-calculator';

// ElevenLabs API configuration
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_MODEL = 'scribe_v2';

// Maximum number of keyterms ElevenLabs accepts per request
const MAX_KEYTERMS = 100;

// Maximum length per keyterm
const MAX_KEYTERM_LENGTH = 50;

// Retry configuration for rate limits
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// ISO-639-1 to ISO-639-3 language code mapping
// ElevenLabs uses ISO-639-3 codes (3 letters) instead of ISO-639-1 (2 letters)
const ISO_639_1_TO_3: Record<string, string> = {
  'en': 'eng',
  'es': 'spa',
  'fr': 'fra',
  'de': 'deu',
  'it': 'ita',
  'pt': 'por',
  'ja': 'jpn',
  'ko': 'kor',
  'zh': 'zho',
  'ar': 'ara',
  'ru': 'rus',
  'hi': 'hin',
  'nl': 'nld',
  'pl': 'pol',
  'tr': 'tur',
  'vi': 'vie',
  'th': 'tha',
  'id': 'ind',
  'uk': 'ukr',
  'cs': 'ces',
  'ro': 'ron',
  'el': 'ell',
  'hu': 'hun',
  'sv': 'swe',
  'da': 'dan',
  'fi': 'fin',
  'no': 'nor',
  'he': 'heb',
  'ms': 'msa',
  'bn': 'ben',
  'ta': 'tam',
  'te': 'tel',
  'mr': 'mar',
  'gu': 'guj',
  'kn': 'kan',
  'ml': 'mal',
  'pa': 'pan',
  'ur': 'urd',
  'fa': 'fas',
  'af': 'afr',
  'sq': 'sqi',
  'am': 'amh',
  'hy': 'hye',
  'az': 'aze',
  'eu': 'eus',
  'be': 'bel',
  'bs': 'bos',
  'bg': 'bul',
  'ca': 'cat',
  'hr': 'hrv',
  'et': 'est',
  'tl': 'tgl',
  'gl': 'glg',
  'ka': 'kat',
  'is': 'isl',
  'ga': 'gle',
  'kk': 'kaz',
  'km': 'khm',
  'lo': 'lao',
  'lv': 'lav',
  'lt': 'lit',
  'mk': 'mkd',
  'mt': 'mlt',
  'mn': 'mon',
  'my': 'mya',
  'ne': 'nep',
  'ps': 'pus',
  'si': 'sin',
  'sk': 'slk',
  'sl': 'slv',
  'so': 'som',
  'sw': 'swa',
  'sr': 'srp',
  'su': 'sun',
  'jv': 'jav',
  'cy': 'cym',
  'zu': 'zul',
};

/**
 * MAP LANGUAGE CODE
 * Converts ISO-639-1 (2-letter) codes to ISO-639-3 (3-letter) codes for ElevenLabs
 *
 * @param code - ISO-639-1 language code (e.g., "en", "ja") or "auto"
 * @returns ISO-639-3 code (e.g., "eng", "jpn") or empty string for auto-detect
 */
function mapLanguageCode(code: string | undefined): string {
  if (!code || code.toLowerCase() === 'auto') {
    return ''; // Let ElevenLabs auto-detect
  }

  const normalized = code.toLowerCase().trim();

  // Check if already ISO-639-3 (3 letters)
  if (normalized.length === 3) {
    return normalized;
  }

  // Map ISO-639-1 to ISO-639-3
  return ISO_639_1_TO_3[normalized] || normalized;
}

/**
 * CONVERT INITIAL PROMPT TO KEYTERMS
 * Converts free-form initial_prompt text to ElevenLabs keyterms array
 *
 * BACKWARDS COMPATIBLE - handles both old and new app formats:
 *
 * OLD FORMAT (bullet list from older app versions):
 *   "- HyperWhisper\n- SwiftUI\n- Claude"
 *
 * NEW FORMAT (comma-separated from newer app versions):
 *   "HyperWhisper,SwiftUI,Claude"
 *
 * OUTPUT (ElevenLabs format):
 *   ["HyperWhisper", "SwiftUI", "Claude"]
 *
 * @param initialPrompt - Free-form text with vocabulary terms
 * @returns Array of keyterm strings
 */
function convertInitialPromptToKeyterms(initialPrompt: string): string[] {
  const terms = initialPrompt
    .split(/[,\n;]+/)
    .map(t => {
      // Strip bullet prefixes for backwards compatibility
      return t.trim().replace(/^[-*]\s*/, '');
    })
    .filter(t => {
      // Filter out invalid terms
      return t.length > 0 && t.length <= MAX_KEYTERM_LENGTH && /\S/.test(t);
    })
    .slice(0, MAX_KEYTERMS);

  return terms;
}

/**
 * CALCULATE DURATION FROM WORDS
 * ElevenLabs doesn't return a duration field, so we calculate it from the last word's end time
 *
 * @param words - Array of ElevenLabs word objects with timing
 * @returns Duration in seconds
 */
function calculateDurationFromWords(words: ElevenLabsWord[] | undefined): number {
  if (!words || words.length === 0) {
    return 0;
  }

  // Find the last word and use its end time
  const lastWord = words[words.length - 1];
  return lastWord.end || 0;
}

/**
 * CONVERT WORDS TO SEGMENTS
 * Converts ElevenLabs word-level output to Whisper-compatible segments
 *
 * ElevenLabs provides word-level timing but not utterance-level segments.
 * We group words into segments by detecting natural pauses (gaps > 0.5s).
 *
 * @param words - Array of ElevenLabs word objects
 * @returns Array of Whisper-compatible segment objects
 */
function convertWordsToSegments(words: ElevenLabsWord[] | undefined): WhisperSegment[] {
  if (!words || words.length === 0) {
    return [];
  }

  const segments: WhisperSegment[] = [];
  let currentSegment: { start: number; end: number; words: string[] } | null = null;
  const PAUSE_THRESHOLD = 0.5; // seconds - gap that indicates a new segment

  for (const word of words) {
    // Skip non-word tokens (spacing, audio events)
    if (word.type !== 'word') {
      continue;
    }

    if (!currentSegment) {
      // Start new segment
      currentSegment = { start: word.start, end: word.end, words: [word.text] };
    } else {
      // Check if there's a significant pause
      const gap = word.start - currentSegment.end;
      if (gap > PAUSE_THRESHOLD) {
        // Save current segment and start new one
        segments.push({
          id: segments.length,
          start: currentSegment.start,
          end: currentSegment.end,
          text: currentSegment.words.join(' '),
        });
        currentSegment = { start: word.start, end: word.end, words: [word.text] };
      } else {
        // Continue current segment
        currentSegment.end = word.end;
        currentSegment.words.push(word.text);
      }
    }
  }

  // Don't forget the last segment
  if (currentSegment && currentSegment.words.length > 0) {
    segments.push({
      id: segments.length,
      start: currentSegment.start,
      end: currentSegment.end,
      text: currentSegment.words.join(' '),
    });
  }

  return segments;
}

/**
 * SLEEP UTILITY
 * Promise-based sleep for retry backoff
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * NORMALIZE ERROR TO CURRENT FORMAT
 * Maps ElevenLabs error responses to existing error codes for client compatibility
 */
function normalizeElevenLabsError(status: number, errorText: string): Error {
  switch (status) {
    case 401:
      return new Error('ElevenLabs API key is invalid or expired');
    case 422:
      // Parse ElevenLabs validation error details if available
      try {
        const parsed = JSON.parse(errorText);
        const detail = parsed?.detail?.message || parsed?.detail || 'Validation error';
        return new Error(`ElevenLabs validation error: ${detail}`);
      } catch {
        return new Error('ElevenLabs validation error');
      }
    case 429:
      return new Error('ElevenLabs rate limit exceeded');
    default:
      if (status >= 500) {
        return new Error('ElevenLabs service error - please try again');
      }
      return new Error(`ElevenLabs transcription failed with status ${status}`);
  }
}

// ============================================================================
// STREAMING TRANSCRIPTION RESULT TYPE
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

// ============================================================================
// STREAMING TRANSCRIPTION FUNCTION
// ============================================================================

/**
 * STREAMING TRANSCRIPTION FUNCTION
 * Transcribes audio from a stream or buffer using ElevenLabs Scribe v2
 *
 * IMPORTANT: Unlike Deepgram, ElevenLabs requires multipart/form-data.
 * We must buffer the entire audio to construct the FormData.
 * This is why we reduced the R2 threshold to 15MB (from 30MB) to stay within
 * the 128MB Worker memory limit.
 *
 * @param audioBody - ReadableStream or ArrayBuffer of audio data
 * @param contentType - MIME type of the audio (e.g., "audio/mp4")
 * @param contentLength - Size of the audio in bytes
 * @param language - ISO language code or "auto" for detection
 * @param initialPrompt - Optional comma-separated vocabulary terms
 * @param env - Environment variables including ELEVENLABS_API_KEY
 * @param logger - Logger instance for request tracking
 * @returns StreamingTranscriptionResult with text, language, duration, cost
 */
export async function transcribeWithElevenLabsFromStream(
  audioBody: ReadableStream<Uint8Array> | ArrayBuffer,
  contentType: string,
  contentLength: number,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<StreamingTranscriptionResult> {
  // STEP 1: Buffer the audio (required for FormData)
  // ElevenLabs doesn't support raw binary POST like Deepgram
  let audioBuffer: ArrayBuffer;
  if (audioBody instanceof ReadableStream) {
    // Collect stream into buffer
    const reader = audioBody.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    // Combine chunks into single ArrayBuffer
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    audioBuffer = combined.buffer;
  } else {
    audioBuffer = audioBody;
  }

  // STEP 2: Prepare keyterms
  const keyterms = initialPrompt
    ? convertInitialPromptToKeyterms(initialPrompt)
    : [];

  // STEP 3: Map language code to ISO-639-3
  const languageCode = mapLanguageCode(language);

  // STEP 4: Build FormData
  // Infer filename from content type
  const extension = contentType.includes('mp4') || contentType.includes('m4a') ? 'm4a' :
                    contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3' :
                    contentType.includes('wav') ? 'wav' :
                    contentType.includes('flac') ? 'flac' :
                    contentType.includes('ogg') ? 'ogg' :
                    contentType.includes('webm') ? 'webm' : 'audio';

  const fileName = `audio.${extension}`;
  const audioBlob = new Blob([audioBuffer], { type: contentType });

  const formData = new FormData();
  formData.append('model_id', ELEVENLABS_MODEL);
  formData.append('file', audioBlob, fileName);
  formData.append('timestamps_granularity', 'word');
  formData.append('tag_audio_events', 'false');

  if (languageCode) {
    formData.append('language_code', languageCode);
  }

  if (keyterms.length > 0) {
    formData.append('biased_keywords', JSON.stringify(keyterms));
  }

  // Log request details
  logger.log('info', 'Dispatching ElevenLabs transcription', {
    endpoint: ELEVENLABS_API_URL,
    model: ELEVENLABS_MODEL,
    contentType,
    contentLength,
    language: language || 'auto',
    languageCode: languageCode || 'auto-detect',
    keytermsCount: keyterms.length,
  });

  // STEP 5: Send request with retry logic for rate limits
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(ELEVENLABS_API_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    // Success
    if (response.ok) {
      const responseJson = (await response.json()) as ElevenLabsResponse;

      // Extract transcript
      const transcript = responseJson.text || '';

      // NO SPEECH DETECTED
      if (!transcript || transcript.trim().length === 0) {
        logger.log('info', 'No speech detected in audio', {
          languageCode: responseJson.language_code,
          languageConfidence: responseJson.language_probability,
        });

        return {
          text: '',
          language: responseJson.language_code,
          durationSeconds: 0,
          costUsd: 0,
          source: 'no_speech',
        };
      }

      // Calculate duration from word timestamps
      const durationSeconds = calculateDurationFromWords(responseJson.words);
      const costUsd = computeElevenLabsTranscriptionCost(durationSeconds);

      logger.log('info', 'ElevenLabs transcription successful', {
        durationSeconds,
        detectedLanguage: responseJson.language_code,
        languageConfidence: responseJson.language_probability,
        transcriptLength: transcript.length,
        wordCount: responseJson.words?.length || 0,
        costUsd,
      });

      return {
        text: transcript,
        language: responseJson.language_code,
        durationSeconds,
        costUsd,
        source: 'elevenlabs_scribe_v2',
      };
    }

    // Rate limit - retry with backoff
    if (response.status === 429 && attempt < MAX_RETRIES - 1) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      logger.log('warn', `ElevenLabs rate limit hit, retrying in ${backoffMs}ms`, {
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
      });
      await sleep(backoffMs);
      continue;
    }

    // Other error - capture and potentially retry
    const errorText = await safeReadText(response) || '';
    logger.log('error', 'ElevenLabs API returned error', {
      status: response.status,
      statusText: response.statusText,
      errorText,
      attempt: attempt + 1,
    });

    lastError = normalizeElevenLabsError(response.status, errorText);

    // Don't retry client errors (4xx except 429)
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw lastError;
    }
  }

  // All retries exhausted
  throw lastError || new Error('ElevenLabs transcription failed after retries');
}

// ============================================================================
// URL-BASED TRANSCRIPTION FUNCTION (FOR LARGE FILES VIA R2)
// ============================================================================

/**
 * URL-BASED TRANSCRIPTION FUNCTION
 * Sends an R2 presigned URL to ElevenLabs instead of uploading audio data
 *
 * USE CASE:
 * For large files (>15MB), we upload to R2 first, then give ElevenLabs the URL.
 * This bypasses Worker memory limits.
 *
 * @param audioUrl - Presigned R2 URL where ElevenLabs can fetch the audio
 * @param language - ISO language code or "auto" for detection
 * @param initialPrompt - Optional comma-separated vocabulary terms
 * @param env - Environment variables including ELEVENLABS_API_KEY
 * @param logger - Logger instance for request tracking
 * @returns StreamingTranscriptionResult with text, language, duration, cost
 */
export async function transcribeWithElevenLabsFromUrl(
  audioUrl: string,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<StreamingTranscriptionResult> {
  // STEP 1: Prepare keyterms
  const keyterms = initialPrompt
    ? convertInitialPromptToKeyterms(initialPrompt)
    : [];

  // STEP 2: Map language code to ISO-639-3
  const languageCode = mapLanguageCode(language);

  // STEP 3: Build FormData with URL instead of file
  const formData = new FormData();
  formData.append('model_id', ELEVENLABS_MODEL);
  formData.append('cloud_storage_url', audioUrl);
  formData.append('timestamps_granularity', 'word');
  formData.append('tag_audio_events', 'false');

  if (languageCode) {
    formData.append('language_code', languageCode);
  }

  if (keyterms.length > 0) {
    formData.append('biased_keywords', JSON.stringify(keyterms));
  }

  // Log request details
  logger.log('info', 'Dispatching URL-based ElevenLabs transcription', {
    endpoint: ELEVENLABS_API_URL,
    model: ELEVENLABS_MODEL,
    audioUrl: audioUrl.substring(0, 80) + '...', // Truncate for logging
    language: language || 'auto',
    languageCode: languageCode || 'auto-detect',
    keytermsCount: keyterms.length,
  });

  // STEP 4: Send request with retry logic
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(ELEVENLABS_API_URL, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
      },
      body: formData,
    });

    // Success
    if (response.ok) {
      const responseJson = (await response.json()) as ElevenLabsResponse;

      const transcript = responseJson.text || '';

      // NO SPEECH DETECTED
      if (!transcript || transcript.trim().length === 0) {
        logger.log('info', 'No speech detected in URL-based audio', {
          languageCode: responseJson.language_code,
          languageConfidence: responseJson.language_probability,
        });

        return {
          text: '',
          language: responseJson.language_code,
          durationSeconds: 0,
          costUsd: 0,
          source: 'no_speech',
        };
      }

      const durationSeconds = calculateDurationFromWords(responseJson.words);
      const costUsd = computeElevenLabsTranscriptionCost(durationSeconds);

      logger.log('info', 'URL-based ElevenLabs transcription successful', {
        durationSeconds,
        detectedLanguage: responseJson.language_code,
        languageConfidence: responseJson.language_probability,
        transcriptLength: transcript.length,
        wordCount: responseJson.words?.length || 0,
        costUsd,
      });

      return {
        text: transcript,
        language: responseJson.language_code,
        durationSeconds,
        costUsd,
        source: 'elevenlabs_scribe_v2_url',
      };
    }

    // Rate limit - retry with backoff
    if (response.status === 429 && attempt < MAX_RETRIES - 1) {
      const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      logger.log('warn', `ElevenLabs rate limit hit (URL), retrying in ${backoffMs}ms`, {
        attempt: attempt + 1,
        maxRetries: MAX_RETRIES,
      });
      await sleep(backoffMs);
      continue;
    }

    // Other error
    const errorText = await safeReadText(response) || '';
    logger.log('error', 'URL-based ElevenLabs transcription failed', {
      status: response.status,
      statusText: response.statusText,
      errorText,
      attempt: attempt + 1,
    });

    lastError = normalizeElevenLabsError(response.status, errorText);

    // Don't retry client errors (4xx except 429)
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw lastError;
    }
  }

  throw lastError || new Error('ElevenLabs URL transcription failed after retries');
}

// ============================================================================
// EXPORTS FOR COMPATIBILITY
// ============================================================================

// Re-export segment conversion for use in handlers if needed
export { convertWordsToSegments, calculateDurationFromWords };
