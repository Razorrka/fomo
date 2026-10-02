/* fomo — shared helpers. Everything hangs off window.F so each module stays a plain script (works from file://). */
(function () {
  const F = (window.F = window.F || {});

  F.$ = (s, r = document) => r.querySelector(s);
  F.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  F.esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  F.clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  F.num = (x) => {
    const n = typeof x === 'number' ? x : parseFloat(x);
    return Number.isFinite(n) ? n : null;
  };

  /* ---------- storage (every key prefixed fomo-) ---------- */
  F.store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('fomo-' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('fomo-' + k, JSON.stringify(v));
      } catch (e) {}
    },
    del(k) {
      try {
        localStorage.removeItem('fomo-' + k);
      } catch (e) {}
    },
  };

  /* ---------- event bus ---------- */
  const subs = {};
  F.on = (evt, fn) => (subs[evt] = subs[evt] || []).push(fn);
  F.emit = (evt, data) => (subs[evt] || []).forEach((fn) => {
    try {
      fn(data);
    } catch (e) {
      console.error(evt, e);
    }
  });

  /* ---------- network ---------- */
  F.fetchJSON = async (url, opts = {}, timeout = 12000) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  };

  /* ---------- source health: every feed reports here so staleness is always visible ---------- */
  const health = {};
  F.health = {
    ok(name, note) {
      health[name] = { ok: true, at: Date.now(), note: note || '', err: '' };
      F.emit('health', health);
    },
    fail(name, err) {
      const h = health[name] || {};
      health[name] = { ok: false, at: h.at || 0, note: h.note || '', err: String((err && err.message) || err) };
      F.emit('health', health);
    },
    all: () => health,
  };

  /* ---------- formatting ---------- */
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  // $0.00000443 -> 0.0₅443 (the crypto-native way to show tiny prices without losing digits)
  F.price = (p) => {
    p = F.num(p);
    if (p == null) return '—';
    const a = Math.abs(p);
    if (a >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (a >= 1) return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (a >= 0.01) return p.toFixed(4);
    if (a === 0) return '0';
    const s = a.toFixed(20).slice(2);
    const zeros = s.match(/^0*/)[0].length;
    if (zeros < 4) return p.toFixed(zeros + 4);
    const sig = s.slice(zeros, zeros + 4).replace(/0+$/, '') || '0';
    const z = String(zeros).split('').map((d) => SUB[d]).join('');
    return (p < 0 ? '-' : '') + '0.0' + z + sig;
  };
  F.usd = (n, dp) => {
    n = F.num(n);
    if (n == null) return '—';
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return s + '$' + (a / 1e3).toFixed(1) + 'K';
    // under a dollar, keep up to 4 decimals so a $0.12 trade still shows its fee ($0.1182)
    return s + '$' + a.toLocaleString('en-US', { minimumFractionDigits: dp == null ? 2 : dp, maximumFractionDigits: dp == null ? (a < 1 ? 4 : 2) : dp });
  };
  F.pct = (x, dp = 1) => {
    x = F.num(x);
    if (x == null) return '—';
    const v = Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en-US') : x.toFixed(Math.abs(x) >= 100 ? 0 : dp);
    return (x > 0 ? '+' : '') + v + '%';
  };
  F.dir = (x) => (x > 0 ? 'up' : x < 0 ? 'dn' : 'flat');
  // ▲ 1.15% / ▼ 0.42% — the arrow is drawn by CSS (.chg.up / .chg.dn)
  F.chg = (x, dp = 2) => {
    x = F.num(x);
    if (x == null) return '<span class="chg flat">—</span>';
    const a = Math.abs(x);
    const v = a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toFixed(a >= 100 ? 0 : dp);
    return `<span class="chg ${F.dir(x)}">${v}%</span>`;
  };
  F.ago = (ts) => {
    if (!ts) return '—';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  };
  F.clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

  /* ---------- tiny sparkline (inline SVG) ---------- */
  F.spark = (vals, w = 90, h = 24, cls = '') => {
    const v = vals.filter((x) => Number.isFinite(x));
    if (v.length < 2) return `<svg class="spark ${cls}" width="${w}" height="${h}"></svg>`;
    const lo = Math.min(...v), hi = Math.max(...v), rng = hi - lo || 1;
    const pts = v.map((y, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((y - lo) / rng) * (h - 4)).toFixed(1)}`).join(' ');
    const d = v[v.length - 1] >= v[0] ? 'up' : 'dn';
    return `<svg class="spark ${d} ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}"/></svg>`;
  };

  /* ---------- tickers inside free text ---------- */
  const MAJORS = { bitcoin: 'BTC', ethereum: 'ETH', ether: 'ETH', solana: 'SOL', dogecoin: 'DOGE', ripple: 'XRP', hyperliquid: 'HYPE', cardano: 'ADA', chainlink: 'LINK', tether: 'USDT' };
  const MAJOR_SYMS = new Set(['BTC', 'ETH', 'SOL', 'DOGE', 'XRP', 'HYPE', 'BNB', 'ADA', 'LINK', 'PEPE', 'BONK', 'WIF', 'SHIB', 'TRUMP', 'PENGU', 'FARTCOIN', 'POPCAT', 'SUI', 'TON', 'AVAX', 'LTC', 'ZEC']);
  F.tickers = (text) => {
    const out = new Set();
    const t = String(text || '');
    // cashtags: $SOL, $PENGU — but not $100 or $1.2B
    (t.match(/\$[A-Za-z][A-Za-z0-9]{1,11}\b/g) || []).forEach((m) => out.add(m.slice(1).toUpperCase()));
    // #BTC style hashtags only for known symbols (hashtags are too noisy otherwise)
    (t.match(/#[A-Za-z]{2,10}\b/g) || []).forEach((m) => {
      const s = m.slice(1).toUpperCase();
      if (MAJOR_SYMS.has(s)) out.add(s);
    });
    // bare uppercase majors, and the long names
    (t.match(/\b[A-Z]{2,8}\b/g) || []).forEach((m) => {
      if (MAJOR_SYMS.has(m)) out.add(m);
    });
    const low = t.toLowerCase();
    for (const k in MAJORS) if (new RegExp('\\b' + k + '\\b').test(low)) out.add(MAJORS[k]);
    out.delete('USD');
    return [...out].slice(0, 8);
  };

  /* ---------- heuristic sentiment (used when AI is off; labelled as heuristic in the UI) ---------- */
  const BULL = ['moon', 'mooning', 'pump', 'pumping', 'pumps', 'rally', 'rallies', 'rallying', 'surge', 'surges', 'surging', 'soar', 'soars', 'soaring', 'breakout', 'ath', 'all-time high', 'record high', 'bullish', 'ape', 'aped', 'send it', 'sending', 'ripping', 'gains', 'accumulate', 'accumulating', 'accumulation', 'inflows', 'approved', 'approval', 'adoption', 'partnership', 'jumps', 'climbs', 'rebound', 'rebounds', 'outperform', '🚀', '📈', '🟢', '💎'];
  const BEAR = ['dump', 'dumping', 'dumps', 'crash', 'crashes', 'crashed', 'plunge', 'plunges', 'plunged', 'tank', 'tanks', 'tanked', 'slump', 'slumps', 'falls', 'drops', 'sinks', 'rug', 'rugged', 'rugpull', 'rug pull', 'scam', 'hack', 'hacked', 'exploit', 'exploited', 'drained', 'stolen', 'bearish', 'rekt', 'liquidated', 'liquidations', 'sell-off', 'selloff', 'outflows', 'lawsuit', 'sues', 'fraud', 'delist', 'delisted', 'collapse', 'warning', '📉', '🔴', '💀'];
  const re = (list) => new RegExp('(^|[^a-z])(' + list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=$|[^a-z])', 'gi');
  const BULL_RE = re(BULL), BEAR_RE = re(BEAR);
  F.sentiment = (text) => {
    const t = String(text || '');
    const b = (t.match(BULL_RE) || []).length, s = (t.match(BEAR_RE) || []).length;
    const raw = b - s;
    return F.clamp(raw, -2, 2);
  };

  F.uid = () => Math.random().toString(36).slice(2, 10);
  F.hash = (s) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36);
  };
})();
