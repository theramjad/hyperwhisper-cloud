// RESPONSE HELPERS
// Standardized JSON responses for the pipeline.
// Centralizes CORS headers and error formatting.

import { CREDITS_PER_MINUTE } from '../constants/credits';

/**
 * CORS headers included in all responses.
 */
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/**
 * Pipeline result: either success (continue) or error (stop and return response).
 */
export type PipelineResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; response: Response };

/**
 * Create a success result to continue the pipeline.
 */
export function ok<T>(value: T): PipelineResult<T> {
  return { ok: true, value };
}

/**
 * Create a failure result that stops the pipeline.
 */
export function fail(response: Response): PipelineResult<never> {
  return { ok: false, response };
}

/**
 * Create a JSON error response.
 */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return new Response(
    JSON.stringify({ error, message, ...extra }),
    {
      status,
      headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
    }
  );
}

/**
 * Create a JSON success response.
 */
export function jsonResponse<T>(data: T, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json', ...headers },
  });
}

/**
 * Handle OPTIONS preflight requests.
 */
export function corsPreflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ============================================================================
// COMMON ERROR RESPONSES
// ============================================================================

export function ipBlockedResponse(): Response {
  return errorResponse(403, 'Access denied', 'Your IP has been temporarily blocked due to abuse');
}

export function noIdentifierResponse(): Response {
  return errorResponse(401, 'Identifier required', 'You must provide either a license_key or device_id');
}

export function invalidLicenseResponse(): Response {
  return errorResponse(401, 'Invalid license', 'The provided license key is invalid or expired');
}

export function insufficientCreditsResponse(
  balance: number,
  estimated: number
): Response {
  const minutesRemaining = Math.floor(balance / CREDITS_PER_MINUTE);
  const minutesRequired = Math.ceil(estimated / CREDITS_PER_MINUTE);

  return errorResponse(402, 'Insufficient credits',
    `You have ${balance.toFixed(1)} credits remaining. This transcription requires approximately ${estimated.toFixed(1)} credits.`,
    {
      credits_remaining: balance,
      minutes_remaining: minutesRemaining,
      minutes_required: minutesRequired,
      credits_per_minute: CREDITS_PER_MINUTE,
    }
  );
}

export function deviceCreditsExhaustedResponse(
  balance: number,
  totalAllocated: number
): Response {
  return errorResponse(402, 'Trial credits exhausted',
    `Your device trial credits are exhausted. You have ${balance.toFixed(1)} of ${totalAllocated} credits remaining.`,
    {
      credits_remaining: balance,
      total_allocated: totalAllocated,
      credits_per_minute: CREDITS_PER_MINUTE,
    }
  );
}

export function ipRateLimitResponse(resetsAt: Date): Response {
  return errorResponse(429, 'Rate limit exceeded',
    'Daily IP rate limit exceeded. Try again tomorrow or use a license key for unlimited access.',
    { resets_at: resetsAt.toISOString() }
  );
}

export function invalidContentTypeResponse(expected: string, received: string): Response {
  return errorResponse(400, 'Invalid Content-Type',
    `Content-Type must be ${expected}`,
    { received }
  );
}

export function missingContentLengthResponse(): Response {
  return errorResponse(400, 'Missing Content-Length',
    'Content-Length header is required for streaming transcription'
  );
}

export function fileTooLargeResponse(actualBytes: number, maxBytes: number): Response {
  const actualMB = actualBytes / (1024 * 1024);
  const maxMB = maxBytes / (1024 * 1024);

  return errorResponse(413, 'File too large',
    `Audio file must be ${maxMB.toFixed(0)} MB or smaller. Your file is ${actualMB.toFixed(2)} MB.`,
    {
      max_size_mb: Math.round(maxMB),
      actual_size_mb: parseFloat(actualMB.toFixed(2)),
    }
  );
}
