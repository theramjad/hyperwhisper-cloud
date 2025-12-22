// PIPELINE MODULE
// Composable request pipeline for HyperWhisper Cloud.
//
// ARCHITECTURE:
// Each middleware returns PipelineResult<T>:
// - { ok: true, value: T } → continue to next step
// - { ok: false, response: Response } → stop and return response
//
// USAGE:
// ```typescript
// const ctx = createContext(request, env, executionCtx, clientIP);
//
// const ipCheck = await checkIPBlocked(ctx);
// if (!ipCheck.ok) return ipCheck.response;
//
// const auth = await validateAuth(ctx, extractAuthFromQuery(ctx));
// if (!auth.ok) return auth.response;
//
// const credits = await validateCredits(ctx, auth.value, estimatedCredits);
// if (!credits.ok) return credits.response;
//
// // ... do transcription ...
//
// ctx.waitUntil(deductCredits(ctx, auth.value, actualCredits, metadata));
// return jsonResponse(result);
// ```

// Context
export { createContext, type RequestContext, type AuthenticatedUser } from './context';

// Middleware
export { checkIPBlocked } from './ip-guard';
export { validateAuth, extractAuthFromQuery, extractAuthFromForm, type AuthInput } from './auth';
export { validateCredits, deductCredits, estimateCreditsFromSize } from './credits';

// Response helpers
export {
  type PipelineResult,
  ok,
  fail,
  jsonResponse,
  errorResponse,
  corsPreflightResponse,
  CORS_HEADERS,
  // Common error responses
  ipBlockedResponse,
  noIdentifierResponse,
  invalidLicenseResponse,
  insufficientCreditsResponse,
  deviceCreditsExhaustedResponse,
  ipRateLimitResponse,
  invalidContentTypeResponse,
  missingContentLengthResponse,
  fileTooLargeResponse,
} from './response';
