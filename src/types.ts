// ============================================================================
// TYPE DEFINITIONS FOR HYPERWHISPER CLOUDFLARE WORKER
// Centralized TypeScript interfaces for the edge transcription service
// ============================================================================

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

// Cloudflare Worker environment bindings
export interface Env {
  // Transcription APIs
  DEEPGRAM_API_KEY: string;     // Deepgram API key for Nova-3 transcription (kept for rollback)
  ELEVENLABS_API_KEY: string;   // ElevenLabs API key for Scribe v2 transcription
  GROQ_API_KEY: string;         // Groq API key for Llama post-processing
  GROQ_BASE_URL?: string;     // Optional custom Groq base URL

  // KV Namespaces
  RATE_LIMITER: KVNamespace;   // IP-based rate limiting (daily quota)
  DEVICE_CREDITS: KVNamespace; // Device trial credits (150 credits per device_id)
  LICENSE_CACHE: KVNamespace;  // License validation cache (5 min TTL for credits)

  // License/Credits API (Next.js backend)
  // CF Workers call these endpoints for license validation and credit management
  // The license key itself acts as authentication - no separate API key needed
  HYPERWHISPER_API_URL: string; // Base URL (e.g., "https://hyperwhisper.com")

  // R2 Storage
  // Bucket for temporary audio storage (large file transcription >30MB)
  // Files are uploaded to R2, Deepgram fetches via presigned URL, then deleted
  AUDIO_BUCKET: R2Bucket;

  // R2 API Credentials (for presigned URL generation)
  // Required for Deepgram to fetch audio from R2 via signed URLs
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_ACCOUNT_ID: string; // Cloudflare account ID (visible in dashboard URL)

  // Environment indicator (set in wrangler.toml)
  ENVIRONMENT?: string; // "development" or "production"
}

// ============================================================================
// CLIENT REQUEST TYPES
// ============================================================================

// Transcription request from client
// Audio data with optional device/license identifier
export interface TranscriptionRequest {
  audio: Uint8Array;                   // Raw binary audio data (NOT base64 - saves ~65% memory)
  audioMimeType?: string;              // Original MIME type (e.g., "audio/mp4")
  audioFileName?: string;              // Original filename with extension
  language?: string;                   // ISO language code (e.g., "en", "es")
  mode?: string;                       // Transcription mode for post-processing
  device_id?: string;                  // Device identifier for trial users
  license_key?: string;                // License key for licensed users
  post_processing_enabled?: boolean;   // Whether the client wants server-side post-processing
  post_processing_prompt?: string;     // Optional system prompt provided by the client
  initial_prompt?: string;             // Optional initial prompt/custom vocabulary for Whisper
}

// Post-processing request (JSON body for POST /post-process)
export interface PostProcessRequest {
  text: string;          // Raw transcription to process
  prompt: string;        // System prompt for correction
  license_key?: string;  // Licensed user auth
  device_id?: string;    // Trial user auth
}

// ============================================================================
// CLIENT RESPONSE TYPES
// ============================================================================

// Streaming transcription response (POST /transcribe)
// Simplified response designed for zero-buffer streaming from client
export interface StreamingTranscriptionResponse {
  text: string;                  // Transcribed text
  language?: string;             // Detected or specified language code
  duration: number;              // Audio duration in seconds
  no_speech_detected?: boolean;  // True if no speech was found
  cost: {
    usd: number;     // Cost in USD
    credits: number; // Credits charged
  };
  metadata: {
    request_id: string;  // Unique request identifier
    stt_provider: string; // Always "deepgram-nova3"
  };
}

// Post-processing response (POST /post-process)
export interface PostProcessResponse {
  corrected: string; // Post-processed text
  cost: {
    usd: number;     // Cost in USD
    credits: number; // Credits charged
  };
}

// Usage response (GET /usage)
export interface UsageResponse {
  credits_remaining: number;
  minutes_remaining: number;
  credits_per_minute: number;
  is_licensed: boolean;
  is_trial?: boolean;         // True for device_id users (trial credits)
  is_anonymous: boolean;      // Should always be false (anonymous users are rejected)
  resets_at?: string;         // ISO date for IP daily quota
  customer_id?: string;       // Polar customer ID for licensed users
  device_id?: string;         // Device ID for trial users
  total_allocated?: number;   // Total credits allocated (trial users only)
  credits_used?: number;      // Credits used so far (trial users only)
}

// ============================================================================
// DEEPGRAM API TYPES
// ============================================================================

// Structure returned from Deepgram Nova-3 /listen endpoint
//
// Response hierarchy:
// DeepgramResponse
//   └── results
//       ├── channels[] (one per audio channel, usually 1)
//       │   └── alternatives[] (transcription variants, usually 1)
//       │       ├── transcript (full text)
//       │       ├── confidence (0-1)
//       │       └── words[] (word-level timing)
//       └── utterances[] (speech segments with timing)

export interface DeepgramResponse {
  metadata: DeepgramMetadata;
  results: DeepgramResults;
}

export interface DeepgramMetadata {
  request_id: string;
  sha256?: string;
  created?: string;
  duration: number;                    // Audio duration in seconds
  channels: number;                    // Number of audio channels (usually 1)
  models?: string[];
  model_info?: Record<string, unknown>;
}

export interface DeepgramResults {
  channels: DeepgramChannel[];
  utterances?: DeepgramUtterance[];
}

export interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
  detected_language?: string;    // BCP-47 language code (e.g., "en", "ja")
  language_confidence?: number;  // 0-1 confidence score
}

export interface DeepgramAlternative {
  transcript: string;      // Full transcript text
  confidence: number;      // 0-1 overall confidence
  words: DeepgramWord[];   // Word-level details with timing
}

export interface DeepgramWord {
  word: string;                  // The word as spoken
  start: number;                 // Start time in seconds
  end: number;                   // End time in seconds
  confidence: number;            // 0-1 word confidence
  punctuated_word?: string;      // Word with punctuation (when smart_format=true)
  speaker?: number;              // Speaker ID (when diarize=true)
  speaker_confidence?: number;   // Speaker confidence (when diarize=true)
}

// Deepgram utterance - groups words by natural speech breaks (pauses, breaths)
// Provides data similar to Whisper's segments[]
export interface DeepgramUtterance {
  id?: string;               // Utterance ID
  start: number;             // Start time in seconds
  end: number;               // End time in seconds
  confidence: number;        // 0-1 utterance confidence
  channel: number;           // Audio channel index (usually 0)
  transcript: string;        // Utterance text
  words: DeepgramWord[];     // Words in this utterance
  speaker?: number;          // Speaker ID (when diarize=true)
}

// ============================================================================
// ELEVENLABS API TYPES
// ============================================================================

// Structure returned from ElevenLabs Scribe v2 /speech-to-text endpoint
export interface ElevenLabsResponse {
  text: string;                    // Full transcript text
  language_code: string;           // ISO-639-3 language code (e.g., "eng", "jpn")
  language_probability: number;    // 0-1 confidence score for detected language
  words?: ElevenLabsWord[];        // Word-level details with timing (when timestamps_granularity='word')
}

export interface ElevenLabsWord {
  text: string;                    // The word/token text
  start: number;                   // Start time in seconds
  end: number;                     // End time in seconds
  type: 'word' | 'spacing' | 'audio_event';  // Token type
  speaker_id?: string;             // Speaker identifier (when diarization enabled)
  logprob?: number;                // Log probability (confidence metric)
}

// ============================================================================
// LLM TYPES (GROQ)
// ============================================================================

// Groq API usage statistics
export interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

// Transcription segment (Whisper-compatible format)
// Used for utterance/segment data in transcription responses
// Compatible format used by Deepgram utterances converted to segment format
export interface WhisperSegment {
  id?: number;
  start: number;
  end: number;
  text: string;
  temperature?: number;
  avg_logprob?: number;
  compression_ratio?: number;
  no_speech_prob?: number;
  tokens?: number[];
}
