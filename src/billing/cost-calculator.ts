// COST CALCULATION MODULE
// Handles pricing calculations for STT providers and LLM post-processing
//
// PRICING SUMMARY:
// - ElevenLabs Scribe v2 (STT): $0.00983/minute
// - Deepgram Nova-3 (STT): $0.0055/minute ($0.0043 base + $0.0012 features)
// - Cerebras Llama 3.3 70B (post-processing, default): $0.85/1M input, $1.20/1M output
// - Groq Llama 3.3 70B (post-processing): $0.59/1M prompt tokens, $0.79/1M completion tokens

import type { GroqUsage } from '../types';
import { isRecord, roundUpToTenth } from '../utils/utils';

// ElevenLabs Scribe v2 Pricing (USD)
// Source: https://elevenlabs.io/pricing
const ELEVENLABS_COST_PER_AUDIO_MINUTE = 0.00983; // $0.00983/minute for Scribe v2

// Deepgram Nova-3 Pricing (USD)
// Source: https://deepgram.com/pricing (batch/pre-recorded rate)
// Base: $0.0043/min + Features (smart_format, utterances, etc.): $0.0012/min
const DEEPGRAM_COST_PER_AUDIO_MINUTE = 0.0055; // $0.0055/minute total

// Cerebras Llama Pricing (USD) - default post-processing provider
const CEREBRAS_PROMPT_COST_PER_TOKEN = 0.85 / 1_000_000; // $0.85 per 1M input tokens
const CEREBRAS_COMPLETION_COST_PER_TOKEN = 1.20 / 1_000_000; // $1.20 per 1M output tokens

// Groq Llama Pricing (USD) - alternative post-processing provider
const GROQ_PROMPT_COST_PER_TOKEN = 0.59 / 1_000_000; // $0.59 per 1M prompt tokens
const GROQ_COMPLETION_COST_PER_TOKEN = 0.79 / 1_000_000; // $0.79 per 1M completion tokens

// CREDIT MODEL: 1 credit = $0.001 USD
const USD_PER_CREDIT = 0.001;

/**
 * ELEVENLABS TRANSCRIPTION COST
 * Convert audio duration to USD using ElevenLabs Scribe v2 pricing
 *
 * Rate: $0.00983 per minute
 *
 * @param durationSeconds - Audio duration in seconds
 * @returns Cost in USD (micro-dollar precision)
 */
export function computeElevenLabsTranscriptionCost(durationSeconds: number): number {
  const durationMinutes = durationSeconds / 60;
  const raw = durationMinutes * ELEVENLABS_COST_PER_AUDIO_MINUTE;
  return roundUsd(raw);
}

/**
 * DEEPGRAM TRANSCRIPTION COST
 * Convert audio duration to USD using Deepgram Nova-3 batch pricing
 *
 * Deepgram bills per second of audio (no minimum billable duration)
 * Rate: $0.0055 per minute ($0.0043 base + $0.0012 features)
 * Features: smart_format, utterances, language detection
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
 * Convert Cerebras chat usage to USD using published per-token pricing
 */
export function computeCerebrasChatCost(usage: GroqUsage): number {
  const promptCost = usage.prompt_tokens * CEREBRAS_PROMPT_COST_PER_TOKEN;
  const completionCost = usage.completion_tokens * CEREBRAS_COMPLETION_COST_PER_TOKEN;
  return roundUsd(promptCost + completionCost);
}

/**
 * Convert Groq chat usage to USD using published per-token pricing
 */
export function computeGroqChatCost(usage: GroqUsage): number {
  const promptCost = usage.prompt_tokens * GROQ_PROMPT_COST_PER_TOKEN;
  const completionCost = usage.completion_tokens * GROQ_COMPLETION_COST_PER_TOKEN;
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
