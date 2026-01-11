// GROQ API CLIENT MODULE
// Handles API interactions with Groq for chat completion (Llama post-processing)
//
// NOTE: Transcription is handled by Deepgram Nova-3 (see deepgram-client.ts)

import type { Env, GroqUsage } from '../types';
import { Logger } from '../utils/logger';
import { safeReadText, isRecord } from '../utils/utils';
import { computeGroqChatCost, isGroqUsage } from '../billing/cost-calculator';

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_CHAT_MODEL = 'llama-3.3-70b-versatile';

// Chat message types
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

export type CorrectionRequestPayload = {
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
};

/**
 * Call Groq's chat completions API for post-processing and return cost + raw payload
 */
export async function requestGroqChat(
  env: Env,
  payload: CorrectionRequestPayload,
  logger: Logger,
  requestId: string
): Promise<{ raw: unknown; usage?: GroqUsage; costUsd: number }> {
  const baseUrl = getGroqBaseUrl(env);
  const chatUrl = `${baseUrl}/chat/completions`;
  const model = GROQ_CHAT_MODEL;

  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      ...payload,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    logger.log('error', 'Groq API returned error - post-processing failed', {
      requestId,
      status: response.status,
      statusText: response.statusText,
      endpoint: chatUrl,
      errorText,
      model: model,
      action: 'Will retry with exponential backoff if attempts remain',
    });
    throw new Error(`Groq chat failed with status ${response.status}`);
  }

  const json = await response.json();
  const usage = isRecord(json) && isGroqUsage(json['usage']) ? json['usage'] : undefined;
  const costUsd = usage ? computeGroqChatCost(usage) : 0;

  return {
    raw: json,
    usage,
    costUsd,
  };
}

/**
 * Assemble the chat-completions payload used for post-processing
 */
export function buildCorrectionRequest(systemPrompt: string, userContent: string): CorrectionRequestPayload {
  return {
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userContent,
      }
    ],
    temperature: 0,
    max_tokens: 32768,
  };
}

/**
 * Resolve the Groq base URL, defaulting to the public API endpoint
 */
function getGroqBaseUrl(env: Env): string {
  const candidate = env.GROQ_BASE_URL?.trim();
  if (candidate && candidate.length > 0) {
    return candidate.replace(/\/+$/, '');
  }

  return DEFAULT_GROQ_BASE_URL;
}
