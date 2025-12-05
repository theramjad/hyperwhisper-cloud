// UTILITY FUNCTIONS
// General-purpose helpers for type guards, parsing, and retry operations

/**
 * Type guard for plain object values
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse string/boolean inputs into a boolean, otherwise undefined
 */
export function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return undefined;
}

/**
 * Safely read the body text from a Response without throwing
 */
export function safeReadText(response: Response): Promise<string | undefined> {
  return response.text().catch(() => undefined);
}

/**
 * Round a numeric value to the nearest tenth, guarding against NaN/Infinity.
 */
export function roundToTenth(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const rounded = Math.round((value + Number.EPSILON) * 10) / 10;
  return Math.abs(rounded) < Number.EPSILON ? 0 : rounded;
}

/**
 * Round a numeric value up to the next tenth, ensuring non-negative output.
 */
export function roundUpToTenth(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const rounded = Math.ceil((value - Number.EPSILON) * 10) / 10;
  return rounded <= 0 ? 0 : rounded;
}

/**
 * Retry configuration options
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds (default: 1000ms) */
  initialDelayMs?: number;
  /** Backoff multiplier for exponential delay (default: 2) */
  backoffMultiplier?: number;
  /** Optional callback invoked before each retry attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Retry an async operation with exponential backoff
 *
 * This utility automatically retries failed async operations with increasing delays between attempts.
 *
 * HOW IT WORKS:
 * 1. Executes the provided async function
 * 2. If it succeeds, returns the result immediately
 * 3. If it fails and retries remain:
 *    - Calculates delay: initialDelayMs * (backoffMultiplier ^ attemptNumber)
 *    - Calls onRetry callback if provided (for logging)
 *    - Waits for the calculated delay
 *    - Retries the operation
 * 4. If all retries are exhausted, throws the last error
 *
 * EXAMPLE RETRY SCHEDULE (maxRetries=3, initialDelay=1000ms, backoff=2):
 * - Attempt 1: Immediate execution (no delay)
 * - Attempt 2: Wait 1000ms (1s), then retry
 * - Attempt 3: Wait 2000ms (2s), then retry
 * - Attempt 4: Wait 4000ms (4s), then retry
 * - Total: 4 attempts over ~7 seconds
 *
 * USE CASES:
 * - Transient network failures (connection timeouts, DNS resolution)
 * - API rate limiting (429 errors)
 * - Temporary service unavailability (503 errors)
 * - Cloud provider cold starts
 *
 * @param fn - The async function to execute with retries
 * @param options - Retry configuration (maxRetries, delays, callbacks)
 * @returns Promise that resolves with the function result or rejects with the last error
 *
 * @example
 * const result = await retryWithBackoff(
 *   () => fetch('https://api.example.com/data'),
 *   {
 *     maxRetries: 3,
 *     initialDelayMs: 1000,
 *     onRetry: (attempt, error, delayMs) => {
 *       console.log(`Retry ${attempt} after ${delayMs}ms: ${error.message}`);
 *     }
 *   }
 * );
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 1000,
    backoffMultiplier = 2,
    onRetry
  } = options;

  let lastError: Error;

  // Attempt the operation up to (maxRetries + 1) times
  // Example: maxRetries=3 means 4 total attempts (initial + 3 retries)
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute the operation
      const result = await fn();
      return result;
    } catch (error) {
      // Capture the error for potential re-throw
      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate exponential backoff delay
      // Example: attempt=0 → 1000ms, attempt=1 → 2000ms, attempt=2 → 4000ms
      const delayMs = initialDelayMs * Math.pow(backoffMultiplier, attempt);

      // Invoke retry callback for logging/monitoring
      if (onRetry) {
        onRetry(attempt + 1, lastError, delayMs);
      }

      // Wait before the next attempt
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // TypeScript requires this for exhaustiveness checking, but it's unreachable
  // because the loop either returns or throws
  throw lastError!;
}
