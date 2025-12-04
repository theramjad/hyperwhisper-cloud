// TEXT PROCESSING MODULE
// Functions for extracting and processing transcription text from various API response formats

import { isRecord } from './utils';

/**
 * Robustly extract the transcription text from Groq's Whisper response structure
 */
export function extractTranscriptionText(response: unknown): { text: string; source: string } | undefined {
  if (typeof response === 'string') {
    const trimmed = response.trim();
    return trimmed.length > 0 ? { text: trimmed, source: 'string' } : undefined;
  }

  if (!isRecord(response)) {
    return undefined;
  }

  const directText = response['text'];
  if (typeof directText === 'string' && directText.trim().length > 0) {
    return { text: directText.trim(), source: 'text' };
  }

  const resultText = response['result'];
  if (typeof resultText === 'string' && resultText.trim().length > 0) {
    return { text: resultText.trim(), source: 'result' };
  }

  const outputText = response['output_text'];
  if (typeof outputText === 'string' && outputText.trim().length > 0) {
    return { text: outputText.trim(), source: 'output_text' };
  }

  const transcriptionField = response['transcription'];
  const nestedTranscription = extractTranscriptionText(transcriptionField);
  if (nestedTranscription) {
    return { text: nestedTranscription.text, source: `transcription.${nestedTranscription.source}` };
  }

  const dataField = response['data'];
  if (Array.isArray(dataField)) {
    for (const item of dataField) {
      const fromItem = extractTranscriptionText(item);
      if (fromItem) {
        return { text: fromItem.text, source: `data.${fromItem.source}` };
      }
    }
  }

  const resultsField = response['results'];
  if (Array.isArray(resultsField)) {
    for (const item of resultsField) {
      const fromItem = extractTranscriptionText(item);
      if (fromItem) {
        return { text: fromItem.text, source: `results.${fromItem.source}` };
      }
    }
  }

  const segments = response['segments'];
  if (Array.isArray(segments)) {
    const parts: string[] = [];
    for (const segment of segments) {
      if (typeof segment === 'string') {
        const trimmed = segment.trim();
        if (trimmed.length > 0) {
          parts.push(trimmed);
        }
        continue;
      }

      if (isRecord(segment) && typeof segment['text'] === 'string') {
        const trimmed = segment['text'].trim();
        if (trimmed.length > 0) {
          parts.push(trimmed);
        }
      }
    }

    if (parts.length > 0) {
      return { text: parts.join(' ').trim(), source: 'segments' };
    }
  }

  const outputField = response['output'];
  if (Array.isArray(outputField)) {
    for (const item of outputField) {
      const fromItem = extractTranscriptionText(item);
      if (fromItem) {
        return { text: fromItem.text, source: `output.${fromItem.source}` };
      }
    }
  }

  return undefined;
}

/**
 * Extract the corrected text from Groq chat responses (handles streaming/non-streaming shapes)
 */
export function tryExtractCorrectionText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const directKeys = ['response', 'result', 'output_text', 'text'] as const;
  for (const key of directKeys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  const responseField = value['response'];
  const nestedResponse = tryExtractCorrectionText(responseField);
  if (nestedResponse) {
    return nestedResponse;
  }

  const choices = value['choices'];
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const choiceText = tryExtractCorrectionText(choice);
      if (choiceText) {
        return choiceText;
      }

      if (!isRecord(choice)) {
        continue;
      }

      const messageText = tryExtractCorrectionText(choice['message']);
      if (messageText) {
        return messageText;
      }

      const deltaText = tryExtractCorrectionText(choice['delta']);
      if (deltaText) {
        return deltaText;
      }
    }
  }

  const output = value['output'];
  const outputText = extractTextFromContent(output);
  if (outputText) {
    return outputText;
  }

  const content = value['content'];
  const contentText = extractTextFromContent(content);
  if (contentText) {
    return contentText;
  }

  return undefined;
}

/**
 * Traverse chat-completion content arrays to find textual payloads
 */
function extractTextFromContent(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  if (isRecord(value)) {
    const direct = value['text'];
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }

    const nested = tryExtractCorrectionText(value['message']);
    if (nested) {
      return nested;
    }

    const nestedContent = extractTextFromContent(value['content']);
    if (nestedContent) {
      return nestedContent;
    }
  }

  if (Array.isArray(value)) {
    const segments: string[] = [];
    for (const item of value) {
      const text = tryExtractCorrectionText(item);
      if (text) {
        segments.push(text);
      }
    }

    if (segments.length) {
      return segments.join('');
    }
  }

  return undefined;
}

/**
 * Extract corrected text and throw if missing
 */
export function extractCorrectedText(response: unknown): string {
  const text = tryExtractCorrectionText(response);
  if (typeof text === 'string' && text.length > 0) {
    return text;
  }

  throw new Error('Correction response missing text');
}

/**
 * Wrap the raw transcript in clear delimiters for the post-processing prompt
 */
export function buildTranscriptUserContent(text: string): string {
  return `--TRANSCRIPT--\n${text}\n--ENDTRANSCRIPT--`;
}

const CLEAN_MARKER_PATTERN = /<<CLEANED>>|<<CLEANED>|<CLEANED>>|<CLEANED>|<<END>>|<<END>|<END>>|<END>/gi;

/**
 * Remove <<CLEANED>> / <<END>> markers left by Groq post-processing prompts
 */
export function stripCleanMarkers(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }

  const withoutMarkers = text.replace(CLEAN_MARKER_PATTERN, '');
  return withoutMarkers.trim();
}
