// AUTH MIDDLEWARE
// Validates user authentication: either license key or device ID.
// Sets ctx.auth with the authenticated user info.

import type { RequestContext, AuthenticatedUser } from './context';
import {
  type PipelineResult,
  ok,
  fail,
  noIdentifierResponse,
  invalidLicenseResponse,
} from './response';
import { validateAndGetCredits } from '../billing/billing';
import { getDeviceBalance } from '../billing/device-credits';

/**
 * Input for authentication: either from query params or form data.
 */
export interface AuthInput {
  licenseKey?: string;
  deviceId?: string;
}

/**
 * Extract auth credentials from query parameters.
 */
export function extractAuthFromQuery(ctx: RequestContext): AuthInput {
  return {
    licenseKey: ctx.url.searchParams.get('license_key') || undefined,
    deviceId: ctx.url.searchParams.get('device_id') || undefined,
  };
}

/**
 * Extract auth credentials from form data.
 */
export function extractAuthFromForm(formData: FormData): AuthInput {
  return {
    licenseKey: (formData.get('license_key') as string) || undefined,
    deviceId: (formData.get('device_id') as string) || undefined,
  };
}

/**
 * Validate authentication and set ctx.auth.
 *
 * For licensed users: Validates license key with the API, gets credit balance.
 * For trial users: Gets device credit balance from KV.
 *
 * Returns failure if no identifier provided or license is invalid.
 */
export async function validateAuth(
  ctx: RequestContext,
  input: AuthInput
): Promise<PipelineResult<AuthenticatedUser>> {
  const { licenseKey, deviceId } = input;

  // Require at least one identifier
  if (!licenseKey && !deviceId) {
    ctx.logger.log('warn', 'Authentication failed - no license_key or device_id provided in request', {
      hint: 'Request must include either license_key or device_id parameter',
    });
    return fail(noIdentifierResponse());
  }

  // LICENSED USER: Validate with Next.js API
  if (licenseKey) {
    ctx.logger.log('info', 'Identifier resolved as license key - validating via Next.js API', {
      identifier: licenseKey,
    });

    const validation = await validateAndGetCredits(
      ctx.env.LICENSE_CACHE,
      licenseKey,
      ctx.env.HYPERWHISPER_API_URL,
      ctx.logger
    );

    if (!validation.isValid) {
      ctx.logger.log('warn', 'License key validation failed - key is invalid or revoked', {
        action: 'Request will be rejected with 401 Unauthorized',
      });
      return fail(invalidLicenseResponse());
    }

    const user: AuthenticatedUser = {
      type: 'licensed',
      licenseKey,
      credits: validation.credits,
    };

    ctx.auth = user;
    ctx.logger.log('info', 'Licensed user authenticated successfully - request will proceed', {
      credits: user.credits,
      source: validation.credits ? 'Supabase database' : 'default',
    });
    return ok(user);
  }

  // TRIAL USER: Get device balance from KV
  ctx.logger.log('info', 'Identifier resolved as device ID - trial user authentication', {
    deviceId: deviceId!,
  });

  const deviceBalance = await getDeviceBalance(ctx.env.DEVICE_CREDITS, deviceId!, ctx.logger);

  const user: AuthenticatedUser = {
    type: 'trial',
    deviceId,
    credits: deviceBalance.creditsRemaining,
  };

  ctx.auth = user;
  ctx.logger.log('info', 'Trial user authenticated successfully - device credits loaded from KV', {
    credits: user.credits,
    totalAllocated: deviceBalance.totalAllocated,
    remaining: `${user.credits}/${deviceBalance.totalAllocated}`,
  });

  return ok(user);
}
