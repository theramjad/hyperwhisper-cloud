// HYPERWHISPER CLOUDFLARE WORKER
// Edge-based transcription service using Deepgram Nova-3 for STT and Groq Llama for post-processing
// Now with Polar-based billing for licensed users and IP rate limiting for anonymous users
//
// ARCHITECTURE:
// Audio → Deepgram Nova-3 (STT) → Groq Llama 3.3 70B (post-processing) → Response
//
// PROVIDERS:
// - STT: Deepgram Nova-3 ($0.0043/min, 100 concurrent requests, 2GB max file)
// - Post-processing: Groq Llama 3.3 70B ($0.59/1M prompt, $0.79/1M completion)
//
// ENDPOINTS:
// - POST /transcribe - Streaming audio transcription (recommended for new clients)
// - POST /post-process - Standalone text correction
// - POST / - Legacy multipart transcription (backwards compatible)
// - GET /usage - Query usage/balance

import type { Env } from './types';

// Utils
import { Logger } from './utils/logger';

// Middleware
import {
  getCORSHeaders,
  handleCORS,
  handleUsageQuery,
} from './middleware/handlers';

// Handlers
import { handleStreamingTranscription } from './handlers/streaming-handler';
import { handlePostProcess } from './handlers/post-process-handler';
import { handleLegacyTranscription } from './handlers/legacy-handler';

// Cloudflare Worker entry point
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const logger = new Logger(requestId);

    // Get client IP
    const clientIP = request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For') ||
      'unknown';

    // Parse URL to determine route
    const url = new URL(request.url);

    logger.log('info', 'Incoming request to HyperWhisper Cloud API', {
      method: request.method,
      path: url.pathname,
      ip: clientIP,
      userAgent: request.headers.get('user-agent'),
    });

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // ROUTE: GET /usage - Query usage/balance
    if (request.method === 'GET' && url.pathname === '/usage') {
      return handleUsageQuery(url, env, logger, clientIP);
    }

    // ========================================================================
    // NEW STREAMING ENDPOINTS
    // These endpoints use zero-buffer streaming to handle large audio files
    // without hitting Cloudflare Worker memory limits (128MB)
    // ========================================================================

    // ROUTE: POST /transcribe - Streaming audio transcription
    // Pipes raw binary audio directly to Deepgram without buffering
    // Query params: license_key OR device_id, language, mode, initial_prompt
    // Headers: Content-Type: audio/*, Content-Length: required
    if (request.method === 'POST' && url.pathname === '/transcribe') {
      return handleStreamingTranscription(request, env, ctx, logger, clientIP);
    }

    // ROUTE: POST /post-process - Standalone text correction
    // Applies Groq Llama post-processing to any text (not tied to /transcribe)
    // Body: { text: string, prompt: string, license_key OR device_id }
    if (request.method === 'POST' && url.pathname === '/post-process') {
      return handlePostProcess(request, env, ctx, logger, clientIP);
    }

    // ========================================================================
    // LEGACY ENDPOINT (backwards compatible for versions earlier than v2.12.0 inclusive)
    // ========================================================================

    // ROUTE: POST / - Legacy multipart transcription (buffered)
    // Kept for backwards compatibility with older client versions
    // See handlers/legacy-handler.ts for implementation details
    if (request.method === 'POST' && url.pathname === '/') {
      return handleLegacyTranscription(request, env, ctx, logger, clientIP);
    }

    // Fallback: Method not allowed for unmatched routes
    logger.log('warn', 'Request to unknown route - returning 405 Method Not Allowed', {
      method: request.method,
      path: url.pathname,
      hint: 'Valid routes: POST /transcribe, POST /post-process, GET /usage',
    });
    return new Response('Method not allowed', {
      status: 405,
      headers: getCORSHeaders()
    });
  }
} satisfies ExportedHandler<Env>;
