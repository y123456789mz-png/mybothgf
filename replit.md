# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/discord-bot run dev` — run Discord AI bot locally

## Packages

- `artifacts/api-server` — Express HTTP API
- `artifacts/discord-bot` — Discord AI bot (discord.js + OpenAI via Replit AI Integrations)
- `artifacts/mockup-sandbox` — UI mockup sandbox

## Discord Bot

- Connects to Discord via the gateway using `DISCORD_BOT_TOKEN` (secret).
- Uses OpenAI through Replit AI Integrations (`AI_INTEGRATIONS_OPENAI_*` env vars, no user API key required).
- Replies when mentioned in a server channel or messaged in a DM.
- Keeps a short rolling per-channel conversation history (12 messages) in memory.
- Requires "Message Content Intent" enabled on the Discord developer portal.
- Workflow: `Discord Bot` (console output, no port).
- **Voice support**: mention the bot with `join` to make it join the speaker's voice channel; mention with `leave` to disconnect. Once joined, it transcribes whoever speaks (whisper STT), generates a reply with GPT-5.4, and speaks it back via OpenAI TTS. Requires the bot to have `Connect` and `Speak` voice permissions and `GuildVoiceStates` gateway intent. Uses `@discordjs/voice` + `prism-media` + `opusscript` (pure JS opus) + `libsodium-wrappers` + system `ffmpeg`.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
