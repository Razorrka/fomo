/* fomo — the signal engine. Turns every radar token into a call: Worth buying / Wait / Not worth it,
   with a probability, an expected value after fees, exact entry / stop / targets, and the reasons.

   The science, in order:
     1. Eleven measured factors, each scaled to −1…+1 (momentum, volume acceleration, order flow, unique traders,
        live tape trend, candle trend, RSI heat, liquidity depth, contract & holder safety, social buzz, exhaustion).
     2. A logistic model turns them into P(hit target before stop). It starts from hand-set priors and learns
        from its own graded calls (step 4) — shrunk toward the priors so a short streak can't swing it.
     3. Exits scale with the coin's own volatility (5-minute ATR), and the call only says "Worth buying" when the
        expected value after fomo's fee and slippage is positive.
     4. Every "Worth buying" call is logged and graded automatically against the live price: target hit, stop hit,
        or timed out after 2h. The scoreboard is the proof — nothing is backfilled.
   Probabilities are capped at 85%: no meme coin call deserves more certainty than that. */
(function () {
  const F = window.F;

  /* ================= deep safety: RugCheck (Solana) · GoPlus (EVM) ================= */
  const GOPLUS_CHAIN = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, avalanche: 43114, optimism: 10 };
  const safetyCache = new Map(F.store.get('safety', []));
  const safetyQ = [];
  let safetyBusy = false;
  const canCheck = (t) => t.chain === 'solana' || GOPLUS_CHAIN[t.chain];
  function wantSafety(t) {
    if (!canCheck(t)) return;
    const c = safetyCache.get(t.key);
    if (c && Date.now() - c.at < 10 * 60000) return;
    if (!safetyQ.includes(t.key)) safetyQ.push(t.key);
  }
  async function rugcheck(t) {
    const d = await F.fetchJSON(`https://api.rugcheck.xyz/v1/tokens/${t.addr}/report`, {}, 15000);
    const known = d.knownAccounts || {};
    const isPool = (h) => [h.owner, h.address].some((a) => known[a] && known[a].type === 'AMM');
    const holders = (d.topHolders || []).filter((h) => !isPool(h));
    const sum = (list) => list.reduce((s, h) => s + (h.pct || 0), 0);
    const supply = d.token && +d.token.supply;
    return {
      src: 'RugCheck',
      top10: sum(holders.slice(0, 10)),
      topHolder: holders[0] ? holders[0].pct : 0,
      holders: d.totalHolders || null,
      mint: !!d.mintAuthority,
      freeze: !!d.freezeAuthority,
      lpLocked: Math.max(0, ...(d.markets || []).map((m) => (m.lp && m.lp.lpLockedPct) || 0)),
      insiderPct: sum(holders.filter((h) => h.insider)),
      insiderWallets: d.graphInsidersDetected || 0,
      creatorPct: supply && d.creatorBalance ? (d.creatorBalance / supply) * 100 : 0,
      rugged: !!d.rugged,
      sellTax: (d.transferFee && d.transferFee.pct) || 0,
      honeypot: false,
      launchpad: d.launchpad && d.launchpad.name,
    };
  }
  async function goplus(t) {
    const d = await F.fetchJSON(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS_CHAIN[t.chain]}?contract_addresses=${t.addr}`);
    const r = d.result && (d.result[t.addr.toLowerCase()] || Object.values(d.result)[0]);
    if (!r) return null;
    const holders = (r.holders || []).filter((h) => !+h.is_locked && !+h.is_contract && !/pool|pair|lp|uniswap|pancake|aerodrome|null|dead/i.test(h.tag || ''));
    const pct = (h) => +h.percent * 100 || 0;
    return {
      src: 'GoPlus',
      top10: holders.slice(0, 10).reduce((s, h) => s + pct(h), 0),
      topHolder: holders[0] ? pct(holders[0]) : 0,
      holders: +r.holder_count || null,
      mint: r.is_mintable === '1',
      freeze: r.transfer_pausable === '1' || r.is_blacklisted === '1',
      lpLocked: (r.lp_holders || []).filter((h) => +h.is_locked).reduce((s, h) => s + pct(h), 0),
      insiderPct: 0,
      insiderWallets: 0,
      creatorPct: +r.creator_percent * 100 || 0,
      rugged: false,
      honeypot: r.is_honeypot === '1' || r.cannot_sell_all === '1',
      sellTax: (+r.sell_tax || 0) * 100,
      buyTax: (+r.buy_tax || 0) * 100,
      hiddenOwner: r.hidden_owner === '1' || r.owner_change_balance === '1',
    };
  }
  async function pumpSafety() {
    if (safetyBusy || !safetyQ.length) return;
    safetyBusy = true;
    // most promising coin first, not first-come
    safetyQ.sort((a, b) => ((F.radar.get(b) || {}).sig || { p: 0 }).p - ((F.radar.get(a) || {}).sig || { p: 0 }).p);
    const t = F.radar.get(safetyQ.shift());
    try {
      if (t) {
        const s = t.chain === 'solana' ? await rugcheck(t) : await goplus(t);
        safetyCache.set(t.key, { at: Date.now(), s });
        F.health.ok('safety', 'RugCheck · GoPlus');
      }
    } catch (e) {
      if (t) safetyCache.set(t.key, { at: Date.now() - 8 * 60000, s: null, err: e.message }); // retry in ~2 min
      F.health.fail('safety', e);
    } finally {
      safetyBusy = false;
    }
  }

  /* ================= candles (GeckoTerminal 5-minute OHLCV, rate-gated by F.gtFetch) ================= */
  const candleCache = new Map();
  const candleQ = [];
  const poolOf = (t) => {
    const net = t.gtNet || F.radar.DS2GT[t.chain];
    const pool = t.pair || t.gtPool;
    return net && pool ? { net, pool } : null;
  };
  F.candles = {
    get: (t) => (candleCache.get(t.key) || {}).rows || null,
    async load(t, maxAge = 60000) {
      const c = candleCache.get(t.key);
      if (c && Date.now() - c.at < maxAge) {
        if (!c.rows) throw new Error('chart unavailable');
        return c.rows;
      }
      const p = poolOf(t);
      if (!p) throw new Error('no pool');
      try {
        const d = await F.gtFetch(`https://api.geckoterminal.com/api/v2/networks/${p.net}/pools/${p.pool}/ohlcv/minute?aggregate=5&limit=72&currency=usd&token=${t.addr}`);
        const rows = (d.data.attributes.ohlcv_list || []).slice().reverse();
        candleCache.set(t.key, { at: Date.now(), rows });
        return rows;
      } catch (e) {
        candleCache.set(t.key, { at: Date.now(), rows: c ? c.rows : null });
        if (c && c.rows) return c.rows;
        throw e;
      }
    },
    hasPool: (t) => !!poolOf(t),
  };
  function wantCandles(t) {
    if (!poolOf(t)) return;
    const c = candleCache.get(t.key);
    if (c && Date.now() - c.at < 3 * 60000) return;
    if (!candleQ.includes(t.key)) candleQ.push(t.key);
  }
  async function pumpCandles() {
    const t = candleQ.length && F.radar.get(candleQ.shift());
    if (t) F.candles.load(t, 3 * 60000).catch(() => {});
  }

  /* ================= statistics helpers ================= */
  function regress(ys) {
    const n = ys.length;
    if (n < 3) return { slope: 0, r2: 0 };
    const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    ys.forEach((y, i) => {
      sxy += (i - mx) * (y - my);
      sxx += (i - mx) ** 2;
      syy += (y - my) ** 2;
    });
    const slope = sxx ? sxy / sxx : 0;
    return { slope, r2: syy ? (sxy * sxy) / (sxx * syy) : 0 };
  }
  function candleStats(rows) {
    if (!rows || rows.length < 8) return null;
    const c = rows.map((r) => r[4]), h = rows.map((r) => r[2]), l = rows.map((r) => r[3]);
    const n = rows.length;
    let tr = 0;
    const k = Math.min(12, n - 1);
    for (let i = n - k; i < n; i++) tr += Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) / c[i - 1];
    let g = 0, ls = 0;
    const m = Math.min(14, n - 1);
    for (let i = n - m; i < n; i++) {
      const d = c[i] - c[i - 1];
      if (d > 0) g += d;
      else ls -= d;
    }
    const reg = regress(c.slice(-12).map((x) => Math.log(x)));
    return { atr: tr / k, rsi: ls === 0 ? 100 : 100 - 100 / (1 + g / ls), slope: reg.slope, r2: reg.r2, fromHigh: c[n - 1] / Math.max(...h) - 1, n };
  }
  // live tape: our own 8-second samples from DexScreener, last ~3 minutes
  function tapeStats(t) {
    const s = (t.samples || []).filter((x) => Date.now() - x[0] < 200000);
    if (s.length < 5) return null;
    const reg = regress(s.map((x) => Math.log(x[1])));
    const spanMin = (s[s.length - 1][0] - s[0][0]) / 60000 || 1;
    const perMin = (Math.exp(reg.slope * (s.length - 1)) - 1) / spanMin;
    return { perMin: perMin * 100, r2: reg.r2, n: s.length };
  }
  const sig = (z) => 1 / (1 + Math.exp(-z));
  const tanh = Math.tanh;

  /* ================= the model ================= */
  const FACTORS = ['mom', 'accel', 'flow', 'traders', 'tape', 'trend', 'heat', 'depth', 'safety', 'buzz', 'exhaust'];
  const PRIOR = { b: -0.7, mom: 0.55, accel: 0.35, flow: 0.6, traders: 0.35, tape: 0.5, trend: 0.45, heat: 0.35, depth: 0.25, safety: 0.75, buzz: 0.2, exhaust: 0.5 };
  const L = Object.assign({ v: 1, w: Object.assign({}, PRIOR), n: 0, calls: [] }, F.store.get('calls', {}));
  FACTORS.concat('b').forEach((k) => L.w[k] == null && (L.w[k] = PRIOR[k]));
  const saveL = () => F.store.set('calls', L);

  function factors(t) {
    const f = {}, note = {};
    const c5 = t.ch.m5 || 0, c1 = t.ch.h1 || 0;
    f.mom = tanh((c5 * 1.5 + c1 * 0.5) / 20);
    note.mom = f.mom >= 0 ? `Momentum: ${F.pct(c5)} in 5m, ${F.pct(c1)} in 1h` : `Momentum fading (${F.pct(c5)} in 5m)`;

    const vm5 = t.vol.m5 || 0, v1 = t.vol.h1 || 0, v6 = t.vol.h6 || 0;
    const pace = (vm5 * 12 + 50) / (v1 + 50);
    f.accel = tanh((0.6 * Math.log2(pace) + 0.4 * Math.log2((v1 * 6 + 50) / (v6 + 50))) / 1.5);
    note.accel = f.accel >= 0 ? `Volume accelerating (last 5m at ${pace.toFixed(1)}× the hourly pace)` : `Volume drying up (${pace.toFixed(1)}× hourly pace)`;

    const h1 = t.tx.h1 || { b: 0, s: 0 }, m5 = t.tx.m5 || { b: 0, s: 0 };
    const bp = (h1.b + 2 * m5.b + 1) / (h1.b + h1.s + 2 * (m5.b + m5.s) + 2);
    f.flow = tanh((bp - 0.5) * 4);
    note.flow = f.flow >= 0 ? `${Math.round(bp * 100)}% of recent trades are buys` : `Sellers in control (${Math.round((1 - bp) * 100)}% sells)`;

    const tr = t.traders && t.traders.h1;
    if (tr && tr.buys > 10) {
      const uniq = tr.buyers / tr.buys;
      f.traders = tanh((uniq - 0.45) * 4);
      note.traders = f.traders >= 0 ? `${tr.buyers} different wallets buying in the last hour` : `Few wallets doing most of the buying (${tr.buyers} wallets, ${tr.buys} buys) — possible bots`;
    } else f.traders = 0;

    const tape = tapeStats(t);
    if (tape) {
      f.tape = tanh(tape.perMin / 1.5) * Math.sqrt(tape.r2);
      note.tape = f.tape >= 0 ? `Rising on the live tape (${tape.perMin >= 0 ? '+' : ''}${tape.perMin.toFixed(2)}%/min, fit ${tape.r2.toFixed(2)})` : `Slipping on the live tape (${tape.perMin.toFixed(2)}%/min)`;
    } else f.tape = 0;

    const cs = candleStats(F.candles.get(t));
    t.cs = cs;
    if (cs) {
      f.trend = tanh(cs.slope * 60) * cs.r2;
      note.trend = f.trend >= 0.1 ? `Clean uptrend on 5-min candles (fit ${cs.r2.toFixed(2)})` : f.trend <= -0.1 ? `Downtrend on 5-min candles` : `Choppy, no clear trend`;
      f.heat = cs.rsi > 80 ? -Math.min(1, (cs.rsi - 80) / 15) : cs.rsi < 35 ? -0.4 : cs.rsi >= 50 && cs.rsi <= 72 ? 0.35 : 0;
      note.heat = cs.rsi > 80 ? `Overheated (RSI ${cs.rsi.toFixed(0)})` : cs.rsi < 35 ? `Falling knife (RSI ${cs.rsi.toFixed(0)})` : `Healthy heat (RSI ${cs.rsi.toFixed(0)})`;
    } else {
      f.trend = 0;
      f.heat = 0;
    }

    const liq = t.liq || 0;
    // depth, safety and exhaustion can only hold a coin back — being safe or liquid is not a reason to buy
    f.depth = liq <= 0 ? -1 : liq >= 50000 ? 0.15 * tanh(Math.log10(liq / 50000)) : tanh(Math.log10(liq / 50000));
    note.depth = f.depth >= 0 ? `Deep liquidity (${F.usd(liq)})` : `Thin liquidity (${F.usd(liq)})`;

    f.safety = -F.clamp((t.risk - 15) / 40, 0, 1);
    const s = t.safety;
    note.safety = f.safety < 0 ? `Rug signals add up (risk ${t.risk}/100)` : s ? `Holders spread out (top 10 hold ${s.top10.toFixed(0)}%), contract checks clean` : '';

    const ment = F.social ? F.social.mentions(t.sym.toUpperCase()) : [];
    const sent = ment.length ? ment.reduce((a, p) => a + F.social.score(p), 0) / ment.length : 0;
    f.buzz = Math.min(1, ment.length / 4) * 0.8 + F.clamp(sent, -1, 1) * 0.2;
    note.buzz = ment.length ? `${ment.length} post${ment.length > 1 ? 's' : ''} talking about it` : 'Nobody posting about it yet';

    const over = c1 > 150 ? Math.min(1, (c1 - 150) / 150) : 0;
    const dump = cs && cs.fromHigh < -0.25 ? Math.min(1, (-cs.fromHigh - 0.25) * 2) : 0;
    f.exhaust = -(over + dump);
    note.exhaust = over ? `Already ${F.pct(c1, 0)} in 1h — late to the party` : dump ? `${F.pct(cs.fromHigh * 100, 0)} below its 6h high — dump in progress` : '';
    return { f, note };
  }

  function prob(f) {
    const w = L.w;
    let z = w.b;
    FACTORS.forEach((k) => (z += (w[k] || 0) * (f[k] || 0)));
    return F.clamp(sig(z), 0.05, 0.85);
  }

  const feePct = () => (F.bot && F.bot.feePct ? F.bot.feePct() : 1.5) / 100;

  /* ================= verdict for one token ================= */
  function evaluate(t) {
    if (t.price == null) return null;
    const { f, note } = factors(t);
    const p = prob(f);
    const atr = t.cs ? t.cs.atr : null;
    const vol = atr || 0.045;
    const stopPct = F.clamp(1.8 * vol, 0.06, 0.25);
    const tp1Pct = F.clamp(Math.max(1.3 * stopPct, 2.2 * vol), 0.08, 0.6);
    const tp2Pct = tp1Pct * 2;
    const size = F.bot ? F.bot.tradeSize(t) : 10;
    const slip = F.slip(size, t.liq || 0);
    const ev = p * tp1Pct - (1 - p) * stopPct - 2 * feePct() - 2 * slip;
    const fresh = Date.now() - t.at < 60000;
    const s = t.safety;
    const ageH = t.created ? (Date.now() - t.created) / 3600000 : 0;
    const contrib = FACTORS.map((k) => ({ k, v: (L.w[k] || 0) * (f[k] || 0), txt: note[k] })).filter((x) => x.txt && Math.abs(x.v) > 0.03);
    const why = contrib.filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 4);
    if (s && f.safety === 0) why.push({ k: 'safety', v: 0, txt: note.safety });
    const against = contrib.filter((x) => x.v < 0).sort((a, b) => a.v - b.v).slice(0, 3);

    let label = 'wait', reason = '';
    const hard = s && (s.honeypot || s.rugged || s.mint || s.freeze || s.sellTax > 10);
    if (hard || t.risk >= 60 || (t.liq || 0) < 10000 || t.pulled) {
      label = 'skip';
      reason = hard ? (s.honeypot ? 'Honeypot — sells may fail' : s.rugged ? 'Flagged as rugged' : s.mint ? 'Dev can still mint more tokens' : s.freeze ? 'Dev can freeze wallets' : `Sell tax ${s.sellTax.toFixed(0)}%`) : t.pulled ? 'Liquidity was pulled' : (t.liq || 0) < 10000 ? 'Too little liquidity to get out' : 'Too many rug signals';
    } else if (p < 0.35 || ((t.ch.m5 || 0) < -8 && (t.ch.h1 || 0) < -15)) {
      label = 'skip';
      reason = p < 0.35 ? 'Odds are poor right now' : 'Dumping on every timeframe';
    } else if (!fresh) reason = 'Waiting for a fresh price';
    else if (canCheck(t) && !s) reason = 'Running contract & holder checks…';
    else if (ageH < 0.25) reason = 'Too new — let it prove itself for 15 min';
    else if (t.risk >= 45) reason = 'Risk too high for a call';
    else if ((t.ch.h1 || 0) > 250) reason = 'Already vertical — chasing';
    else if (p < 0.52) reason = `Edge not there yet (${Math.round(p * 100)}% < 52%)`;
    else if (!canCheck(t) && p < 0.6) reason = `No contract scanner for ${t.chain}, so it needs 60%+ odds (has ${Math.round(p * 100)}%)`;
    else if (ev <= 0.01) reason = `Expected value too thin after fees (${F.pct(ev * 100)})`;
    else label = 'buy';

    if (!canCheck(t)) against.push({ k: 'scan', v: -0.01, txt: `Contract not scanned — no RugCheck/GoPlus coverage on ${t.chain}` });
    return {
      label, reason, p, ev, f, why, against, stopPct, tp1Pct, tp2Pct, slip, atr,
      entry: t.price, maxEntry: t.price * 1.03, stop: t.price * (1 - stopPct), tp1: t.price * (1 + tp1Pct), tp2: t.price * (1 + tp2Pct),
      at: Date.now(),
    };
  }

  /* ================= enrich: called by the radar for every token on every refresh ================= */
  function addSafetyFlags(t) {
    const c = safetyCache.get(t.key);
    t.safety = c && c.s ? c.s : null;
    const s = t.safety;
    if (!s) return;
    let add = 0;
    const flag = (lvl, txt, pts) => {
      t.flags.push([lvl, '', txt]);
      add += pts;
    };
    if (s.rugged) flag('crit', `${s.src}: token flagged as rugged`, 100);
    if (s.honeypot) flag('crit', `${s.src}: honeypot — you may not be able to sell`, 70);
    if (s.mint) flag('crit', 'Mint authority is on — the dev can print more tokens', 30);
    if (s.freeze) flag('crit', 'Freeze / pause authority is on — the dev can lock wallets', 30);
    if (s.sellTax > 10) flag('crit', `Sell tax ${s.sellTax.toFixed(0)}%`, 35);
    else if (s.sellTax > 3) flag('warn', `Sell tax ${s.sellTax.toFixed(1)}%`, 10);
    if (s.hiddenOwner) flag('warn', 'Hidden owner or owner can change balances', 20);
    if (s.top10 > 50) flag('crit', `Top 10 wallets hold ${s.top10.toFixed(0)}% of supply`, 25);
    else if (s.top10 > 30) flag('warn', `Top 10 wallets hold ${s.top10.toFixed(0)}% of supply`, 10);
    if (s.topHolder > 15) flag('warn', `One wallet holds ${s.topHolder.toFixed(0)}%`, 12);
    if (s.insiderPct > 15) flag('warn', `Insider wallets hold ${s.insiderPct.toFixed(0)}%`, 15);
    if (s.creatorPct > 10) flag('warn', `Creator still holds ${s.creatorPct.toFixed(0)}%`, 10);
    if (s.lpLocked < 50 && s.src === 'GoPlus') flag('warn', `Only ${s.lpLocked.toFixed(0)}% of liquidity is locked`, 10);
    t.risk = F.clamp(t.risk + add, 0, 100);
  }

  function enrich(t) {
    addSafetyFlags(t);
    t.sig = evaluate(t);
    // spend the rate-limited lookups on tokens that could plausibly become calls
    if (t.sig && t.sig.label !== 'skip' && t.fomo >= 50) {
      wantSafety(t);
      wantCandles(t);
    }
  }

  /* ================= the call ledger: every "Worth buying" is logged and graded ================= */
  const HORIZON = 2 * 3600000;
  function openCalls(list) {
    list.forEach((t) => {
      if (!t.sig || t.sig.label !== 'buy') return;
      const last = L.calls.find((c) => c.key === t.key);
      if (last && (last.status === 'open' || Date.now() - (last.closedAt || last.at) < 30 * 60000)) return;
      L.calls.unshift({
        id: F.uid(), key: t.key, sym: t.sym, chain: t.chain, icon: t.icon, at: Date.now(), entry: t.price,
        stop: t.sig.stop, tp1: t.sig.tp1, tp2: t.sig.tp2, p: t.sig.p, ev: t.sig.ev, f: t.sig.f, fee: feePct(),
        status: 'open', last: t.price, mfe: 0, mae: 0,
      });
      F.emit('call:new', L.calls[0]);
    });
    if (L.calls.length > 400) L.calls.length = 400;
  }
  function learn(c, y) {
    // one SGD step on the logistic weights, pulled back toward the priors (L2) so it learns slowly and stays sane
    const lr = 0.04, lam = 0.02;
    const p = prob(c.f);
    const g = y - p;
    L.w.b += lr * g - lam * (L.w.b - PRIOR.b);
    FACTORS.forEach((k) => (L.w[k] += lr * g * (c.f[k] || 0) - lam * (L.w[k] - PRIOR[k])));
    L.n++;
  }
  function grade() {
    let changed = false;
    L.calls.forEach((c) => {
      if (c.status !== 'open') return;
      const t = F.radar.get(c.key);
      const now = Date.now();
      if (t && t.price != null && now - t.at < 120000) {
        c.last = t.price;
        const r = t.price / c.entry - 1;
        c.mfe = Math.max(c.mfe, r);
        c.mae = Math.min(c.mae, r);
        if (t.price <= c.stop) close(c, 'loss', t.price);
        else if (t.price >= c.tp1) close(c, 'win', t.price);
      }
      if (c.status === 'open' && now - c.at > HORIZON) close(c, 'timeout', c.last);
      if (c.status !== 'open') changed = true;
    });
    if (changed) saveL();
  }
  function close(c, status, px) {
    c.status = status;
    c.exit = px;
    c.closedAt = Date.now();
    c.ret = px / c.entry - 1;
    c.net = (1 + c.ret) * (1 - c.fee) * (1 - c.fee) - 1;
    learn(c, status === 'win' ? 1 : status === 'loss' ? 0 : c.net > 0 ? 1 : 0);
    F.emit('call:closed', c);
  }
  function stats(hours = 24 * 7) {
    const done = L.calls.filter((c) => c.status !== 'open' && Date.now() - c.at < hours * 3600000);
    const wins = done.filter((c) => c.status === 'win' || (c.status === 'timeout' && c.net > 0));
    const bucket = (lo, hi) => {
      const b = done.filter((c) => c.p >= lo && c.p < hi);
      return { n: b.length, hit: b.length ? b.filter((c) => c.status === 'win' || (c.status === 'timeout' && c.net > 0)).length / b.length : null };
    };
    return {
      n: done.length, open: L.calls.filter((c) => c.status === 'open').length, wins: wins.length,
      hit: done.length ? wins.length / done.length : null,
      avgNet: done.length ? done.reduce((s, c) => s + c.net, 0) / done.length : null,
      buckets: [['50–60%', bucket(0.5, 0.6)], ['60–70%', bucket(0.6, 0.7)], ['70%+', bucket(0.7, 1)]],
      learned: L.n,
    };
  }

  F.engine = {
    FACTORS, PRIOR,
    enrich,
    weights: () => L.w,
    calls: () => L.calls,
    stats,
    trackedKeys: () => new Set(L.calls.filter((c) => c.status === 'open').map((c) => c.key)),
    best(n = 3) {
      return F.radar.list().filter((t) => t.sig && t.sig.label === 'buy').sort((a, b) => b.sig.ev - a.sig.ev).slice(0, n);
    },
    closest() {
      return F.radar.list().filter((t) => t.sig && t.sig.label === 'wait').sort((a, b) => b.sig.p - a.sig.p)[0] || null;
    },
    start() {
      setInterval(pumpSafety, 2500);
      setInterval(pumpCandles, 7000);
      F.on('radar', () => {
        openCalls(F.radar.list());
        grade();
        saveL();
      });
      setInterval(() => F.store.set('safety', [...safetyCache.entries()].filter(([, v]) => v.s && Date.now() - v.at < 30 * 60000).slice(-120)), 30000);
    },
  };
})();
