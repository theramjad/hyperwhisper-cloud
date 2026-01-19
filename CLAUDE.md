# HyperWhisper Cloud

Cloudflare Worker backend for HyperWhisper transcription service.

## Deployment

Deploy to development:
```bash
npx wrangler deploy -e development
```

Deploy to production:
```bash
npx wrangler deploy -e production
```

Dry-run (validate without deploying):
```bash
npx wrangler deploy -e development --dry-run
```

## Environments

| Environment | URL | Flag |
|-------------|-----|------|
| Development | `transcribe-dev-v1.hyperwhisper.com` | `-e development` |
| Production | `transcribe-prod-v1.hyperwhisper.com` | `-e production` |

## Required Secrets

These must be set via `wrangler secret put` for each environment:

| Secret | Description | Required |
|--------|-------------|----------|
| `DEEPGRAM_API_KEY` | Deepgram Nova-3 transcription | Yes |
| `GROQ_API_KEY` | Groq Whisper transcription & LLM post-processing | Yes |
| `CEREBRAS_API_KEY` | Cerebras LLM post-processing | Yes |
| `ELEVENLABS_API_KEY` | ElevenLabs Scribe transcription | Yes |
| `R2_ACCOUNT_ID` | Cloudflare account ID for R2 presigned URLs | Yes |
| `R2_ACCESS_KEY_ID` | R2 API token access key | Yes |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret | Yes |

Set a secret:
```bash
npx wrangler secret put DEEPGRAM_API_KEY -e development
npx wrangler secret put DEEPGRAM_API_KEY -e production
```

List secrets:
```bash
npx wrangler secret list -e development
npx wrangler secret list -e production
```

## Environment Variables (wrangler.toml)

These are configured in `wrangler.toml` under `[env.{environment}.vars]`:

| Variable | Description |
|----------|-------------|
| `ENVIRONMENT` | `"development"` or `"production"` |
| `GROQ_BASE_URL` | Groq API endpoint (`https://api.groq.com/openai/v1`) |

## KV Namespaces

Configured in `wrangler.toml` (separate IDs per environment):

| Binding | Purpose |
|---------|---------|
| `RATE_LIMITER` | IP-based rate limiting |
| `DEVICE_CREDITS` | Trial device credit balances |
| `LICENSE_CACHE` | Polar license validation cache |

## R2 Buckets

| Binding | Bucket Name | Purpose |
|---------|-------------|---------|
| `AUDIO_BUCKET` | `hyperwhisper-audio-temp-{dev\|prod}` | Temporary audio storage for large files |

## Viewing Logs

Tail logs in real-time:
```bash
npx wrangler tail --env development
npx wrangler tail --env production
```

Or view logs in Cloudflare Dashboard under Workers & Pages > hyperwhisper-v1-dev/prod > Observability.

## Key Files

- `src/index.ts` - Main router and request handler
- `src/handlers/streaming-ws-handler.ts` - WebSocket streaming transcription
- `src/api/deepgram-client.ts` - Deepgram API client for batch transcription
- `wrangler.toml` - Cloudflare Worker configuration

## Important Notes

- **WebSocket Authentication**: Deepgram WebSocket uses `Sec-WebSocket-Protocol` header authentication. Pass `['token', API_KEY]` as the second argument to the WebSocket constructor, which sets the header `Sec-WebSocket-Protocol: token, API_KEY` during the handshake.
- **Secrets vs Vars**: API keys are stored as secrets (not in wrangler.toml). Environment-specific variables are in `[env.*.vars]` sections.
