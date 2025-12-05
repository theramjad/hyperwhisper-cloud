// COST CALCULATION MODULE
// Handles pricing calculations for Deepgram Nova-3 and Groq Llama usage
//
// PRICING SUMMARY:
// - Deepgram Nova-3 (STT): $0.0043/minute ($0.258/hour)
// - Groq Llama 3.3 70B (post-processing): $0.59/1M prompt tokens, $0.79/1M completion tokens

import type { GroqUsage } from '../types';
import { isRecord, roundUpToTenth } from '../utils/utils';

// Deepgram Nova-3 Pricing (USD)
// Source: https://deepgram.com/pricing (batch/pre-recorded rate)
const DEEPGRAM_COST_PER_AUDIO_MINUTE = 0.0043; // $0.0043/minute for Nova-3 batch

// Groq Llama Pricing (USD) - used for post-processing
const LLAMA_PROMPT_COST_PER_TOKEN = 0.59 / 1_000_000; // $0.59 per 1M prompt tokens
const LLAMA_COMPLETION_COST_PER_TOKEN = 0.79 / 1_000_000; // $0.79 per 1M completion tokens

// CREDIT MODEL: 1 credit = $0.001 USD
const USD_PER_CREDIT = 0.001;

/**
 * DEEPGRAM TRANSCRIPTION COST
 * Convert audio duration to USD using Deepgram Nova-3 batch pricing
 *
 * Deepgram bills per second of audio (no minimum billable duration)
 * Rate: $0.0043 per minute = $0.0000717 per second
 *
 * @param durationSeconds - Audio duration in seconds
 * @returns Cost in USD (micro-dollar precision)
 */
export function computeDeepgramTranscriptionCost(durationSeconds: number): number {
  // Deepgram bills per second with no minimum
  const durationMinutes = durationSeconds / 60;
  const raw = durationMinutes * DEEPGRAM_COST_PER_AUDIO_MINUTE;
  return roundUsd(raw);
}

/**
 * Convert Groq chat usage to USD using published per-token pricing
 */
export function computeChatCost(usage: GroqUsage): number {
  const promptCost = usage.prompt_tokens * LLAMA_PROMPT_COST_PER_TOKEN;
  const completionCost = usage.completion_tokens * LLAMA_COMPLETION_COST_PER_TOKEN;
  return roundUsd(promptCost + completionCost);
}

/**
 * Type guard for Groq usage blocks
 */
export function isGroqUsage(value: unknown): value is GroqUsage {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.prompt_tokens === 'number'
    && typeof value.completion_tokens === 'number'
    && typeof value.total_tokens === 'number';
}

/**
 * Convert USD cost to credits
 */
export function usdToCredits(usd: number): number {
  if (usd <= 0) {
    return 0.1;
  }

  if (USD_PER_CREDIT <= 0) {
    return Math.max(0.1, roundUpToTenth(usd * 1000));
  }

  const rawCredits = usd / USD_PER_CREDIT;
  return Math.max(0.1, roundUpToTenth(rawCredits));
}

/**
 * Round USD amounts to micro-dollar precision to avoid floating point jitter
 */
export function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/**
 * Format rounded USD as a fixed six-decimal string for headers/logging
 */
export function formatUsd(value: number): string {
  return roundUsd(value).toFixed(6);
}
