/* fomo — meme radar.
   Universe = organic trending pools (GeckoTerminal) + paid promotions (DexScreener boosts/profiles, labelled as paid).
   Every token is re-priced from DexScreener every 20s, scored for FOMO (momentum + flow + buzz) and for RUG RISK
   (liquidity, age, dumps, honeypot signs, liquidity pulls). The two scores are deliberately separate. */
(function () {
  const F = window.F;

  const GT2DS = { solana: 'solana', eth: 'ethereum', base: 'base', bsc: 'bsc', arbitrum: 'arbitrum', polygon_pos: 'polygon', avax: 'avalanche', ton: 'ton', 'sui-network': 'sui', tron: 'tron', robinhood: 'robinhood', hyperevm: 'hyperevm', abstract: 'abstract', sonic: 'sonic', unichain: 'unichain', optimism: 'optimism', blast: 'blast', linea: 'linea', near: 'near', monad: 'monad' };
  const DS2GT = Object.fromEntries(Object.entries(GT2DS).map(([a, b]) => [b, a]));
  const SKIP = new Set(['SOL', 'WSOL', 'ETH', 'WETH', 'USDC', 'USDT', 'BTC', 'WBTC', 'CBBTC', 'BNB', 'WBNB', 'DAI', 'USDE', 'USD1', 'PYUSD', 'FDUSD', 'USDS', 'STETH', 'WSTETH', 'JITOSOL', 'MSOL', 'WHYPE', 'TRX', 'WTRX', 'POL', 'WPOL', 'AVAX', 'WAVAX', 'SUI', 'TON']);
  const EXPLORER = { solana: 'https://solscan.io/token/', ethereum: 'https://etherscan.io/token/', base: 'https://basescan.org/token/', bsc: 'https://bscscan.com/token/', arbitrum: 'https://arbiscan.io/token/' };
  const CHAIN_EMOJI = { solana: '◎', ethereum: 'Ξ', base: '🔵', bsc: '🟡', robinhood: '🪶', arbitrum: '🔷', ton: '💎', sui: '💧', tron: '🔺', near: 'Ⓝ' };

  const tokens = new Map(); // key chain:addr
  const keyOf = (chain, addr) => chain + ':' + (/^0x/i.test(addr) ? addr.toLowerCase() : addr);

  function ensure(chain, addr, seed) {
    const k = keyOf(chain, addr);
    let t = tokens.get(k);
    if (!t) {
      t = {
        key: k, chain, addr, sym: '?', name: '', icon: '', price: null,
        ch: {}, vol: {}, tx: {}, liq: null, liqMax: null, fdv: null, mcap: null, created: null,
        boost: 0, src: new Set(), firstSeen: Date.now(), lastListed: Date.now(), at: 0, hist: [],
        risk: 0, flags: [], fomo: 0, tier: '', buzz: 0, pairUrl: '', gtPool: '', socials: [], websites: [],
      };
      tokens.set(k, t);
    }
    Object.assign(t, seed || {});
    t.lastListed = Date.now();
    return t;
  }
  const tx = (o) => ({ b: (o && o.buys) || 0, s: (o && o.sells) || 0 });
  function pushHist(t) {
    if (t.price == null) return;
    const last = t.hist[t.hist.length - 1];
    if (!last || Date.now() - last[0] > 15000) t.hist.push([Date.now(), t.price]);
    if (t.hist.length > 120) t.hist.shift();
  }

  /* ---------------- GeckoTerminal: organic trending ---------------- */
  // GeckoTerminal's free API allows ~30 calls/min per IP and answers 429s without CORS headers, so the browser
  // only sees "Failed to fetch". Every GT call goes through this gate: a local cap, plus exponential backoff
  // (15s, 30s, 60s … 5 min) after any failure so the app never hammers it.
  const GT = { until: 0, fails: 0, stamps: [] };
  F.gtFetch = async (url) => {
    const now = Date.now();
    if (now < GT.until) throw new Error(`rate-limited, retrying in ${Math.ceil((GT.until - now) / 1000)}s`);
    GT.stamps = GT.stamps.filter((t) => now - t < 60000);
    if (GT.stamps.length >= 20) throw new Error('pausing to stay under the rate limit');
    GT.stamps.push(now);
    try {
      const d = await F.fetchJSON(url, { headers: { accept: 'application/json' } });
      GT.fails = 0;
      return d;
    } catch (e) {
      GT.fails++;
      GT.until = Date.now() + Math.min(300000, 15000 * 2 ** (GT.fails - 1));
      throw e;
    }
  };
  async function pollGT() {
    const urls = [
      'https://api.geckoterminal.com/api/v2/networks/trending_pools?include=base_token&duration=1h',
      'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&duration=5m',
    ];
    for (const u of urls) {
      try {
        const d = await F.gtFetch(u);
        const inc = Object.fromEntries((d.included || []).map((x) => [x.id, x.attributes]));
        d.data.forEach((pool) => {
          const tid = pool.relationships.base_token.data.id;
          const ta = inc[tid];
          if (!ta || SKIP.has(String(ta.symbol).toUpperCase())) return;
          const gtNet = tid.slice(0, tid.length - ta.address.length - 1);
          const chain = GT2DS[gtNet] || gtNet;
          const a = pool.attributes;
          const t = ensure(chain, ta.address, { gtNet, gtPool: a.address });
          t.src.add('trending');
          if (t.sym === '?') t.sym = ta.symbol;
          if (!t.name) t.name = ta.name;
          if (!t.icon && ta.image_url && !/missing/.test(ta.image_url)) t.icon = ta.image_url;
          // Only use GeckoTerminal numbers when DexScreener hasn't priced this token recently.
          if (Date.now() - t.at > 120000) {
            const pc = a.price_change_percentage || {}, vu = a.volume_usd || {}, tr = a.transactions || {};
            t.price = F.num(a.base_token_price_usd);
            t.ch = { m5: F.num(pc.m5), h1: F.num(pc.h1), h6: F.num(pc.h6), h24: F.num(pc.h24) };
            t.vol = { m5: F.num(vu.m5), h1: F.num(vu.h1), h6: F.num(vu.h6), h24: F.num(vu.h24) };
            t.tx = { m5: tx(tr.m5), h1: tx(tr.h1), h6: tx(tr.h6), h24: tx(tr.h24) };
            t.liq = F.num(a.reserve_in_usd);
            t.fdv = F.num(a.fdv_usd);
            t.mcap = F.num(a.market_cap_usd);
            t.created = Date.parse(a.pool_created_at) || t.created;
            t.at = Date.now();
            t.via = 'GeckoTerminal';
            pushHist(t);
          }
        });
        F.health.ok('geckoterminal');
      } catch (e) {
        F.health.fail('geckoterminal', e);
        break; // don't fire the second call into a rate limit
      }
    }
    finish();
  }

  /* ---------------- DexScreener: paid boosts + new profiles ---------------- */
  async function pollBoosts() {
    const feeds = [
      ['https://api.dexscreener.com/token-boosts/top/v1', 'boost'],
      ['https://api.dexscreener.com/token-boosts/latest/v1', 'boost'],
      ['https://api.dexscreener.com/token-profiles/latest/v1', 'profile'],
    ];
    for (const [u, tag] of feeds) {
      try {
        const d = await F.fetchJSON(u);
        d.slice(0, 30).forEach((x) => {
          if (!x.tokenAddress || !x.chainId) return;
          const t = ensure(x.chainId, x.tokenAddress);
          t.src.add(tag);
          if (x.icon && !t.icon) t.icon = /^https?:/.test(x.icon) ? x.icon : `https://cdn.dexscreener.com/cms/images/${x.icon}?width=64&height=64&fit=crop&quality=95&format=auto`;
          if (x.totalAmount) t.boostTotal = x.totalAmount;
        });
        F.health.ok('dexscreener');
      } catch (e) {
        F.health.fail('dexscreener', e);
      }
    }
    await refreshDS();
  }

  /* ---------------- DexScreener: live re-pricing of the whole universe ---------------- */
  let refreshing = false;
  async function refreshDS() {
    if (refreshing) return;
    refreshing = true;
    try {
      const byChain = {};
      tokens.forEach((t) => (byChain[t.chain] = byChain[t.chain] || []).push(t));
      const jobs = [];
      for (const chain in byChain) {
        const list = byChain[chain];
        for (let i = 0; i < list.length; i += 30) jobs.push([chain, list.slice(i, i + 30)]);
      }
      await Promise.all(
        jobs.map(async ([chain, list]) => {
          try {
            const pairs = await F.fetchJSON(`https://api.dexscreener.com/tokens/v1/${chain}/${list.map((t) => t.addr).join(',')}`);
            const best = {};
            (pairs || []).forEach((pr) => {
              const k = keyOf(chain, pr.baseToken.address);
              const liq = (pr.liquidity && pr.liquidity.usd) || 0;
              if (!best[k] || liq > ((best[k].liquidity && best[k].liquidity.usd) || 0)) best[k] = pr;
            });
            list.forEach((t) => {
              const pr = best[t.key];
              if (pr) applyDS(t, pr);
            });
            F.health.ok('dexscreener', 'pricing ' + tokens.size + ' tokens');
          } catch (e) {
            F.health.fail('dexscreener', e);
          }
        })
      );
    } finally {
      refreshing = false;
      F.radar.lastRefresh = Date.now();
      finish();
    }
  }
  function applyDS(t, pr) {
    const pc = pr.priceChange || {}, v = pr.volume || {}, x = pr.txns || {};
    t.sym = pr.baseToken.symbol || t.sym;
    t.name = pr.baseToken.name || t.name;
    t.price = F.num(pr.priceUsd);
    t.ch = { m5: F.num(pc.m5), h1: F.num(pc.h1), h6: F.num(pc.h6), h24: F.num(pc.h24) };
    t.vol = { m5: F.num(v.m5), h1: F.num(v.h1), h6: F.num(v.h6), h24: F.num(v.h24) };
    t.tx = { m5: tx(x.m5), h1: tx(x.h1), h6: tx(x.h6), h24: tx(x.h24) };
    t.liq = pr.liquidity ? F.num(pr.liquidity.usd) : null;
    t.fdv = F.num(pr.fdv);
    t.mcap = F.num(pr.marketCap);
    t.created = pr.pairCreatedAt || t.created;
    t.dex = pr.dexId;
    t.pairUrl = pr.url;
    t.pair = pr.pairAddress;
    t.quote = pr.quoteToken && pr.quoteToken.symbol;
    t.boost = (pr.boosts && pr.boosts.active) || 0;
    const info = pr.info || {};
    if (info.imageUrl) t.icon = info.imageUrl;
    t.socials = info.socials || t.socials;
    t.websites = info.websites || t.websites;
    t.at = Date.now();
    t.via = 'DexScreener';
    pushHist(t);
  }

  /* ---------------- scoring ---------------- */
  // Execution slippage of a $x market order against a constant-product pool holding liq/2 on each side.
  F.slip = (x, liq) => (liq > 0 ? x / (liq / 2 + x) : 1);

  function assess(t) {
    const flags = [];
    let risk = 0;
    const liq = t.liq || 0;
    const ageH = t.created ? (Date.now() - t.created) / 3600000 : null;
    const h1 = t.tx.h1 || { b: 0, s: 0 }, m5 = t.tx.m5 || { b: 0, s: 0 };
    if (t.liq == null) {
      flags.push(['crit', '❓', 'Liquidity not reported (bonding curve or unindexed pool) — there is no way to size an exit']);
      risk += 35;
    } else if (liq < 10000) {
      flags.push(['crit', '💧', `Liquidity only ${F.usd(liq)} — a $500 sell slips ~${(F.slip(500, liq) * 100).toFixed(0)}%`]);
      risk += 40;
    } else if (liq < 50000) {
      flags.push(['warn', '💧', `Thin liquidity (${F.usd(liq)}) — a $1K sell slips ~${(F.slip(1000, liq) * 100).toFixed(1)}%`]);
      risk += 16;
    }
    if (ageH != null) {
      if (ageH < 1) {
        flags.push(['crit', '🍼', `Pool born ${Math.max(1, Math.round(ageH * 60))} min ago`]);
        risk += 25;
      } else if (ageH < 6) {
        flags.push(['warn', '🍼', `Pool under 6h old (${ageH.toFixed(1)}h)`]);
        risk += 12;
      }
    }
    const worst = Math.min(t.ch.h6 == null ? 0 : t.ch.h6, t.ch.h24 == null ? 0 : t.ch.h24);
    if (worst <= -50) {
      flags.push(['crit', '📉', `Already dumped ${F.pct(worst, 0)}`]);
      risk += 25;
    } else if (worst <= -25) {
      flags.push(['warn', '📉', `Down ${F.pct(worst, 0)} recently`]);
      risk += 10;
    }
    if (h1.b >= 20 && h1.s === 0) {
      flags.push(['crit', '🍯', `${h1.b} buys and zero sells in the last hour — possible honeypot (you may not be able to sell)`]);
      risk += 45;
    }
    if (t.fdv && liq && t.fdv / liq > 80) {
      flags.push(['warn', '🎈', `Valued ${F.usd(t.fdv)} on ${F.usd(liq)} liquidity (${Math.round(t.fdv / liq)}×) — exits are thin`]);
      risk += 10;
    }
    if (t.vol.h24 != null && t.vol.h24 < 20000) {
      flags.push(['warn', '😴', `Barely trades (${F.usd(t.vol.h24)} in 24h)`]);
      risk += 10;
    }
    // Liquidity-pull tracking uses DexScreener's deepest pair only; GeckoTerminal may report a different, smaller pool.
    if (t.via === 'DexScreener') {
      if (t.liqMax && liq < t.liqMax * 0.6) {
        flags.push(['crit', '🚨', `Liquidity pulled ${F.pct((liq / t.liqMax - 1) * 100, 0)} since fomo started watching`]);
        t.pulled = true;
        risk += 40;
      } else t.pulled = false;
      t.liqMax = Math.max(t.liqMax || 0, liq);
    }
    if ((t.src.has('boost') || t.src.has('profile')) && !t.src.has('trending')) {
      flags.push(['info', '💸', 'Paid DexScreener promotion, not organic trending']);
      risk += 4;
    }
    if (Date.now() - t.at > 180000) flags.push(['info', '⏳', `Price is ${F.ago(t.at)} old`]);
    t.flags = flags;
    t.risk = F.clamp(Math.round(risk), 0, 100);

    // FOMO: is money and attention rushing in right now? (not a prediction — the bot's track record is the judge)
    const c5 = t.ch.m5 || 0, c1 = t.ch.h1 || 0;
    const mom = Math.tanh((c5 * 1.5 + c1 * 0.5) / 20);
    const vm5 = t.vol.m5 || 0, v1 = t.vol.h1 || 0, v6 = t.vol.h6 || 0;
    const accel = Math.tanh((0.6 * Math.log2((vm5 * 12 + 50) / (v1 + 50)) + 0.4 * Math.log2((v1 * 6 + 50) / (v6 + 50))) / 1.5);
    const bp = (h1.b + 2 * m5.b + 1) / (h1.b + h1.s + 2 * (m5.b + m5.s) + 2);
    const ment = F.social ? F.social.mentions(t.sym) : [];
    t.buzz = ment.length;
    const buzzSent = ment.length ? ment.reduce((s, p) => s + F.social.score(p), 0) / ment.length : 0;
    const overext = c1 > 150 ? Math.min(1, (c1 - 150) / 150) : 0;
    let fomo = 50 + 20 * mom + 14 * accel + 30 * (bp - 0.5) + 10 * Math.min(1, t.buzz / 4) + 2.5 * buzzSent - 12 * overext;
    if (h1.b + h1.s < 30) fomo = 50 + (fomo - 50) * 0.6; // quiet tokens can't be FOMO
    t.fomo = F.clamp(Math.round(fomo), 0, 100);
    t.parts = { mom, accel, bp, buzz: t.buzz, overext };
    t.tier = t.fomo >= 75 ? '🚀' : t.fomo >= 62 ? '🔥' : t.fomo >= 45 ? '👀' : '🧊';
  }

  function prune() {
    const held = F.bot ? F.bot.heldKeys() : new Set();
    tokens.forEach((t, k) => {
      if (!held.has(k) && Date.now() - t.lastListed > 45 * 60000) tokens.delete(k);
      else if (t.price == null && Date.now() - t.firstSeen > 10 * 60000 && !held.has(k)) tokens.delete(k);
    });
  }

  function finish() {
    prune();
    tokens.forEach(assess);
    F.emit('radar', null);
  }

  F.radar = {
    tokens,
    EXPLORER, CHAIN_EMOJI, DS2GT,
    get: (k) => tokens.get(k),
    list: () => [...tokens.values()].filter((t) => t.price != null),
    topSyms(n) {
      return this.list().filter((t) => t.risk < 60 && /^[A-Za-z0-9]{3,10}$/.test(t.sym)).sort((a, b) => b.fomo - a.fomo).slice(0, n).map((t) => t.sym.toUpperCase());
    },
    links(t) {
      const out = [];
      if (t.pairUrl) out.push(['DexScreener', t.pairUrl]);
      const gtNet = t.gtNet || DS2GT[t.chain];
      if (gtNet && t.gtPool) out.push(['GeckoTerminal', `https://www.geckoterminal.com/${gtNet}/pools/${t.gtPool}`]);
      if (EXPLORER[t.chain]) out.push(['Explorer', EXPLORER[t.chain] + t.addr]);
      if (t.chain === 'solana') out.push(['RugCheck', 'https://rugcheck.xyz/tokens/' + t.addr]);
      (t.websites || []).slice(0, 1).forEach((w) => out.push(['Website', w.url]));
      (t.socials || []).slice(0, 2).forEach((s) => out.push([s.type === 'twitter' ? 'X' : s.type || 'Social', s.url]));
      return out;
    },
    start() {
      pollGT();
      pollBoosts();
      setInterval(pollGT, 60000);
      setInterval(pollBoosts, 90000);
      setInterval(refreshDS, 8000); // DexScreener allows 300 req/min on this endpoint; ~4 batches every 8s
      F.radar.lastRefresh = 0;
    },
  };
})();
