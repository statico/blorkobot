# BlorkoBot

BlorkoBot is an unofficial bot for [MeshCore](https://github.com/meshcore-dev/MeshCore), the mesh radio protocol. It's a Python "fanout" plugin for [Remote Terminal for MeshCore](https://github.com/nicholasgasior/Remote-Terminal-for-MeshCore) plus a Node.js alert server, originally built for Bay Area MeshCore by Blorko and 100% coded with [Claude Code](https://claude.ai/code).

It responds in channels like **#bot**, **#test**, **#path**, **DMs**, and select topic channels (**#weather**, **#earthquake**, **#fire**, **#space**).

> **Note:** This is **not** the exact version of BlorkoBot running on [bayareameshcore.org](https://bayareameshcore.org). API keys, channel keys, content filter words, and a few region-specific bits have been blanked out so the source can be public. You'll need to fill these in for your own deployment. See [CLAUDE.md](./CLAUDE.md) for setup notes.

## Files

- **`bot.py`** — Fanout plugin for Remote Terminal. Handles all `!` commands and DM path replies.
- **`server.ts`** — Long-running Node.js server. Polls external services (USGS quakes, NWS weather alerts, CAL FIRE, NOAA SWPC, PG&E outages, RSS) and posts to MeshCore channels. Also logs telemetry.

## Getting Started

Send `!help` to BlorkoBot in #bot, #test, or a DM to see available commands. Commands start with `!`.

Send `!dm` in a channel and BlorkoBot will send you a direct message with path/hop info — useful for testing your mesh connectivity. In DMs, BlorkoBot also replies with path/hop information for any message.

## Commands

### Info & Navigation

| Command | Description |
|---------|-------------|
| `!help` | Show page 1 of commands |
| `!help2` / `!help3` / `!help4` | Subsequent help pages |
| `!docs` | Link to full documentation |
| `!about` | About BlorkoBot |
| `!channels` | List known, popular channels |
| `!path` / `!ping` / `test` / `!test` | Show hop count, path, and one-way transit time to BlorkoBot |
| `!pathx` | Extended path: each hop's repeater name + lat/lon (aliases: `!longpath`, `!bigpath`). `?` marks ambiguous prefix matches. Disambiguation algorithm adapted from [CoreScope](https://github.com/Kpa-clawbot/CoreScope) by Kp |
| `!pathall` / `!patha` | Wait ~8s and list every path the message arrived via |
| `!dm` | BlorkoBot sends you a DM with path/hop info |
| `!2byte` | Link to 2-byte prefix info + progress bar |

### Weather & Environment

| Command | Description | Source |
|---------|-------------|--------|
| `!weather <location>` | Current weather + UV index (Fahrenheit). Alias: `!w` | [wttr.in](https://wttr.in) |
| `!wc <location>` | Current weather + UV index (Celsius) | [wttr.in](https://wttr.in) |
| `!forecast <location>` | 3-day forecast (Fahrenheit). Alias: `!fc` | [wttr.in](https://wttr.in) |
| `!fcc <location>` | 3-day forecast (Celsius) | [wttr.in](https://wttr.in) |
| `!sun <location>` | Sunrise and sunset times | [wttr.in](https://wttr.in) |
| `!moon` | Current moon phase and illumination | Local calculation |
| `!alerts <state>` | Active NWS weather alerts (2-letter state code) | [NWS API](https://api.weather.gov) |
| `!aqi <location>` | Air quality index (US AQI + PM2.5) | [Open-Meteo](https://open-meteo.com) |
| `!pollen <location>` | Pollen count by type and level | [Open-Meteo](https://open-meteo.com) |

### Tides, Ocean & Rivers

| Command | Description | Source |
|---------|-------------|--------|
| `!tide <station>` | NOAA tide predictions (name or station ID). Alias: `!surf` | [NOAA Tides & Currents](https://tidesandcurrents.noaa.gov) |
| `!wave <location>` | Ocean wave height, period, and direction | [Open-Meteo Marine](https://open-meteo.com) |
| `!river <name or site#>` | Real-time river/stream flow and gauge height (CA) | [USGS Water Services](https://waterservices.usgs.gov) |

### Science & Space

| Command | Description | Source |
|---------|-------------|--------|
| `!quake [count] [mag] [location]` | Earthquakes in CA/NV (default) or near a location | [USGS Earthquake Hazards](https://earthquake.usgs.gov) |
| `!fire` | Active CA wildfires (top 3 by size). Aliases: `!fires`, `!wildfire` | [CAL FIRE](https://www.fire.ca.gov/incidents) |
| `!511 [route]` | Recent Bay Area traffic incidents or construction by highway | [511 SF Bay](https://511.org) |
| `!space` | Space weather: Kp index, solar wind, Bz, solar flux. Alias: `!solar` | [NOAA SWPC](https://www.swpc.noaa.gov) |
| `!swx` | Active space weather warnings/watches | [NOAA SWPC](https://www.swpc.noaa.gov) |
| `!flare` | Recent solar flares (X-ray class) | [NOAA SWPC](https://www.swpc.noaa.gov) |
| `!iss` | Current ISS position | [Open Notify](http://open-notify.org) |
| `!iss <location>` | Upcoming visible ISS passes (min 20 deg elevation) | [N2YO](https://www.n2yo.com) |
| `!neo` | Near-Earth objects tracked today. Alias: `!asteroid` | [NASA NEO API](https://api.nasa.gov) |
| `!hf` | HF radio propagation conditions + solar indices | [hamqsl.com](https://www.hamqsl.com) |
| `!apod` | NASA Astronomy Picture of the Day. Alias: `!nasa` | [NASA APOD](https://api.nasa.gov) |

### Utilities

| Command | Description | Source |
|---------|-------------|--------|
| `!time <city>` | Current time in any city | [wttr.in](https://wttr.in) |
| `!convert <val> <from> <to>` | Unit conversion (mi/km, ft/m, in/cm, lb/kg, oz/g, gal/l, mph/kph, nmi, f/c) | Local calculation |
| `!zip <zipcode>` | Zip code to city, state, and coordinates | [Zippopotam.us](https://api.zippopotam.us) |
| `!who <prefix>` | Look up repeaters by hex prefix (e.g. `!who 77`) | Local |
| `!advert` | Trigger a flood advertisement (announce presence on mesh) | Local |
| `!stats` | Mesh network stats: nodes, repeaters, packets, noise floor, repeater hash widths | Local |
| `!define <word>` | Dictionary definition | [Free Dictionary API](https://dictionaryapi.dev) |
| `!wiki <topic>` | Wikipedia summary | [Wikipedia REST API](https://en.wikipedia.org/api/rest_v1/) |
| `!country <name>` | Country info: capital, population, region, languages | [REST Countries](https://restcountries.com) |

### Finance

| Command | Description | Source |
|---------|-------------|--------|
| `!stock <symbol>` | Stock price and daily change | [Yahoo Finance](https://finance.yahoo.com) |
| `!crypto <coin>` | Crypto price (btc, eth, sol, doge, …) | [CoinGecko](https://www.coingecko.com) |

### Sports

| Command | Description | Source |
|---------|-------------|--------|
| `!score <team>` | Bay Area sports score (giants, warriors, 49ers, sharks, quakes, roots, as) | [ESPN](https://www.espn.com) |

### Aviation

| Command | Description | Source |
|---------|-------------|--------|
| `!flight <number>` | Flight status: route, gate/terminal, times, delay, status. Alias: `!flights` | [AeroDataBox](https://aerodatabox.com) |
| `!delays [airport]` | FAA ground stops & delays. No arg = SFO/OAK/SJC summary | [FAA NAS Status](https://nasstatus.faa.gov) |
| `!sky [location]` | Non-airline aircraft overhead: helicopters, military, blimps, balloons | [ADSB.lol](https://adsb.lol) |
| `!mil [location]` | Military aircraft currently airborne. Alias: `!military` | [ADSB.lol](https://adsb.lol) |
| `!blimp [location]` | Lighter-than-air craft. Alias: `!blimps` | [ADSB.lol](https://adsb.lol) |
| `!tfr` | Bay Area temporary flight restrictions. Alias: `!temp` | [FAA TFR](https://tfr.faa.gov) |

### Infrastructure

| Command | Description | Source |
|---------|-------------|--------|
| `!power` | PG&E Bay Area outages affecting 500+ customers. Alias: `!outage` | [PG&E](https://www.pge.com) |

### Fun & Games

| Command | Description | Source |
|---------|-------------|--------|
| `!ai <question>` | Ask the AI a question | [Groq](https://groq.com) |
| `!sonnet <subject>` | Short Shakespearean sonnet about the subject | [Groq](https://groq.com) |
| `!haiku <subject>` | Haiku (5/7/5) about the subject | [Groq](https://groq.com) |
| `!trivia [easy\|medium\|hard]` | Trivia question — answer with A/B/C/D or `!guess` | [Open Trivia DB](https://opentdb.com) |
| `!guess <letter>` / `!answer <letter>` | Answer the active trivia question | — |
| `!leaderboard` | Top 10 trivia scorers. Alias: `!lb` | Local |
| `!chess` | Start a new chess game vs the bot | [chess-api.com](https://chess-api.com) |
| `!move <uci>` | Make a chess move in UCI format, e.g. `!move e2e4` | — |
| `!board` | Show the current chess board and recent moves | — |
| `!resign` | Resign the current chess game | — |
| `!elo [800-2400]` | Show or set the bot's chess difficulty | — |
| `!otd` | Random historical event on this day. Alias: `!today` | [Wikipedia](https://en.wikipedia.org) |
| `!8ball [question]` | Magic 8-Ball | Local |
| `!joke [search]` | Random joke | [JokeAPI](https://v2.jokeapi.dev) |
| `!dadjoke` | Random dad joke | [icanhazdadjoke](https://icanhazdadjoke.com) |
| `!riddle` | Random riddle (with answer) | [Riddles API](https://riddles-api.vercel.app) |
| `!quote` | Inspirational quote. Alias: `!inspire` | [ZenQuotes](https://zenquotes.io) |
| `!advice` | Random advice | [Advice Slip](https://api.adviceslip.com) |
| `!fact` | Random fun fact | [Useless Facts](https://uselessfacts.jsph.pl) |
| `!catfact` | Random cat fact. Alias: `!cat` | [Cat Facts](https://catfact.ninja) |
| `!cocktail` | Random cocktail recipe. Alias: `!drink` | [TheCocktailDB](https://www.thecocktaildb.com) |
| `!futurama` | Random Futurama quote | [Morbotron](https://morbotron.com) |
| `!simpsons` | Random Simpsons quote | [Frinkiac](https://frinkiac.com) |

### Key-Value Store

A shared notepad — anyone can set and read values.

| Command | Description |
|---------|-------------|
| `!set <key> <value>` | Store a value (32 char key, 200 char value max) |
| `!get <key>` | Retrieve a stored value |
| `!del <key>` | Delete a stored value |

Up to 100 keys total.

## Automatic Alerts

The `server.ts` companion process posts automatic alerts to dedicated channels:

- **#earthquake** — Earthquakes M2.5+ in a configurable bounding box (from [USGS](https://earthquake.usgs.gov))
- **#weather** — NWS weather alerts for configured zones (from [NWS API](https://api.weather.gov)). Same event types are rate-limited to avoid spam.
- **#fire** — Active California wildfires (from [CAL FIRE](https://www.fire.ca.gov/incidents))
- **#space** — Solar flares (M-class+) and geomagnetic storms (Kp 5+) (from [NOAA SWPC](https://www.swpc.noaa.gov))
- **#power** — PG&E power outages (500+ customers) with city location (from [PG&E](https://www.pge.com))
- **#alert** — Aggregated firehose of all of the above
- **#bot** / **#alert** — New posts from a configured RSS feed

These are pushed automatically — no commands needed. Just join the channel.

## Topic Channels

BlorkoBot also responds to relevant commands in topic channels:

| Channel | Commands |
|---------|----------|
| **#weather** | `!weather` `!wc` `!forecast` `!fcc` `!sun` `!tide` `!surf` `!alerts` `!aqi` `!wave` |
| **#earthquake** | `!quake` `!quakes` `!earthquake` `!earthquakes` |
| **#fire** | `!fire` `!fires` `!wildfire` |
| **#space** | `!space` `!solar` `!swx` `!flare` `!hf` |
| **#path** | `!path` `!pathx` `!pathall` `!patha` `!longpath` `!bigpath` `!ping` `!test` `!dm` `!stats` |

Only the listed commands work in each topic channel. Use **#bot** or **#test** for the full command set.

## Tips

- Location-based commands require a location (e.g., `!weather sf`). Shortcuts: **"sf"** = San Francisco, **"sj"** = San Jose, **"sfo"** = SFO airport.
- Messages are limited by mesh radio constraints (~120 bytes), so responses are kept short. Long responses may be split across multiple messages (up to 3).
- In DMs, any non-command message returns path/hop info — great for testing connectivity.

## Setup

1. Install and run [Remote Terminal for MeshCore](https://github.com/nicholasgasior/Remote-Terminal-for-MeshCore) — it listens on `http://127.0.0.1:4042` by default.
2. Create a fanout plugin in Remote Terminal pointing at `bot.py`, or PATCH the source in via the API (see [CLAUDE.md](./CLAUDE.md)).
3. Fill in API keys in `bot.py` (`_N2YO_KEY`, `_BAY511_API_KEY`, `_GROQ_KEY`, `_AERODATABOX_KEY`). Commands degrade gracefully when keys are missing.
4. Fill in the channel keys at the top of `server.ts` for the channels you want alerts posted to, and adjust `QUAKE_BBOX` and `NWS_ZONES` for your region.
5. Run `server.ts` with `node --experimental-strip-types --env-file=.env --watch server.ts`.

## License

[Unlicense](https://unlicense.org) — public domain.
