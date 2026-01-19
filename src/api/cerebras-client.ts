// CEREBRAS API CLIENT MODULE
// Handles API interactions with Cerebras for chat completion (Llama post-processing)
// Default post-processing provider - faster than Groq

import type { Env, GroqUsage } from '../types';
import { Logger } from '../utils/logger';
import { safeReadText, isRecord } from '../utils/utils';
import { computeCerebrasChatCost, isGroqUsage } from '../billing/cost-calculator';
import type { CorrectionRequestPayload } from './groq-client';

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
const CEREBRAS_CHAT_MODEL = 'llama-3.3-70b';

/**
 * Call Cerebras chat completions API for post-processing and return cost + raw payload
 */
export async function requestCerebrasChat(
  env: Env,
  payload: CorrectionRequestPayload,
  logger: Logger,
  requestId: string
): Promise<{ raw: unknown; usage?: GroqUsage; costUsd: number }> {
  const chatUrl = `${CEREBRAS_BASE_URL}/chat/completions`;
  const model = CEREBRAS_CHAT_MODEL;

  const response = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CEREBRAS_API_KEY}`,
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
    logger.log('error', 'Cerebras API returned error - post-processing failed', {
      requestId,
      status: response.status,
      statusText: response.statusText,
      endpoint: chatUrl,
      errorText,
      model: model,
      action: 'Will retry with exponential backoff if attempts remain',
    });
    const error = new Error(`Cerebras chat failed with status ${response.status}`);
    (error as { status?: number; provider?: string }).status = response.status;
    (error as { status?: number; provider?: string }).provider = 'cerebras';
    throw error;
  }

  const json = await response.json();
  const usage = isRecord(json) && isGroqUsage(json['usage']) ? json['usage'] : undefined;
  const costUsd = usage ? computeCerebrasChatCost(usage) : 0;

  return {
    raw: json,
    usage,
    costUsd,
  };
}
