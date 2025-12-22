// REQUEST CONTEXT
// Shared context object that flows through the request pipeline.
// Contains all request data, environment, and accumulated state.

import type { Env } from '../types';
import { Logger } from '../utils/logger';

/**
 * User authentication result from the auth middleware.
 * Either licensed (with license_key) or trial (with device_id).
 */
export interface AuthenticatedUser {
  type: 'licensed' | 'trial';
  licenseKey?: string;
  deviceId?: string;
  credits: number; // Current balance
}

/**
 * Request context that flows through the pipeline.
 * Created once at the start and passed to each middleware.
 */
export interface RequestContext {
  // Request identifiers
  requestId: string;
  clientIP: string;

  // Original request
  request: Request;
  url: URL;

  // Environment
  env: Env;
  ctx: ExecutionContext;

  // Logger (scoped to this request)
  logger: Logger;

  // Accumulated state (set by middleware)
  auth?: AuthenticatedUser;
  estimatedCredits?: number;
}

/**
 * Create a new request context.
 * Call this at the start of each request handler.
 */
export function createContext(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  clientIP: string
): RequestContext {
  const requestId = crypto.randomUUID();
  const logger = new Logger(requestId);

  return {
    requestId,
    clientIP,
    request,
    url: new URL(request.url),
    env,
    ctx,
    logger,
  };
}
