# VisionaryAI Task Execution Worker

Persistent Node.js server on Railway. Handles all AI task execution for VisionaryAI platform.

## Why Railway?
- No serverless timeout limits (Vercel max: 60s — Claude can take longer)
- Stays warm 24/7
- Cost: ~$5-10/month

## How it works
1. VisionaryAI (Vercel) creates a task and fires webhook to this worker
2. Worker reads task + user's Business Brain from Supabase
3. Worker calls Anthropic API with user's own API key
4. Result written back to Supabase tasks table as 'review'
5. User sees result on Projects board

## Setup
1. Deploy to Railway: `railway up`
2. Set env vars in Railway dashboard: SUPABASE_URL, SUPABASE_SERVICE_KEY, RAILWAY_SECRET
3. Copy Railway URL → set as RAILWAY_WORKER_URL in Vercel
4. Set RAILWAY_SECRET in Vercel too (must match)

## Env vars required
| Var | Value |
|-----|-------|
| `SUPABASE_URL` | `https://iiupwxbfhtqbpnlhpuru.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |
| `RAILWAY_SECRET` | Must match `RAILWAY_SECRET` in Vercel |
| `PORT` | Set automatically by Railway |

## Endpoints
- `GET /health` — health check (no auth required)
- `POST /execute` — trigger task execution (requires `Authorization: Bearer <RAILWAY_SECRET>`)
