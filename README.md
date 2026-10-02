# fomo radar 🚀

Live companion to the fomo app: crypto news without X or Discord, a meme-coin radar with rug checks, stocks, and a paper-trading bot. 

**Live:** https://razorrka.github.io/fomo/ · or double-click `index.html`. No install, no build, no keys required.

## What's on screen

| Panel | What it does | Live source |
|---|---|---|
| 📡 **The Feed** | "Crypto Twitter, minus Twitter." Verified outlets (Whale Alert, Watcher Guru, Decrypt, Protos, Web3 Is Going Great, Polymarket) + market stories from Bloomberg, Reuters, WSJ, Yahoo Finance, CNBC, MarketWatch, Fortune + crowd chatter, spam-filtered. Whale bursts and repeat posts fold into compact stacks | Bluesky, Mastodon, RSS: CoinDesk, The Block, Cointelegraph, Bitcoin Magazine, CryptoSlate, The Defiant, Unchained, MarketWatch |
| 🧠 **fomo brief** | What's moving and why, every claim cited to a post or data row. Ask fomo anything | Claude (optional key) — otherwise an auto-summary |
| 🔥 **Meme Radar** | Trending + promoted meme coins, re-priced every 20s, scored for **FOMO** (momentum + flow + buzz) and **rug risk** separately. Click any token for 5-minute candles, buy/sell flow and risk flags | GeckoTerminal (organic + candles), DexScreener (prices + paid boosts) |
| 📈 **Markets** | Majors + big memes and stocks, both streaming tick-by-tick | Coinbase websocket, Hyperliquid websocket (24/7 stock perps) |
| 🤖 **fomo bot** | Paper-trading agent: any starting balance, auto % or fixed $ per trade, risk dial, live activity, positions, scoreboard; optional Claude risk officer that can veto entries | everything above |

## Files

```
index.html     shell + panel markup
fomo.css       all styles (tokens at the top)
js/util.js     F.* helpers: fetch, storage (fomo- prefix), event bus, formatting, ticker + sentiment parsing, source health
js/markets.js  Coinbase WS, Hyperliquid stock perps, NYSE session + holidays, Fear & Greed, CoinGecko global
js/social.js   feed intake: outlets, crowd search, Mastodon, RSS → normalize → spam/dup/impostor filter → classify
js/radar.js    token universe, DexScreener re-pricing, risk flags, FOMO score
js/bot.js      paper-trading agent: presets, gates, entries, exits, cost model, stats, its own panel
js/ai.js       Claude: feed tagging, brief, bot risk officer, ask; spend meter + daily cap; settings
js/panels.js   rendering: feed, radar, markets tape, token drawer
js/app.js      boot order, modals, toasts, mobile tabs
```

Modules talk through `F.emit / F.on` events: `social`, `radar`, `markets`, `tick`, `health`, `bot:trade`, `open-token`.

## Extending

- **New feed source**: add a `pollX()` in `social.js` that builds the normalized post object (see `fromBsky`) and passes it through `add(p, crowd)`; schedule it in `F.social.start`.
- **New bot strategy**: add a preset in `PRESETS` (bot.js). Hard safety gates live in `gate()`; exits in `manage()`.
- **New AI job**: write a JSON schema + `call({ system, user, schema, effort })` in `ai.js`. Build its input from `snapshot()` so Claude only ever sees live data.

## Guardrails (keep these)

- Every post links to its original; outlets are matched by verified domain handle; impostor names are dropped.
- Claude gets only the snapshot; citations that don't exist are stripped; tickers not in the data are dropped.
- Paid DexScreener promotion is always labelled 💸.
- The bot is paper only. Fills pay 0.3% fee + constant-product slippage against real pool liquidity + per-chain gas, in and out. Trades where gas would eat >5% are skipped. Positions are valued at liquidation price. Scoreboard starts at zero.
