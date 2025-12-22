// IP GUARD MIDDLEWARE
// Checks if the client IP is blocked (abuse prevention).
// This runs first in the pipeline to reject bad actors early.

import type { RequestContext } from './context';
import { type PipelineResult, ok, fail, ipBlockedResponse } from './response';

/**
 * Check if the client IP is blocked.
 * Returns failure response if blocked, success if allowed.
 */
export async function checkIPBlocked(ctx: RequestContext): Promise<PipelineResult> {
  try {
    const blockKey = `ip_blocked:${ctx.clientIP}`;
    const blocked = await ctx.env.RATE_LIMITER.get(blockKey);

    if (blocked === 'true') {
      ctx.logger.log('warn', 'Blocked IP attempted access', { ip: ctx.clientIP });
      return fail(ipBlockedResponse());
    }

    return ok(undefined);
  } catch {
    // On error, allow access (fail open for availability)
    return ok(undefined);
  }
}
