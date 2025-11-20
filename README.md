# HyperWhisper Cloud Backend

Open-source, privacy-focused edge transcription service for [HyperWhisper](https://hyperwhisper.com).

## Transparency & Trust

This repository contains the **complete source code** running on our edge servers. We believe in full transparency about what happens with your audio data.

### What We Process
- **Audio files only**: Temporary audio data for transcription
- **No permanent storage**: Audio is deleted immediately after processing
- **No tracking**: We don't track, analyze, or store user behavior
- **Open source**: Every line of code is auditable

### What We Store
- **Credit balances only**: Device trial credits and IP rate limits (anti-abuse)
- **License validation cache**: 7-day cache to reduce API latency
- **Nothing else**: No audio, no transcripts, no metadata, no analytics

### Data Retention
- **Audio**: Deleted within seconds after transcription (never written to disk)
- **Transcripts**: Never stored on our servers (delivered directly to your device)
- **Logs**: Cloudflare's standard edge logs (24-48 hours), automatic sensitive data filtering
- **Credits**: Stored until exhausted or license purchased

### Third-Party Processing
HyperWhisper Cloud uses Groq's API for transcription and post-processing:
- **Audio sent to**: Groq Whisper (speech-to-text)
- **Text sent to**: Groq Llama (typo correction)
- **Groq's privacy**: See [Groq Privacy Policy](https://groq.com/privacy-policy/)
- **For maximum privacy**: Use local Whisper models in the app (no cloud processing)

## Architecture

Built on Cloudflare Workers for global edge computing with zero cold starts.

### Stack
- **Runtime**: Cloudflare Workers (V8 isolates)
- **Transcription**: Groq Whisper large-v3-turbo
- **Post-processing**: Groq Llama 3.3 70B (typo correction)
- **Storage**: Cloudflare KV (credits only)
- **Language**: TypeScript

### Request Flow
```
1. Client uploads audio (multipart/form-data)
2. Worker validates credits (device or license)
3. Audio sent to Groq for transcription
4. Text sent to Groq for post-processing
5. Credits deducted, balance returned
6. Response sent to client
7. Audio immediately deleted
```

## Credit System

### Trial Users (device_id)
- **100 device credits** (~10 minutes of audio)
- **100 IP credits/day** (anti-abuse protection)
- **Dual deduction**: Both device AND IP credits charged
- **No anonymous access**: device_id required

### Licensed Users (license_key)
- **Polar meter-based billing**: Pay-as-you-go
- **No IP limits**: Full access with valid license
- **Validation caching**: 7-day cache for performance

### Cost Calculation
Credits based on actual Groq API costs (~$0.001-0.004 per request):
- **Trial**: $1.00 = 1000 credits (~100 minutes)
- **Licensed**: $5.00 = 5000 credits (~500 minutes)
- **Rate**: ~10 credits per audio minute

## API Endpoints

### POST /
Transcribe audio with automatic credit deduction.

**Request**:
```bash
curl -X POST https://transcribe-prod-v1.hyperwhisper.com/ \
  -H "Content-Type: multipart/form-data" \
  -F "file=@audio.m4a" \
  -F "license_key=hwl_..." \
  -F "language=en"
```

**Response**:
```json
{
  "original": "Raw transcription text",
  "corrected": "Post-processed text with typo corrections"
}
```

**Headers**:
- `X-Credits-Used`: Credits deducted
- `X-Device-Credits-Remaining`: Trial balance (device_id)
- `X-IP-RateLimit-Remaining`: IP quota (trial users)

### GET /usage
Query credit balance.

**Trial users**:
```bash
curl "https://transcribe-prod-v1.hyperwhisper.com/usage?device_id=xxx"
```

**Licensed users**:
```bash
curl "https://transcribe-prod-v1.hyperwhisper.com/usage?license_key=hwl_xxx"
```

**Response**:
```json
{
  "creditsRemaining": 850,
  "totalAllocated": 1000,
  "totalSpent": 150,
  "isLicensed": false,
  "minutesRemaining": 85
}
```

## Error Handling

- **401 Unauthorized**: No identifier provided or invalid license
- **402 Payment Required**: Insufficient device credits
- **429 Too Many Requests**: IP rate limit exceeded (trial users)
- **500 Internal Server Error**: Groq API failure or worker error

All errors include structured responses with credit balance information.

## Security

### Trial User Protection
1. **Device credits**: Per-device limit prevents unlimited usage
2. **IP rate limiting**: Prevents device_id spoofing/generation attacks
3. **Dual deduction**: Both checks must pass
4. **VPN resistance**: Device credits still exhausted
5. **Shared-IP protection**: 100/day limit per IP

### API Key Management
- **Groq API key**: Stored in Cloudflare Workers secrets (not in code)
- **Polar API key**: Stored in Cloudflare Workers secrets
- **No hardcoded credentials**: All secrets via wrangler.toml bindings

### Rate Limiting
- **IP-based**: 100 credits/day for trial users
- **Sliding window**: Daily quotas reset at midnight UTC
- **Cloudflare DDoS**: Automatic protection at edge

## Development

### Prerequisites
- Node.js 18+
- Wrangler CLI (`npm install -g wrangler`)
- Cloudflare account

### Setup
```bash
# Install dependencies
npm install

# Configure secrets (see SECRETS_SETUP.md)
wrangler secret put GROQ_API_KEY
wrangler secret put POLAR_API_KEY

# Deploy to development
wrangler deploy --env dev

# Deploy to production
wrangler deploy --env production
```

### Local Testing
```bash
# Run local dev server
wrangler dev

# Test transcription
curl -X POST http://localhost:8787/ \
  -F "file=@test.m4a" \
  -F "device_id=test-device"
```

## Deployment

### Environments
- **Development**: `transcribe-dev-v1.hyperwhisper.com`
- **Production**: `transcribe-prod-v1.hyperwhisper.com`

### KV Namespaces
- `DEVICE_CREDITS`: Trial credit balances
- `RATE_LIMITER`: IP daily quotas
- `LICENSE_CACHE`: License validation cache

All configured in `wrangler.toml` with environment-specific bindings.

## Verification

Users can verify the deployed code matches this repository:

1. **Check deployment**: Workers are deployed via GitHub Actions (coming soon)
2. **Audit logs**: Review commit history for all changes
3. **Self-host**: Fork and deploy your own instance
4. **Compare responses**: Test responses match expected behavior

## Privacy Policy

- **No data collection**: We don't collect, store, or analyze user data
- **No third-party sharing**: Audio is processed by Groq only for transcription (see Third-Party Processing above)
- **No advertisements**: No tracking pixels, analytics, or ads
- **Automatic log filtering**: Logs exclude audio, transcripts, and text (see `src/logger.ts:31-35`)
- **Minimal logging**: Standard Cloudflare edge logs only (24-48 hour retention)

## Contributing

We welcome contributions! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request with clear description
4. Ensure all tests pass (coming soon)

## License

[Your license here - MIT recommended for trust]

## Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/hyperwhisper-cloud/issues)
- **Email**: support@hyperwhisper.com
- **Documentation**: [hyperwhisper.com/docs](https://hyperwhisper.com/docs)

---

**Built with transparency. Powered by Cloudflare.**
