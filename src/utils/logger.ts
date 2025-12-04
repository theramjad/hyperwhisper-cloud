// LOGGER MODULE
// Structured logging for Cloudflare Workers with automatic sensitive data filtering

/**
 * Structured logger that excludes sensitive data from log payloads
 * Automatically removes audio, text, and transcription data to prevent leaking PII
 */
export class Logger {
  private requestId: string;
  private startTime: number;

  constructor(requestId: string) {
    this.requestId = requestId;
    this.startTime = Date.now();
  }

  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, any>) {
    const logEntry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      level,
      message,
      duration: Date.now() - this.startTime,
      ...data
    };

    // Remove sensitive fields to prevent PII leaks
    delete logEntry.audio;
    delete logEntry.text;
    delete logEntry.transcription;
    delete logEntry.corrected;

    console.log(JSON.stringify(logEntry));
  }
}
