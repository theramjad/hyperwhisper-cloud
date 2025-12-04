# HyperWhisper Cloud Streaming Optimization Plan

## Background

HyperWhisper Cloud is a Cloudflare Worker that receives audio files from the macOS app, forwards them to Deepgram for transcription, optionally post-processes with Groq LLM, and returns the result.

### The Problem

A user tried to transcribe a 9-minute audio file (~17MB). The Cloudflare Worker crashed with:
```
"outcome": "exceededMemory"
"content-length": "17690104"
```

Cloudflare Workers have a **hard 128MB memory limit** (cannot be increased, even on paid plans).

### Root Cause Analysis

The original code created multiple copies of the audio in memory:

```
1. request.formData()           → ~17MB (parse multipart)
2. audioFile.arrayBuffer()      → ~17MB (buffer)
3. base64 encoding loop         → ~17MB (intermediate string)
4. btoa(binary)                 → ~23MB (base64 is 33% larger)
5. base64ToUint8Array() decode  → ~17MB (in deepgram-client.ts)

Total peak memory: ~74MB for a 17MB file
```

### Solution: Two-Phase Fix

**Phase 1 (COMPLETED):** Remove unnecessary base64 encoding
- Changed `TranscriptionRequest.audio` from `string` to `Uint8Array`
- Pass raw binary through instead of encoding/decoding base64
- Result: ~34MB memory for 17MB file (handles up to ~50MB files)

**Phase 2 (THIS PLAN):** Add streaming endpoint
- New `/stream` endpoint accepts raw binary body (not multipart)
- Metadata passed via URL query parameters
- Worker pipes `request.body` directly to Deepgram without buffering
- Result: ~0MB memory regardless of file size

---

## How Streaming Works

### Current Flow (Buffered)
```
Client ──[multipart form-data]──► Worker [buffer entire file] ──► Deepgram
                                        ↑
                                   Memory: 34MB for 17MB file
```

### New Streaming Flow
```
Client ──[raw binary]──► Worker ──[pipe through]──► Deepgram
                              ↑
                         Memory: ~0MB (data flows through, never pools)
```

### Why This Works

In Cloudflare Workers:
- `request.headers` - Available immediately, no memory cost
- `request.body` - A `ReadableStream`, NOT loaded into memory until consumed
- `await request.arrayBuffer()` - LOADS entire body into memory (bad)
- `fetch(url, { body: request.body })` - PIPES stream through (good)

We can read `Content-Length` header and validate credits BEFORE touching the body:

```typescript
// These are FREE (no memory):
const contentLength = request.headers.get('content-length');
const licenseKey = url.searchParams.get('license_key');

// Validate user, check credits...

// Only when authorized - stream directly (body never buffered):
return fetch(deepgramUrl, { body: request.body });
```

---

## API Design

### Endpoints After Implementation

```
POST /        → Existing multipart endpoint (unchanged, backwards compatible)
POST /stream  → New streaming endpoint (raw binary)
GET  /usage   → Existing usage endpoint (unchanged)
```

### `/stream` Request Format

```http
POST /stream?license_key=xxx&language=en&mode=yyy&initial_prompt=term1,term2
Content-Type: audio/mp4
Content-Length: 17690104

[raw audio bytes - no multipart wrapper]
```

### Query Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `license_key` | One of these required | License key for paid users |
| `device_id` | | Device ID for trial users |
| `language` | No | ISO code or "auto" (default: auto) |
| `mode` | No | Transcription mode ID |
| `initial_prompt` | No | Comma-separated vocabulary terms |
| `post_processing_enabled` | No | "true" or "false" (default: true) |
| `post_processing_prompt` | No | URL-encoded system prompt for cleanup |

### Response Format

Same as existing `/` endpoint - JSON with `original`, `corrected`, `metadata`, `costs`.

---

## Implementation Details

### Files to Create

**`src/streaming-handler.ts`** - New streaming request handler
- Parse query params for metadata
- Read `Content-Length` for credit estimation (before touching body)
- Validate license/device credits
- Call new streaming Deepgram function
- Handle post-processing (requires buffering transcription result, not audio)
- Track usage/billing

### Files to Modify

**`src/index.ts`** - Add route
```typescript
// After line ~79 (usage route), before POST / handler
if (request.method === 'POST' && url.pathname === '/stream') {
  return handleStreamingTranscribe(request, env, ctx, logger, clientIP);
}
```

**`src/deepgram-client.ts`** - Add streaming function
```typescript
export async function transcribeWithDeepgramStream(
  audioStream: ReadableStream,
  contentLength: number,
  mimeType: string,
  language: string | undefined,
  initialPrompt: string | undefined,
  env: Env,
  logger: Logger
): Promise<TranscriptionResult>
```

**`app/macos/hyperwhisper/Managers/Transcription/Providers/HyperWhisperCloudProvider.swift`**
- Change from multipart form-data to raw binary
- Send metadata via query parameters instead of form fields
- Use `/stream` endpoint instead of `/`

---

## Memory Comparison

| Approach | 17MB File | 50MB File | 100MB File |
|----------|-----------|-----------|------------|
| Original (base64) | ~74MB | OOM | OOM |
| Phase 1 (no base64) | ~34MB | ~100MB | OOM |
| Phase 2 (streaming) | ~0MB | ~0MB | ~0MB |

---

## Implementation Checklist

- [x] Phase 1: Remove base64 encoding (DONE)
  - [x] `src/types.ts` - Change `audio: string` to `audio: Uint8Array`
  - [x] `src/index.ts` - Remove base64 encoding loop
  - [x] `src/deepgram-client.ts` - Remove base64 decoding

- [ ] Phase 2: Add streaming endpoint
  - [ ] Create `src/streaming-handler.ts`
  - [ ] Add `/stream` route in `src/index.ts`
  - [ ] Add `transcribeWithDeepgramStream()` in `src/deepgram-client.ts`
  - [ ] Deploy backend to dev and test
  - [ ] Update `HyperWhisperCloudProvider.swift` to use `/stream`
  - [ ] Test end-to-end with large files
  - [ ] Deploy to production

---

## Backwards Compatibility

- Existing `POST /` endpoint remains unchanged
- Old app versions continue to work with multipart format
- New `/stream` endpoint only used by updated clients
- Can deprecate `/` later once all clients updated

---

## References

- Cloudflare Workers memory limit: 128MB (hard limit, all plans)
- Deepgram accepts raw binary with `Content-Type: audio/*`
- Existing multipart handler: `src/index.ts:118-228`
- Existing Deepgram client: `src/deepgram-client.ts:329-461`
