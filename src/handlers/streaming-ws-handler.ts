// STREAMING WEBSOCKET HANDLER
// Handler for WebSocket /ws/transcribe endpoint - Real-time live transcription
//
// ARCHITECTURE:
// Client streams audio chunks → Worker proxies to Deepgram → Results stream back to client
//
// PROVIDER: Deepgram Nova-3 Live Streaming API ($0.0055/min)
//
// FLOW:
// 1. Client connects with WebSocket upgrade request
// 2. Auth validated from query params (license_key or device_id)
// 3. Worker opens WebSocket to Deepgram Live API
// 4. Client sends binary audio chunks (16kHz mono PCM)
// 5. Deepgram sends interim/final transcript results
// 6. Worker forwards simplified transcript messages to client
// 7. On close, credits are deducted based on total duration
//
// PROTOCOL:
// Client → Server:
//   - Binary frames: Raw PCM audio data (16kHz mono 16-bit)
//   - JSON: {"type":"stop"} to end session gracefully
//
// Server → Client:
//   - {"type":"ready"} - Session started, Deepgram connected
//   - {"type":"transcript", "text":"...", "is_final":true/false, "speech_final":true/false}
//   - {"type":"session_complete", "duration_seconds":X, "credits_used":Y}
//   - {"type":"error", "message":"..."}

import type { Env } from '../types';
import { Logger } from '../utils/logger';
import {
  extractAuthFromQuery,
  validateAuth,
  deductCredits,
  createContext,
} from '../pipeline';
import { calculateCreditsForCost } from '../billing/billing';
import { computeDeepgramTranscriptionCost } from '../billing/cost-calculator';
import { roundToTenth } from '../utils/utils';

// =============================================================================
// TYPES
// =============================================================================

// Message types sent TO the client
interface ReadyMessage {
  type: 'ready';
  sessionId: string;
}

interface TranscriptMessage {
  type: 'transcript';
  text: string;
  is_final: boolean;
  speech_final: boolean;
}

interface SessionCompleteMessage {
  type: 'session_complete';
  duration_seconds: number;
  credits_used: number;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type ServerMessage = ReadyMessage | TranscriptMessage | SessionCompleteMessage | ErrorMessage;

// Deepgram Live API response structure
interface DeepgramLiveResponse {
  type: string;
  channel_index?: number[];
  duration?: number;
  start?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
}

// =============================================================================
// WEBSOCKET HANDLER
// =============================================================================

/**
 * Handle WebSocket upgrade request for /ws/transcribe endpoint.
 * Creates a bidirectional proxy between client and Deepgram Live API.
 */
export async function handleStreamingWebSocket(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const logger = new Logger(requestId);

  // =========================================================================
  // VALIDATE WEBSOCKET UPGRADE
  // =========================================================================

  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    logger.log('warn', 'Non-WebSocket request to WebSocket endpoint', {
      upgrade: upgradeHeader,
    });
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // =========================================================================
  // EXTRACT AND VALIDATE AUTH
  // =========================================================================

  const url = new URL(request.url);
  const licenseKey = url.searchParams.get('license_key');
  const deviceId = url.searchParams.get('device_id');
  const language = url.searchParams.get('language');
  const vocabulary = url.searchParams.get('vocabulary'); // Comma-separated terms

  if (!licenseKey && !deviceId) {
    logger.log('warn', 'Missing authentication in WebSocket request');
    return new Response('Missing license_key or device_id', { status: 401 });
  }

  // Create context for auth validation
  const clientIP = request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown';

  const requestContext = createContext(request, env, ctx, clientIP);
  const authInput = extractAuthFromQuery(requestContext);
  const authResult = await validateAuth(requestContext, authInput);

  if (!authResult.ok) {
    logger.log('warn', 'WebSocket auth validation failed', {
      licenseKey: licenseKey ? '***' : undefined,
      deviceId,
    });
    return new Response('Unauthorized', { status: 401 });
  }

  logger.log('info', 'WebSocket streaming session starting', {
    userType: authResult.value.type,
    language: language || 'auto',
    hasVocabulary: !!vocabulary,
  });

  // =========================================================================
  // CREATE WEBSOCKET PAIR
  // =========================================================================

  const webSocketPair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(webSocketPair);

  // =========================================================================
  // BUILD DEEPGRAM WEBSOCKET URL
  // =========================================================================

  const dgParams = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    interim_results: 'true',
    punctuate: 'true',
    endpointing: '300', // 300ms silence = utterance boundary
    // Audio format parameters - REQUIRED for Deepgram to decode the audio correctly
    // Client sends 16kHz mono PCM (Int16/linear16)
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
  });

  // Language configuration
  if (language && language !== 'auto') {
    dgParams.set('language', language);

    // Vocabulary boosting only works with explicit language (not auto-detect)
    // Nova-3 uses 'keyterm' parameter (not 'keywords')
    if (vocabulary) {
      // Convert comma-separated list to keyterm format with boost values
      const terms = vocabulary.split(',').map(t => t.trim()).filter(Boolean);
      if (terms.length > 0 && terms.length <= 100) {
        // Deepgram keyterm format: term:boost,term:boost
        const keyterms = terms.map(term => `${term}:1.5`).join(',');
        dgParams.set('keyterm', keyterms);
        logger.log('debug', 'Vocabulary boosting enabled', { termCount: terms.length });
      }
    }
  } else {
    dgParams.set('detect_language', 'true');
    if (vocabulary) {
      logger.log('debug', 'Vocabulary ignored - not supported with auto-detect language');
    }
  }

  const dgUrl = `wss://api.deepgram.com/v1/listen?${dgParams.toString()}`;

  // =========================================================================
  // SESSION STATE
  // =========================================================================

  let totalDurationSeconds = 0;
  let deepgramWs: WebSocket | null = null;
  let sessionEnded = false;

  // =========================================================================
  // CONNECT TO DEEPGRAM
  // =========================================================================

  try {
    // Cloudflare Workers use the fetch API for outbound WebSockets
    // Auth via subprotocol: ['token', API_KEY]
    deepgramWs = new WebSocket(dgUrl, ['token', env.DEEPGRAM_API_KEY]);

    // Handle Deepgram connection open
    deepgramWs.addEventListener('open', () => {
      logger.log('info', 'Connected to Deepgram Live API');
      sendToClient(serverSocket, {
        type: 'ready',
        sessionId: requestId,
      });
    });

    // Handle messages from Deepgram
    deepgramWs.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string) as DeepgramLiveResponse;

        if (data.type === 'Results') {
          // Accumulate duration from each result
          if (data.duration) {
            totalDurationSeconds += data.duration;
          }

          // Extract transcript text
          const transcript = data.channel?.alternatives?.[0]?.transcript || '';

          // Only send non-empty transcripts or final results
          if (transcript || data.is_final) {
            sendToClient(serverSocket, {
              type: 'transcript',
              text: transcript,
              is_final: data.is_final ?? false,
              speech_final: data.speech_final ?? false,
            });
          }
        }
      } catch (parseError) {
        logger.log('warn', 'Failed to parse Deepgram message', {
          error: String(parseError),
        });
      }
    });

    // Handle Deepgram errors
    deepgramWs.addEventListener('error', (event) => {
      logger.log('error', 'Deepgram WebSocket error', {
        error: String(event),
      });
      sendToClient(serverSocket, {
        type: 'error',
        message: 'Transcription service error',
      });
    });

    // Handle Deepgram close
    deepgramWs.addEventListener('close', async () => {
      logger.log('info', 'Deepgram connection closed', {
        totalDuration: totalDurationSeconds,
      });

      if (!sessionEnded) {
        await endSession();
      }

      // Close client connection if still open
      if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.close(1000, 'Session ended');
      }
    });

  } catch (error) {
    logger.log('error', 'Failed to connect to Deepgram', {
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response('Failed to establish transcription connection', { status: 502 });
  }

  // =========================================================================
  // CLIENT MESSAGE HANDLERS
  // =========================================================================

  // Forward audio from client to Deepgram
  serverSocket.addEventListener('message', (event) => {
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      // Binary audio data - forward directly
      if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
        deepgramWs.send(event.data);
      } else if (typeof event.data === 'string') {
        // Handle control messages
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'stop') {
            logger.log('info', 'Client requested session stop');
            // Send close message to Deepgram to finalize
            deepgramWs.close(1000, 'Client requested stop');
          }
        } catch {
          // If not JSON, might be text data - ignore
          logger.log('debug', 'Received non-JSON text message from client');
        }
      }
    }
  });

  // Handle client disconnect
  serverSocket.addEventListener('close', async () => {
    logger.log('info', 'Client WebSocket closed');

    if (!sessionEnded) {
      await endSession();
    }

    // Close Deepgram connection if still open
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close(1000, 'Client disconnected');
    }
  });

  // Handle client errors
  serverSocket.addEventListener('error', (event) => {
    logger.log('error', 'Client WebSocket error', {
      error: String(event),
    });
  });

  // =========================================================================
  // SESSION END HANDLER
  // =========================================================================

  /**
   * End the streaming session and deduct credits.
   * Called when either side closes the connection.
   */
  async function endSession(): Promise<void> {
    if (sessionEnded) return;
    sessionEnded = true;

    // Calculate credits based on total audio duration
    const costUsd = computeDeepgramTranscriptionCost(totalDurationSeconds);
    const creditsUsed = roundToTenth(calculateCreditsForCost(costUsd));

    logger.log('info', 'Streaming session ended - calculating credits', {
      totalDuration: totalDurationSeconds,
      costUsd,
      creditsUsed,
    });

    // Send session complete message to client before closing
    if (serverSocket.readyState === WebSocket.OPEN) {
      sendToClient(serverSocket, {
        type: 'session_complete',
        duration_seconds: totalDurationSeconds,
        credits_used: creditsUsed,
      });
    }

    // Deduct credits in background (non-blocking)
    ctx.waitUntil(
      deductCredits(requestContext, authResult.value, creditsUsed, {
        audio_duration_seconds: totalDurationSeconds,
        transcription_cost_usd: costUsd,
        language: language || 'auto',
        endpoint: '/ws/transcribe',
        streaming: true,
        stt_provider: 'deepgram-nova3-live',
      }).catch(err => {
        logger.log('error', 'Failed to deduct credits', {
          error: String(err),
        });
      })
    );
  }

  // =========================================================================
  // ACCEPT THE WEBSOCKET CONNECTION
  // =========================================================================

  serverSocket.accept();

  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Send a JSON message to the client WebSocket.
 */
function sendToClient(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
