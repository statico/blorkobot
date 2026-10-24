# BlorkoBot

BlorkoBot is an unofficial bot for [MeshCore](https://github.com/meshcore-dev/MeshCore), the mesh radio protocol. It's a Python "fanout" plugin for [Remote Terminal for MeshCore](https://github.com/nicholasgasior/Remote-Terminal-for-MeshCore) plus a Node.js alert server, originally built for Bay Area MeshCore by Blorko and 100% coded with [Claude Code](https://claude.ai/code).

It responds in channels like **#bot**, **#test**, **#path**, **DMs**, and select topic channels (**#weather**, **#earthquake**, **#fire**, **#space**).

> **Note:** This is **not** the exact version of BlorkoBot running on [bayareameshcore.org](https://bayareameshcore.org). API keys, channel keys, content filter words, and a few region-specific bits have been blanked out so the source can be public. You'll need to fill these in for your own deployment. See [CLAUDE.md](./CLAUDE.md) for setup notes.

## Files

- **`bot.py`** — Fanout plugin for Remote Terminal. Handles all `!` commands and DM path replies.
- **`server.ts`** — Long-running Node.js server. Polls external services (USGS quakes, NWS weather alerts, CAL FIRE, NOAA SWPC, PG&E outages, RSS) and posts to MeshCore channels. Also logs telemetry and syncs repeater clocks.
- **`tsunami.ts`** — NWS/NTWC tsunami bulletin parsing (VTEC + UGC zones) used by `server.ts`. Tests: `node --test --experimental-strip-types tsunami.test.ts`.

## Getting Started

Send `!help` (or just `help`) to BlorkoBot in #bot or #test to see available commands. Commands start with `!`.

Send `!dm` in a channel and BlorkoBot will send you a direct message with path/hop info — useful for testing your mesh connectivity. In DMs, BlorkoBot **only** replies with path/hop information — `!` commands do not work in DMs. This is intentional, to keep the bot from being used to flood the mesh via private messages.

## Commands

### Info & Navigation

| Command | Description |
|---------|-------------|
| `!help` / `help` | Show page 1 of commands |
| `!help2` | Show page 2 |
| `!help3` | Show page 3 |
| `!help4` | Show page 4 |
| `!docs` | Link to full documentation |
| `!about` | About BlorkoBot |
| `!channels` | List known, popular channels |
| `!path` / `path` / `!ping` / `test` / `!test` | Show hop count, path bytes-per-hop width, path, one-way transit time, and approximate total miles along the path (`~38mi`, dropped if the reply would be too long) |
| `!pathx` | Extended path: each hop's repeater name + distance traveled from the previous hop, in miles (aliases: `!longpath`, `!bigpath`; use `!pathxkm` for kilometers). 🎯 marks a repeater we identified for certain, ❓ marks a best-guess when the prefix was ambiguous; `(?)` means a distance couldn't be computed. Disambiguation algorithm adapted from [CoreScope](https://github.com/Kpa-clawbot/CoreScope) by Kp |
| `!pathall` / `!patha` / `!heard` | Wait ~12s and list every path the message arrived via, each labeled with its byte width (e.g. `1-byte F0→E3→AB`) |
| `!pathy` / `!pathz` | ASCII-only versions of `!path` / `!pathall` for clients that can't render unicode arrows or emoji |
| `!packet` | Links to analyzer.00id.net and analyzer.letsmesh.net for the packet you just sent |
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
| `!alerts <state>` | Active NWS weather alerts (2-letter state code, default: CA) | [NWS API](https://api.weather.gov) |
| `!aqi <location>` | Air quality index (US AQI + PM2.5) | [Open-Meteo](https://open-meteo.com) |
| `!pollen <location>` | Pollen count by type and level | [Open-Meteo](https://open-meteo.com) |

### Tides, Ocean & Rivers

| Command | Description | Source |
|---------|-------------|--------|
| `!tide <place>` | NOAA tide predictions for the nearest station to any coastal place (e.g. `!tide morro bay`), or a station name/ID. Typos and nicknames are OK. Alias: `!surf` | [NOAA Tides & Currents](https://tidesandcurrents.noaa.gov) |
| `!wave <location>` | Ocean wave height, period, and direction | [Open-Meteo Marine](https://open-meteo.com) |
| `!river <name or site#>` | Real-time river/stream flow and gauge height (CA) | [USGS Water Services](https://waterservices.usgs.gov) |

### Science & Space

| Command | Description | Source |
|---------|-------------|--------|
| `!quake [count] [mag] [location]` | Earthquakes in CA/NV (default) or near a location. Optional: count (1-5), magnitude filter (`5+` or `M4.5`), location (`!quake 3 tokyo`, `!quake 5+ LA`). Aliases: `!earthquake` | [USGS Earthquake Hazards](https://earthquake.usgs.gov) |
| `!fire` | Active CA wildfires (top 3 by size). Aliases: `!fires`, `!wildfire` | [CAL FIRE](https://www.fire.ca.gov/incidents) |
| `!511 [route]` | Recent Bay Area traffic incidents (⚠️) region-wide, or incidents + construction (🚧) on a specific highway. Examples: `!511`, `!511 101`, `!511 880` | [511 SF Bay](https://511.org) |
| `!space` | Space weather: Kp index, solar wind, Bz, solar flux. Aliases: `!solar` | [NOAA SWPC](https://www.swpc.noaa.gov) |
| `!swx` | Active space weather warnings/watches | [NOAA SWPC](https://www.swpc.noaa.gov) |
| `!flare` | Recent solar flares (X-ray class) | [NOAA SWPC](https://www.swpc.noaa.gov) |
| `!iss` | Current ISS position | [Open Notify](http://open-notify.org) |
| `!iss <location>` | Upcoming visible ISS passes (min 20 deg elevation) | [N2YO](https://www.n2yo.com) |
| `!neo` | Near-Earth objects tracked today. Aliases: `!asteroid` | [NASA NEO API](https://api.nasa.gov) |
| `!hf` | HF radio propagation conditions + solar indices. Aliases: `!hfconditions`, `!propagation` | [hamqsl.com](https://www.hamqsl.com) |
| `!apod` | NASA Astronomy Picture of the Day. Alias: `!nasa` | [NASA APOD](https://api.nasa.gov) |

### Utilities

| Command | Description | Source |
|---------|-------------|--------|
| `!time <city>` | Current time in any city | [wttr.in](https://wttr.in) |
| `!convert <val> <from> <to>` | Unit conversion (mi/km, ft/m, in/cm, lb/kg, oz/g, gal/l, mph/kph, nmi, f/c) | Local calculation |
| `!news [place or topic]` | One-line digest of today's news for a place or topic (default: Bay Area), e.g. `!news concord ca`. Summarized by AI from Google News headlines | [Google News](https://news.google.com) |
| `!zip <zipcode>` | Zip code to city, state, and coordinates | [Zippopotam.us](https://api.zippopotam.us) |
| `!whois <prefix or name>` | Look up any node (repeater, companion, room) by hex key prefix or name, e.g. `!whois 54ed`. Alias: `!who` | Contacts + [CoreScope](https://corescope.stonekitty.net) |
| `!where <name>` | Where a node is: nearest town, distance and direction from BlorkoBot, last heard. Accepts a name, `@[name]`, or hex prefix | Contacts + [CoreScope](https://corescope.stonekitty.net), [Nominatim](https://nominatim.org) |
| `!advert` | Trigger a flood advertisement (announce presence on mesh) | Local |
| `!mcmonday` | #mcmonday check-ins and cities this week. `!mcmondaya` / `!mcmondayall` for all-time totals and top cities. `!mcmonday <city>` (or `!mcmondaycity <city>`) for one city's check-ins and regulars; typos and nicknames are OK | [#mcmonday](#topic-channels) |
| `!stats` | BlorkoBot stats: total replies, people helped, replies today, tests, DMs, and most-used commands. (In #path, `!stats` shows mesh stats; in #mcmonday, check-in stats.) | Local |
| `!meshstats` | Mesh network stats: nodes, repeaters, packets, noise floor, repeater hash widths, 2-byte progress bar | Local |
| `!define <word>` | Dictionary definition | [Free Dictionary API](https://dictionaryapi.dev) |
| `!wiki <topic>` | Wikipedia summary | [Wikipedia REST API](https://en.wikipedia.org/api/rest_v1/) |
| `!country <name>` | Country info: capital, population, region, languages | [REST Countries](https://restcountries.com) |

#### How `!where` works

`!where` searches every node BlorkoBot has heard plus the nodes seen by [CoreScope](https://corescope.stonekitty.net)'s Bay Area observers. Example reply: `3rabbit🐇 (DE68): near Fremont, 16mi SE of BlorkoBot, heard 3d (+1 more)`

- **Matching:** `@[name]` must match exactly (case, emoji and punctuation are ignored). A hex value is tried as a key prefix first. A plain name tries exact, then partial, then close-spelling matches, so `!where luna` can find "Lunar Fern". The reply always shows the name it matched.
- **Location** is whatever the node advertises, so it may be rounded or out of date. Many companions don't share one ("no location shared").
- **Distance** is a straight line from BlorkoBot. The town comes from [OpenStreetMap](https://nominatim.org).
- **"heard"** is when any observer last heard the node, not just BlorkoBot.
- **"(+N more)"** means other nodes also matched. The reply shows the most recently heard one that has a location. Use `!whois` to list them.

### Finance

| Command | Description | Source |
|---------|-------------|--------|
| `!stock <symbol>` | Stock price and daily change | [Yahoo Finance](https://finance.yahoo.com) |
| `!crypto <coin>` | Crypto price (btc, eth, sol, doge, xrp, ada, dot, ltc, link, avax, shib, atom, matic, near, uni) | [CoinGecko](https://www.coingecko.com) |

### Sports

| Command | Description | Source |
|---------|-------------|--------|
| `!score <team>` | Bay Area sports score (giants, warriors, 49ers, sharks, quakes, roots, as). Aliases: dubs, niners | [ESPN](https://www.espn.com) |

### Aviation

| Command | Description | Source |
|---------|-------------|--------|
| `!flight <number>` | Flight status: route, gate/terminal, scheduled & ETA times, delay, status. Alias: `!flights` | [AeroDataBox](https://aerodatabox.com) |
| `!delays [airport]` | FAA ground stops & delays. No arg = SFO/OAK/SJC summary; with arg = single airport detail. Alias: `!delay` | [FAA NAS Status](https://nasstatus.faa.gov) |
| `!sky [location]` | Non-airline aircraft overhead: helicopters (with circling detection), military, blimps, balloons. Default = Bay Area; with location ~15 mi radius. Alias: `!skies` | [ADSB.lol](https://adsb.lol) |
| `!mil [location]` | Military aircraft currently airborne, closest first. Alias: `!military` | [ADSB.lol](https://adsb.lol), [adsb.fi](https://adsb.fi) backup |
| `!blimp [location]` | Lighter-than-air craft: Pathfinder 1, Goodyear, balloons. Alias: `!blimps` | [ADSB.lol](https://adsb.lol) |
| `!tfr` | Bay Area temporary flight restrictions (VIP visits, wildfires, airshows). Alias: `!temp` | [FAA TFR](https://tfr.faa.gov) |

### Infrastructure

| Command | Description | Source |
|---------|-------------|--------|
| `!power` | PG&E Bay Area outages affecting 500+ customers, with top 3 largest and city location. Aliases: `!outage` | [PG&E](https://www.pge.com) |

### Fun & Games

| Command | Description | Source |
|---------|-------------|--------|
| `!ai <question>` | Ask the AI a question | [Groq](https://groq.com) |
| `!sonnet <subject>` | Short Shakespearean sonnet about the subject | [Groq](https://groq.com) |
| `!haiku <subject>` | Haiku (5/7/5) about the subject | [Groq](https://groq.com) |
| `!trivia [easy\|medium\|hard]` | Trivia question — answer with A/B/C/D or `!guess`. First correct answer scores a point! | [Open Trivia DB](https://opentdb.com) |
| `!guess <letter>` / `!answer <letter>` | Answer the active trivia question | — |
| `!leaderboard` | Top 10 trivia scorers. Alias: `!lb` | Local |
| `!chess` | Start a new chess game vs the bot (one global game, everyone plays white). Use `!chess new` to reset | [chess-api.com](https://chess-api.com) |
| `!move <uci>` | Make a chess move in UCI format, e.g. `!move e2e4`. Bot replies with its move | — |
| `!board` | Show the current chess board and recent moves | — |
| `!resign` | Resign the current chess game | — |
| `!elo [800-2400]` | Show or set the bot's chess difficulty (default ~1000) | — |
| `!otd` | Random historical event on this day. Aliases: `!today` | [Wikipedia](https://en.wikipedia.org) |
| `!8ball [question]` | Magic 8-Ball, e.g. `!8ball will i win the lottery` | Local |
| `!joke [search]` | Random joke (optional search term) | [JokeAPI](https://v2.jokeapi.dev) |
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

| Command | Description | Source |
|---------|-------------|--------|
| `!set <key> <value>` | Store a value (32 char key, 200 char value max) | Local storage |
| `!get <key>` | Retrieve a stored value | Local storage |
| `!del <key>` | Delete a stored value | Local storage |

Up to 100 keys total.

## Automatic Alerts

BlorkoBot also monitors and posts automatic alerts to dedicated channels:

- **#earthquake** — Earthquakes M3.0+ in the Bay Area / CA / NV region (from [USGS](https://earthquake.usgs.gov))
- **#weather** — NWS weather alerts for Bay Area zones with hazard details (from [NWS API](https://api.weather.gov)). Same event types are rate-limited to avoid spam during active storms.
  - **Tsunami** warnings, advisories, and watches for the Bay Area coast are checked every 15 seconds against the [National Tsunami Warning Center](https://www.tsunami.gov) bulletin and posted right away with what to do and the estimated arrival time at San Francisco. An all-clear is posted when it ends. Monthly test bulletins are not posted.
- **#fire** — Active California wildfires and significant updates (from [CAL FIRE](https://www.fire.ca.gov/incidents))
- **#space** — Solar flares (M-class+) and geomagnetic storms (Kp 5+) (from [NOAA SWPC](https://www.swpc.noaa.gov))
- **#power** — PG&E power outages (500+ customers) with city location (from [PG&E](https://www.pge.com))
- **#bot** / **#alert** — New posts from the [Bay Area MeshCore blog](https://bayareameshcore.com)
- **#alert** — Military aircraft flying within ~25 nautical miles of the Bay Area (from [ADSB.lol](https://adsb.lol)). Each aircraft is posted at most once a day, with at most one post every 30 minutes and 6 per day.
- **#alert** — All of the above — a single channel for all automated alerts
- **#mcmonday** — Tuesday 9am PT recap of Monday's check-ins: count, cities, and check-ins per city (same as `!mcmonday`)
- **#bot** / **#test** — Daily help reminder at 3pm PT: a rotating command tip in **#bot**, and a quick `!pathx` / `!patha` / `!help` pointer in **#test**
- **Public** — A short welcome pointing newcomers to [baymc.org](https://baymc.org). It only goes out when new people have actually been talking in Public, and never more than once every 12 hours. This is the only thing BlorkoBot ever posts to Public.

These are pushed automatically — no commands needed. Just join the channel.

## Topic Channels

BlorkoBot also responds to relevant commands in topic channels:

| Channel | Commands |
|---------|----------|
| **#weather** | `!weather` `!wc` `!forecast` `!fcc` `!sun` `!tide` `!surf` `!alerts` `!aqi` `!wave` |
| **#earthquake** | `!quake` `!quakes` `!earthquake` `!earthquakes` |
| **#fire** | `!fire` `!fires` `!wildfire` |
| **#space** | `!space` `!solar` `!swx` `!flare` `!hf` |
| **#mcmonday** | `!stats` (this week, same as `!mcmonday`) `!statsa` `!statsall` (all-time) `!stats <city>` `!statscity <city>` (one city). MeshCore Monday: every Monday, check in with your city! |
| **#path** | `!path` `!pathx` `!pathxkm` `!pathall` `!patha` `!heard` `!pathy` `!pathz` `!longpath` `!bigpath` `!ping` `!test` `!dm` `!stats` (mesh stats) `!packet` |

Only the listed commands work in each topic channel — other commands are ignored there. Use **#bot** or **#test** for the full command set.

## Tips

- Location-based commands require a location (e.g., `!weather sf`). Shortcuts: **"sf"** = San Francisco, **"sj"** = San Jose, **"sfo"** = SFO airport. Misspelled or nickname places (e.g. "santa crooz") are usually figured out automatically.
- `!alerts` defaults to **CA**.
- Messages are limited by mesh radio constraints (~139 bytes), so responses are kept short. Long responses may be split across multiple messages (up to 3).
- In DMs, BlorkoBot only ever replies with path/hop info (great for testing connectivity). Commands are ignored in DMs — use **#bot** or **#test** for those.
- BlorkoBot ignores other bots: if a contact's name contains a 🤖 emoji, BlorkoBot won't respond to their messages (including DMs). This keeps bots from talking to each other and clogging the mesh.

## Setup

1. Install and run [Remote Terminal for MeshCore](https://github.com/nicholasgasior/Remote-Terminal-for-MeshCore) — it listens on `http://127.0.0.1:4042` by default.
2. Create a fanout plugin in Remote Terminal pointing at `bot.py`, or PATCH the source in via the API (see [CLAUDE.md](./CLAUDE.md)).
3. Fill in API keys in `bot.py` (`_N2YO_KEY`, `_BAY511_API_KEY`, `_GROQ_KEY`, `_AERODATABOX_KEY`). Commands degrade gracefully when keys are missing.
4. Fill in the channel keys at the top of `server.ts` for the channels you want alerts posted to, and adjust `QUAKE_BBOX`, `NWS_ZONES`, and `MIL_CENTER` for your region. Optionally set `SR_REPEATER_KEY` (telemetry polling) and `CLOCK_SYNC_REPEATERS` (daily clock sync for repeaters you administer).
5. Run `server.ts` with `node --experimental-strip-types --env-file=.env --watch server.ts`.

## How some things are counted

### `!2byte` / `!meshstats` — repeater hash width

MeshCore repeaters can be configured to use 1-, 2-, or 3-byte path prefixes when they relay adverts. Wider prefixes reduce collisions but take up more room in each packet. Rolling that number up across a mesh is a decent proxy for how far along a network is on the "moving to 2-byte prefixes" migration.

Remote Terminal exposes an `/api/contacts/repeaters/advert-paths` endpoint that returns, per repeater, the recent advert paths it has seen. Each path has a hex string and a hop count. Bytes per hop = `len(path_hex) / 2 / path_len` — and because a repeater always encodes hop entries in its own `PATH_HASH_SIZE`, that number tells you the repeater's setting.

The naive version — "look at the single most recent advert" — undercounts 2-byte repeaters for two reasons:

1. A repeater's most recent advert may happen to be its single 1-byte edge case (or the path stored for it wasn't the most useful sample). Some repeaters emit adverts with different bph values over time.
2. Repeaters that were heard once six months ago on 1-byte firmware and never again still count as "1-byte" even if they've since upgraded or died.

`_count_repeater_types()` fixes both:

- Ask for up to **20 recent adverts per repeater** and take the **max** bytes-per-hop seen. If a repeater ever emitted a 2-byte advert in that window, it's 2-byte-capable.
- Ignore any repeater whose most recent advert is more than **30 days** old.

Both refinements come from studying [CoreScope](https://github.com/Kpa-clawbot/CoreScope)'s approach, which reads the hash size directly from packet header bits and takes a running max across everything it's seen. We can't read raw header bits from the Remote Terminal API, but the derived bytes-per-hop is equivalent when the path is well-formed.

### `!pathx` — extended path with repeater names

MeshCore path hops are prefixes of a repeater's public key (usually 1 or 2 bytes). Multiple repeaters can share a prefix, so turning a path back into a list of names is a disambiguation problem. `_resolve_path_hops()` in `bot.py` works in four layers, each only used if the previous can't decide:

1. **Adjacency** — if a candidate has a confirmed neighbor edge to an already-resolved hop (or to the sender/receiver at the ends), it wins.
2. **Shared neighbors** — a candidate whose neighbor set overlaps the path's resolved pubkeys is more likely to be on the path.
3. **GPS interpolation** — with the sender and receiver as anchors, interpolate an expected location for each remaining hop and pick the closest candidate.
4. **Last seen** — tiebreaker for the recently-heard candidate.

Layers 1 and 2 commit only on decisive evidence (best score ≥ 3× second-best), so thin evidence falls through to GPS rather than over-committing. Adjacency and neighbor data are precomputed by `server.ts` from the recent packet history and dumped to a JSON cache the bot reloads on mtime change.

This is adapted from CoreScope's disambiguation gate — the specific thresholds and the layer ordering match theirs.

## License

[Unlicense](https://unlicense.org) — public domain.
