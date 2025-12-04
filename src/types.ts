// TYPE DEFINITIONS FOR HYPERWHISPER CLOUDFLARE WORKER
// Centralized TypeScript interfaces for the edge transcription service

export interface Env {
  DEEPGRAM_API_KEY: string; // Deepgram API key for Nova-3 transcription
  GROQ_API_KEY: string; // Groq API key for Llama post-processing
  GROQ_BASE_URL?: string;
  RATE_LIMITER: KVNamespace; // IP-based rate limiting (daily quota)
  DEVICE_CREDITS: KVNamespace; // Device trial credits (1000 credits per device_id)
  LICENSE_CACHE: KVNamespace; // License validation cache (7 days TTL)
  POLAR_ACCESS_TOKEN: string; // Polar.sh API token (required)
  POLAR_ORGANIZATION_ID: string; // Polar.sh organization ID (required)
  POLAR_METER_ID: string; // Polar.sh meter ID for transcription credits
}

// TRANSCRIPTION REQUEST
// Client sends audio data with optional device/license identifier
export interface TranscriptionRequest {
  audio: Uint8Array;          // Raw binary audio data (NOT base64 - saves ~65% memory)
  audioMimeType?: string;     // original MIME type (e.g., "audio/mp4")
  audioFileName?: string;     // original filename with extension
  language?: string;          // ISO language code (e.g., "en", "es")
  mode?: string;              // transcription mode for post-processing
  device_id?: string;         // NEW: Device identifier for trial users
  license_key?: string;       // NEW: License key for licensed users
  post_processing_enabled?: boolean; // Whether the client wants server-side post-processing
  post_processing_prompt?: string;   // Optional system prompt provided by the client
  initial_prompt?: string;    // Optional initial prompt/custom vocabulary for Whisper
}

// WHISPER API RESPONSE
// Structure returned from Cloudflare's Whisper model
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

export interface WhisperResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
  task?: string;
  x_groq?: {
    id?: string;
    processing_time?: number;
  };
}

export interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// USAGE RESPONSE
// Returned by GET /usage endpoint
export interface UsageResponse {
  credits_remaining: number;
  minutes_remaining: number;
  credits_per_minute: number;
  is_licensed: boolean;
  is_trial?: boolean; // True for device_id users (trial credits)
  is_anonymous: boolean; // Should always be false (anonymous users are rejected)
  resets_at?: string;  // ISO date for IP daily quota
  customer_id?: string; // Polar customer ID for licensed users
  device_id?: string; // Device ID for trial users
  total_allocated?: number; // Total credits allocated (trial users only)
  credits_used?: number; // Credits used so far (trial users only)
}

// ERROR RESPONSE
// Standardized error format
export interface ErrorResponse {
  error: string;
  message?: string;
  details?: any;
  credits_remaining?: number; // Include balance in credit-related errors
  minutes_remaining?: number;
  minutes_required?: number;
  credits_per_minute?: number;
}

// DEEPGRAM API RESPONSE TYPES
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
  duration: number; // Audio duration in seconds
  channels: number; // Number of audio channels (usually 1)
  models?: string[];
  model_info?: Record<string, unknown>;
}

export interface DeepgramResults {
  channels: DeepgramChannel[];
  utterances?: DeepgramUtterance[];
}

export interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
  detected_language?: string; // BCP-47 language code (e.g., "en", "ja")
  language_confidence?: number; // 0-1 confidence score
}

export interface DeepgramAlternative {
  transcript: string; // Full transcript text
  confidence: number; // 0-1 overall confidence
  words: DeepgramWord[]; // Word-level details with timing
}

export interface DeepgramWord {
  word: string; // The word as spoken
  start: number; // Start time in seconds
  end: number; // End time in seconds
  confidence: number; // 0-1 word confidence
  punctuated_word?: string; // Word with punctuation (when smart_format=true)
  speaker?: number; // Speaker ID (when diarize=true)
  speaker_confidence?: number; // Speaker confidence (when diarize=true)
}

// DEEPGRAM UTTERANCE
// Groups words by natural speech breaks (pauses, breaths)
// Provides data similar to Whisper's segments[]
export interface DeepgramUtterance {
  start: number; // Start time in seconds
  end: number; // End time in seconds
  confidence: number; // 0-1 utterance confidence
  channel: number; // Audio channel index (usually 0)
  transcript: string; // Utterance text
  words: DeepgramWord[]; // Words in this utterance
  speaker?: number; // Speaker ID (when diarize=true)
  id?: string; // Utterance ID
}
