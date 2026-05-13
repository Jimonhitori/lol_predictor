# Live Schedule and Draft Data Sources

This project needs two different live data layers:

1. Match-day schedule: today's matches, league, start time, teams, best-of, status.
2. Live game state: current game, blue/red side, champion picks/bans, and ideally player stats.

## Shortlist

### Cito API / LoL Esports API

Best fit for a small product prototype because it advertises free-key testing and
developer-friendly LoL endpoints. Public pages mention:

- `GET /api/v1/lol/schedule/today`
- `GET /api/v1/lol/live`
- `GET /api/v1/lol/games/{gameId}/stats`
- live match state, schedules, game/player stats, draft picks/bans, and webhooks.

The app currently supports this path through:

- `CITO_API_KEY`
- `CITO_LOL_MATCHES_URL`

The default can be pointed at a live endpoint or a schedule endpoint while we
verify the exact response shape with a real key.

### LoL Esports Unofficial API

Riot's public LoL Esports site uses internal endpoints that community wrappers
call for schedules and event details. This is useful as a fallback for schedules,
but it is unofficial and can change without notice. Treat it as a low-cost
schedule source, not the primary live draft/stats provider.

Useful community starting points:

- `getSchedule`
- `getEventDetails`
- `getLive`

### PandaScore

Strong schedule and esports fixture coverage. Public pricing shows free access
for static/schedule data, while real-time live data is a paid Live API tier.
Good candidate if match schedule quality matters more than low-cost live draft
coverage at first.

### Bayes Esports

Enterprise-grade near-real-time LoL live data. Likely strongest quality for
professional live state, but it is designed for betting/media customers and may
be too heavy for an early prototype.

## Current Decision

For now:

1. Keep Oracle's Elixir as the historical training source.
2. Use Cito-style endpoints as the configurable live/schedule adapter.
3. Fall back to a local `data/raw/today_matches.json` file or latest local match
   rows when no live API key is configured.
4. Add a response normalizer before binding tightly to any single provider.

Next implementation step: once a real API key is available, capture one live or
scheduled response and add provider-specific normalization tests.
