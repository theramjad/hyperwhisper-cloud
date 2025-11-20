# Cloudflare Workers Secrets Setup

## Required Secrets

Your workers need these secrets to function. They are **NOT** stored in `wrangler.toml` for security reasons.

### 1. GROQ_API_KEY
**What it is:** API key for Groq (used for Whisper transcription and Llama chat)
**Where to get it:** https://console.groq.com/keys

### 2. POLAR_ACCESS_TOKEN
**What it is:** API token for Polar.sh (used for license validation and billing)
**Where to get it:** https://polar.sh/settings (under API Keys)

## Setup Commands

### Development Environment

```bash
cd cloudflare-workers-v1

# Add Groq API key
npx wrangler secret put GROQ_API_KEY --env development
# Paste your Groq API key when prompted

# Add Polar access token
npx wrangler secret put POLAR_ACCESS_TOKEN --env development
# Paste your Polar access token when prompted
```

### Production Environment

```bash
# Add Groq API key (production)
npx wrangler secret put GROQ_API_KEY --env production
# Paste your Groq API key when prompted

# Add Polar access token (production)
npx wrangler secret put POLAR_ACCESS_TOKEN --env production
# Paste your Polar access token when prompted
```

## Verify Secrets

To verify secrets are set:

```bash
# List secrets for development
npx wrangler secret list --env development

# List secrets for production
npx wrangler secret list --env production
```

You should see:
```
GROQ_API_KEY
POLAR_ACCESS_TOKEN
```