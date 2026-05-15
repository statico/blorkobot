# BlorkoBot

BlorkoBot is a bot for [MeshCore](https://github.com/meshcore-dev/MeshCore), a mesh radio service.

We use [Remote Terminal for MeshCore](https://github.com/nicholasgasior/Remote-Terminal-for-MeshCore) to talk to users. It runs locally and exposes an HTTP API at `http://127.0.0.1:4042/` (see `/docs` or `/openapi.json`).

`bot.py` is a Python "fanout" plugin for Remote Terminal — it responds to user messages. `server.ts` is a long-running Node.js server that polls external services (USGS, NWS, etc.) and pushes alerts to MeshCore channels via the same API.

## Updating the fanout config

After editing `bot.py`, deploy it by PATCHing the fanout config (replace `<FANOUT_ID>` with your fanout's UUID):

```sh
jq -n --rawfile code bot.py '{"config": {"code": $code}}' | \
  curl -s -X PATCH -H "Content-Type: application/json" -d @- \
  http://127.0.0.1:4042/api/fanout/<FANOUT_ID>
```

The PATCH triggers an automatic module reload.

## Design notes

- DMs to the bot reply with `"<message>" - <path info>` (the path reply). `!` commands do NOT work in DMs.
- MeshCore has a short message limit (~120 bytes), so responses must be terse.
- Never get into a loop and clog up the mesh with extraneous traffic.
- Never respond in the Public channel.

## API keys

Several commands use external APIs that require keys. The public source has these blanked out — fill them in for your deployment:

- `_N2YO_KEY` in `bot.py` — satellite passes (`!iss <location>`)
- `_BAY511_API_KEY` in `bot.py` — Bay Area traffic (`!511`)
- `_GROQ_KEY` in `bot.py` — AI/LLM commands (`!ai`, `!sonnet`, `!haiku`)
- `_AERODATABOX_KEY` in `bot.py` — flight status (`!flight`)

Commands degrade gracefully when keys are missing.
