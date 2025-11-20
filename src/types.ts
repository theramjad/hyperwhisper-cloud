// TYPE DEFINITIONS FOR HYPERWHISPER CLOUDFLARE WORKER
// Centralized TypeScript interfaces for the edge transcription service

export interface Env {
  GROQ_API_KEY: string;
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
  audio: string;              // base64 encoded audio
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
