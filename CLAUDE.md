# HyperWhisper Cloud

Cloudflare Worker backend for HyperWhisper transcription service.

## Deployment

Deploy to development:
```bash
npx wrangler deploy --env development
```

Deploy to production:
```bash
npx wrangler deploy --env production
```

## Environments

| Environment | URL | Command |
|-------------|-----|---------|
| Development | `transcribe-dev-v1.hyperwhisper.com` | `--env development` |
| Production | `transcribe-prod-v1.hyperwhisper.com` | `--env production` |

## Secrets Management

List secrets:
```bash
npx wrangler secret list --env development
npx wrangler secret list --env production
```

Set a secret:
```bash
npx wrangler secret put SECRET_NAME --env development
npx wrangler secret put SECRET_NAME --env production
```

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
