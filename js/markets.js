/* fomo — markets: Coinbase websocket for crypto (tick-level), Hyperliquid stock perps for equities, fear & greed. */
(function () {
  const F = window.F;

  /* ---------------- crypto: Coinbase Exchange public websocket ---------------- */
  const COINS = [
    ['BTC', 'Bitcoin'], ['ETH', 'Ethereum'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['DOGE', 'Dogecoin'], ['HYPE', 'Hyperliquid'],
    ['PEPE', 'Pepe'], ['BONK', 'Bonk'], ['WIF', 'dogwifhat'], ['SHIB', 'Shiba Inu'], ['FARTCOIN', 'Fartcoin'], ['PENGU', 'Pudgy Penguins'], ['TRUMP', 'Official Trump'], ['POPCAT', 'Popcat'],
  ];
  const MEME = new Set(['DOGE', 'PEPE', 'BONK', 'WIF', 'SHIB', 'FARTCOIN', 'PENGU', 'TRUMP', 'POPCAT']);
  const crypto = {}; // sym -> {sym, name, price, open, vol, at, hist:[]}
  COINS.forEach(([s, n]) => (crypto[s] = { sym: s, name: n, meme: MEME.has(s), price: null, open: null, vol: null, at: 0, hist: [] }));

  let ws, wsBackoff = 1000, lastMsg = 0;
  function connectWS() {
    try {
      ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    } catch (e) {
      F.health.fail('coinbase', e);
      return setTimeout(connectWS, wsBackoff);
    }
    ws.onopen = () => {
      wsBackoff = 1000;
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: COINS.map(([s]) => s + '-USD'), channels: ['ticker'] }));
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.type !== 'ticker') return;
      const c = crypto[m.product_id.replace('-USD', '')];
      if (!c) return;
      const p = +m.price;
      const prev = c.price;
      c.price = p;
      c.open = +m.open_24h;
      c.vol = +m.volume_24h * p;
      c.at = Date.now();
      lastMsg = c.at;
      if (!c.hist.length || c.at - c.hist[c.hist.length - 1][0] > 15000) {
        c.hist.push([c.at, p]);
        if (c.hist.length > 240) c.hist.shift();
      }
      F.health.ok('coinbase', 'websocket live');
      F.emit('tick', { sym: c.sym, price: p, prev });
    };
    ws.onclose = () => {
      F.health.fail('coinbase', 'websocket closed — reconnecting');
      setTimeout(connectWS, (wsBackoff = Math.min(wsBackoff * 2, 30000)));
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch (e) {}
    };
  }

  // REST snapshot so the tape is filled before the first tick, and a fallback when the socket is quiet.
  async function snapshot() {
    await Promise.all(
      COINS.map(async ([s]) => {
        try {
          const d = await F.fetchJSON(`https://api.exchange.coinbase.com/products/${s}-USD/stats`);
          const c = crypto[s];
          if (!c.at || Date.now() - c.at > 60000) {
            c.price = +d.last;
            c.open = +d.open;
            c.vol = +d.volume * +d.last;
            c.at = Date.now();
          }
        } catch (e) {}
      })
    );
    F.emit('markets', null);
  }

  /* ---------------- stocks: Hyperliquid "xyz" stock perps (24/7, keyless) ---------------- */
  // These are perpetual futures that track the stock via an oracle. During NYSE hours the oracle follows the real
  // tape closely; nights and weekends the perp keeps trading and can drift from the last close. The UI says so.
  const STOCKS = [
    ['SP500', 'S&P 500'], ['XYZ100', 'Nasdaq-100'], ['NVDA', 'Nvidia'], ['TSLA', 'Tesla'], ['AAPL', 'Apple'], ['MSFT', 'Microsoft'],
    ['META', 'Meta'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'], ['AMD', 'AMD'], ['PLTR', 'Palantir'], ['COIN', 'Coinbase'],
    ['HOOD', 'Robinhood'], ['MSTR', 'Strategy'], ['CRCL', 'Circle'], ['GME', 'GameStop'], ['GOLD', 'Gold'],
  ];
  const stocks = {};
  STOCKS.forEach(([s, n]) => (stocks[s] = { sym: s, name: n, price: null, prev: null, oracle: null, vol: null, at: 0, hist: [] }));

  async function pollStocks() {
    try {
      const [meta, ctxs] = await F.fetchJSON('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: 'xyz' }),
      });
      meta.universe.forEach((u, i) => {
        const s = stocks[u.name.replace('xyz:', '')];
        const x = ctxs[i];
        if (!s || !x || u.isDelisted) return;
        if (Date.now() - (s.wsAt || 0) > 30000) s.price = +x.markPx; // the websocket owns the live price
        s.oracle = +x.oraclePx;
        s.prev = +x.prevDayPx;
        s.vol = +x.dayNtlVlm;
        s.at = Date.now();
        s.hist.push([s.at, s.price]);
        if (s.hist.length > 240) s.hist.shift();
      });
      F.health.ok('hyperliquid', 'stock perps');
      F.emit('markets', null);
    } catch (e) {
      F.health.fail('hyperliquid', e);
    }
  }

  // Live stock prices: Hyperliquid pushes mid prices for the whole xyz stock-perp book over a websocket.
  let hl, hlBack = 1000;
  function connectHL() {
    try {
      hl = new WebSocket('wss://api.hyperliquid.xyz/ws');
    } catch (e) {
      return setTimeout(connectHL, hlBack);
    }
    hl.onopen = () => {
      hlBack = 1000;
      hl.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids', dex: 'xyz' } }));
    };
    hl.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (m.channel !== 'allMids' || !m.data || !m.data.mids) return;
      const now = Date.now();
      for (const k in m.data.mids) {
        const s = stocks[k.replace('xyz:', '')];
        if (!s) continue;
        const p = +m.data.mids[k];
        s.wsAt = now;
        if (p === s.price) continue;
        const prev = s.price;
        s.price = p;
        s.at = now;
        if (!s.hist.length || now - s.hist[s.hist.length - 1][0] > 15000) {
          s.hist.push([now, p]);
          if (s.hist.length > 240) s.hist.shift();
        }
        F.emit('stocktick', { sym: s.sym, price: p, prev });
      }
      F.health.ok('hyperliquid', 'live stream');
    };
    hl.onclose = () => setTimeout(connectHL, (hlBack = Math.min(hlBack * 2, 30000)));
    hl.onerror = () => {
      try {
        hl.close();
      } catch (e) {}
    };
  }

  /* ---------------- NYSE session (with the 2026–27 holiday calendar) ---------------- */
  const HOLIDAYS = new Set(['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
    '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
  const EARLY = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);
  F.nyse = () => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
        .formatToParts(new Date()).map((p) => [p.type, p.value])
    );
    const ymd = `${parts.year}-${parts.month}-${parts.day}`;
    const mins = +parts.hour * 60 + +parts.minute;
    const close = EARLY.has(ymd) ? 13 * 60 : 16 * 60;
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return { open: false, label: 'weekend' };
    if (HOLIDAYS.has(ymd)) return { open: false, label: 'holiday' };
    if (mins >= 570 && mins < close) return { open: true, label: 'open' };
    if (mins >= 240 && mins < 570) return { open: false, label: 'pre-market' };
    if (mins >= close && mins < 1200) return { open: false, label: 'after hours' };
    return { open: false, label: 'closed' };
  };

  /* ---------------- sentiment gauges ---------------- */
  const gauges = { fng: null, fngLabel: '', fngAt: 0, mcapChg: null, btcDom: null, mcap: null, globalAt: 0 };
  async function pollFng() {
    try {
      const d = await F.fetchJSON('https://api.alternative.me/fng/?limit=1');
      gauges.fng = +d.data[0].value;
      gauges.fngLabel = d.data[0].value_classification;
      gauges.fngAt = Date.now();
      F.health.ok('feargreed');
      F.emit('markets', null);
    } catch (e) {
      F.health.fail('feargreed', e);
    }
  }
  async function pollGlobal() {
    try {
      const d = (await F.fetchJSON('https://api.coingecko.com/api/v3/global')).data;
      gauges.mcap = d.total_market_cap.usd;
      gauges.mcapChg = d.market_cap_change_percentage_24h_usd;
      gauges.btcDom = d.market_cap_percentage.btc;
      gauges.globalAt = Date.now();
      F.health.ok('coingecko');
      F.emit('markets', null);
    } catch (e) {
      F.health.fail('coingecko', e);
    }
  }

  F.markets = {
    crypto, stocks, gauges, COINS, STOCKS,
    chg: (o) => (o.price != null && (o.open || o.prev) ? (o.price / (o.open || o.prev) - 1) * 100 : null),
    wsAge: () => (lastMsg ? Date.now() - lastMsg : Infinity),
    start() {
      snapshot();
      connectWS();
      pollStocks();
      connectHL();
      pollFng();
      pollGlobal();
      setInterval(pollStocks, 30000);
      setInterval(pollFng, 30 * 60000);
      setInterval(pollGlobal, 5 * 60000);
      setInterval(() => {
        if (F.markets.wsAge() > 60000) snapshot();
      }, 30000);
    },
  };
})();
