/* fomo — the trading bot agent. PAPER ONLY: it never touches a wallet or an exchange account.
   Trades the meme radar with real live prices and an honest cost model (swap fee + AMM slippage against the pool's
   actual liquidity, on the way in AND out). Runs while fomo is open; state survives reloads. */
(function () {
  const F = window.F;

  // The engine decides what's worth buying; the dial sets how picky the bot is and how big it bets.
  const PRESETS = {
    chill: { label: 'Chill', emoji: '🧊', size: 0.03, maxPos: 3, minP: 0.6, maxRisk: 30, trailMul: 1.2, timeM: 120 },
    degen: { label: 'Degen', emoji: '🔥', size: 0.06, maxPos: 5, minP: 0.55, maxRisk: 45, trailMul: 1.5, timeM: 90 },
    send: { label: 'Full send', emoji: '🚀', size: 0.1, maxPos: 6, minP: 0.52, maxRisk: 55, trailMul: 2, timeM: 60 },
  };
  const COOLDOWN = 60 * 60000;
  const MAX_POOL_SHARE = 0.015; // never take more than 1.5% of a pool — keeps entry slippage under ~3%

  // fee mirrors fomo: a % taken off every buy and every sell ($2.00 in → $1.97 into the coin at 1.5%)
  const fresh = () => ({ v: 1, running: false, preset: 'degen', start: 1000, cash: 1000, fixedSize: null, feePct: 1.5, pos: [], closed: [], eq: [], cool: {}, log: [], scans: 0, lastTick: 0, copilot: true, born: Date.now() });
  let S = Object.assign(fresh(), F.store.get('bot', {}));
  if (!(S.feePct >= 0)) S.feePct = 1.5;
  const save = () => F.store.set('bot', S);
  const fee = () => S.feePct / 100;
  const P = () => PRESETS[S.preset] || PRESETS.degen;
  let pendingAI = null;
  let firstTick = true;
  let thought = { text: 'Warming up — waiting for the radar’s first prices…', near: [] };

  function log(e, msg, kind = 'info') {
    S.log.unshift({ ts: Date.now(), e, msg, kind });
    if (S.log.length > 250) S.log.length = 250;
  }

  /* ---------------- accounting ---------------- */
  const liquidation = (p, t) => {
    const mid = t && t.price != null ? t.price : p.last;
    const gross = p.qty * mid;
    return gross * (1 - F.slip(gross, (t && t.liq) || p.liqEntry)) * (1 - fee());
  };
  // what the bot would put into this token right now: fixed $ if you set one, else the dial's % of equity
  const intendedSpend = (t) => Math.min(S.fixedSize > 0 ? S.fixedSize : equity() * P().size, S.cash * 0.98, (t.liq || 0) * MAX_POOL_SHARE);
  function equity() {
    return S.cash + S.pos.reduce((s, p) => s + liquidation(p, F.radar.get(p.key)), 0);
  }

  function buy(t, why, ai) {
    const spend = intendedSpend(t);
    if (spend < 0.01) return log('🪫', `Skipped $${t.sym}: no cash left (${F.usd(S.cash)})`, 'warn');
    const slip = F.slip(spend, t.liq);
    const fillPx = (t.price * (1 + slip)) / (1 - fee());
    const qty = spend / fillPx;
    const sg = t.sig || {};
    const stopPx = sg.stop || t.price * 0.88, tp1 = sg.tp1 || t.price * 1.15;
    S.cash -= spend;
    S.pos.push({
      id: F.uid(), key: t.key, sym: t.sym, chain: t.chain, icon: t.icon, qty, cost: spend, entryPx: t.price, fillPx,
      openedAt: Date.now(), peak: t.price, last: t.price, lastAt: Date.now(), liqEntry: t.liq, fomoEntry: t.fomo, why, ai: ai || null, partial: false,
      stopPx, tp1, trailPct: Math.max(0.06, (sg.atr || 0.045) * P().trailMul), p: sg.p || null,
    });
    log('🚀', `BUY $${t.sym}: ${F.usd(spend)} in, ${F.usd(spend * (1 - fee()))} into the coin after the ${S.feePct}% fee, at ${F.price(t.price)}${slip > 0.001 ? ` (+${(slip * 100).toFixed(2)}% slippage)` : ''}. Stop ${F.price(stopPx)} · target ${F.price(tp1)}. ${why}`, 'buy');
    F.emit('bot:trade', { side: 'buy', sym: t.sym });
  }

  function sell(p, t, reason, emoji, frac = 1) {
    const mid = t && t.price != null ? t.price : p.last;
    const qty = p.qty * frac;
    const gross = qty * mid;
    const slip = F.slip(gross, (t && t.liq) || p.liqEntry);
    const proceeds = gross * (1 - slip) * (1 - fee());
    const cost = p.cost * frac;
    const pnl = proceeds - cost;
    S.cash += proceeds;
    S.closed.unshift({
      sym: p.sym, key: p.key, chain: p.chain, icon: p.icon, openedAt: p.openedAt, closedAt: Date.now(), entryPx: p.entryPx, exitPx: mid,
      cost, proceeds, pnl, pnlPct: (pnl / cost) * 100, reason, emoji, frac, why: p.why, ai: p.ai,
    });
    if (S.closed.length > 500) S.closed.length = 500;
    const tag = frac < 1 ? `SOLD ${Math.round(frac * 100)}% of` : 'SELL';
    log(emoji, `${tag} $${p.sym} at ${F.price(mid)} — ${reason}. P&L ${pnl >= 0 ? '+' : ''}${F.usd(pnl)} (${F.pct((pnl / cost) * 100)})`, pnl >= 0 ? 'win' : 'loss');
    if (frac >= 1) {
      S.pos = S.pos.filter((x) => x.id !== p.id);
      S.cool[p.key] = Date.now();
    } else {
      p.qty -= qty;
      p.cost -= cost;
      p.partial = true;
    }
    F.emit('bot:trade', { side: 'sell', sym: p.sym, pnl });
  }

  /* ---------------- exits ---------------- */
  function manage() {
    const pr = P();
    [...S.pos].forEach((p) => {
      const t = F.radar.get(p.key);
      if (!t || t.price == null || Date.now() - t.at > 120000) {
        if (!p.staleWarned && Date.now() - p.lastAt > 10 * 60000) {
          log('⏳', `No fresh price for $${p.sym} in ${F.ago(p.lastAt)} — holding at last known ${F.price(p.last)}`, 'warn');
          p.staleWarned = true;
        }
        return;
      }
      p.last = t.price;
      p.lastAt = t.at;
      p.staleWarned = false;
      p.peak = Math.max(p.peak, t.price);
      const chg = t.price / p.entryPx - 1;
      const held = (Date.now() - p.openedAt) / 60000;
      const stop = p.stopPx || p.entryPx * 0.88;
      const tp1 = p.tp1 || p.entryPx * 1.15;
      const trail = p.trailPct || 0.09;
      if (t.pulled) return sell(p, t, 'liquidity was pulled from the pool', '🚨');
      if ((t.safety && (t.safety.honeypot || t.safety.rugged)) || t.flags.some((f) => f[1] === '🍯')) return sell(p, t, 'honeypot / rug signs — in real life this sell might fail', '🍯');
      if (t.price <= stop) return sell(p, t, `${p.partial ? 'breakeven stop' : 'stop-loss'} hit at ${F.price(stop)} (${F.pct(chg * 100)})`, p.partial ? '💰' : '🛑');
      if (!p.partial && t.price >= tp1) {
        sell(p, t, `target hit (${F.pct(chg * 100)}) — banking half, stop moved to breakeven`, '💰', 0.5);
        p.stopPx = Math.max(stop, p.entryPx);
        return;
      }
      if (p.partial && t.price <= p.peak * (1 - trail)) return sell(p, t, `trailing stop — gave back ${(trail * 100).toFixed(0)}% from the ${F.pct((p.peak / p.entryPx - 1) * 100)} peak`, chg > 0 ? '💰' : '🛑');
      if (held > pr.timeM && Math.abs(chg) < 0.05) return sell(p, t, `time stop — flat for ${Math.round(held)} min`, '⏰');
    });
  }

  /* ---------------- entries ---------------- */
  function gate(t) {
    const pr = P();
    const why = [];
    const sg = t.sig;
    if (S.pos.some((p) => p.key === t.key)) why.push('already holding');
    if (S.cool[t.key] && Date.now() - S.cool[t.key] < COOLDOWN) why.push('cooling down after exit');
    if (!sg) why.push('no read yet');
    else if (sg.label !== 'buy') why.push(sg.reason || (sg.label === 'skip' ? 'not worth it' : 'waiting'));
    else {
      if (sg.p < pr.minP) why.push(`${Math.round(sg.p * 100)}% odds, ${pr.label} wants ${Math.round(pr.minP * 100)}%+`);
      if (t.risk > pr.maxRisk) why.push(`risk ${t.risk}, ${pr.label} allows ${pr.maxRisk}`);
    }
    if (intendedSpend(t) < 0.01) why.push('no cash free');
    return why;
  }

  function hunt() {
    const pr = P();
    const all = F.radar.list();
    const scored = all.map((t) => ({ t, why: gate(t) }));
    const ready = scored.filter((x) => !x.why.length).sort((a, b) => b.t.sig.ev - a.t.sig.ev);
    const near = scored.filter((x) => x.why.length && x.t.sig && x.t.sig.label !== 'skip').sort((a, b) => b.t.sig.p - a.t.sig.p).slice(0, 3);
    thought.near = [...ready.slice(0, 3).map((x) => ({ t: x.t, why: [`ready · EV ${F.pct(x.t.sig.ev * 100)} after fees`] })), ...near].slice(0, 4);
    const slots = pr.maxPos - S.pos.length;
    const best = ready[0];
    const buys = all.filter((t) => t.sig && t.sig.label === 'buy').length;
    let text;
    if (!all.length) text = 'No radar prices yet — waiting on DexScreener / GeckoTerminal.';
    else if (slots <= 0) text = `All ${pr.maxPos} slots full. Riding ${S.pos.map((p) => '$' + p.sym + ' ' + F.pct((p.last / p.entryPx - 1) * 100, 0)).join(', ')}.`;
    else if (!best) text = `Scanned ${all.length} coins · ${buys} worth buying right now${buys ? `, none meet ${pr.label}'s bar` : ''}. Waiting for a real edge — no trade is a position too.`;
    else text = `Scanned ${all.length} coins · ${buys} worth buying · taking $${best.t.sym}: ${Math.round(best.t.sig.p * 100)}% odds, EV ${F.pct(best.t.sig.ev * 100)} after fees.`;
    thought.text = text;

    if (S.scans % 8 === 1) log('🔍', `Scan #${S.scans}: ${all.length} coins, ${buys} worth buying${best ? `, best $${best.t.sym} (${Math.round(best.t.sig.p * 100)}%, EV ${F.pct(best.t.sig.ev * 100)})` : ''}.`, 'scan');
    if (slots <= 0 || !best || pendingAI) return;

    const t = best.t;
    const why = `Engine: ${Math.round(t.sig.p * 100)}% odds of target before stop, EV ${F.pct(t.sig.ev * 100)} after fees — ${t.sig.why.slice(0, 3).map((x) => x.txt.toLowerCase()).join('; ')}.`;
    if (S.copilot && F.ai && F.ai.ready()) {
      pendingAI = t.key;
      thought.text = `Asking Claude to sanity-check $${t.sym} before buying…`;
      log('🧠', `Asking Claude about $${t.sym} (FOMO ${t.fomo}, risk ${t.risk})…`, 'ai');
      F.ai
        .copilot(t, F.social.mentions(t.sym, 6 * 3600000).slice(0, 10), pr)
        .then((v) => {
          const t2 = F.radar.get(t.key);
          if (!S.running || !t2) return;
          if (v.verdict === 'buy' && v.conviction >= 50 && !gate(t2).length) {
            log('🤖', `Claude: BUY $${t.sym} (conviction ${v.conviction}) — ${v.thesis}`, 'ai');
            buy(t2, why, v);
          } else {
            S.cool[t.key] = Date.now() - COOLDOWN / 2; // 30 min veto
            log('🙅', `Claude vetoed $${t.sym} (conviction ${v.conviction}) — ${v.thesis}${v.red_flags.length ? ' Red flags: ' + v.red_flags.join('; ') : ''}`, 'ai');
          }
        })
        .catch((e) => {
          log('⚠️', `Claude check failed (${e.message}). Skipping $${t.sym} rather than trading blind.`, 'warn');
          S.cool[t.key] = Date.now() - COOLDOWN + 10 * 60000;
        })
        .finally(() => {
          pendingAI = null;
          save();
          render();
        });
    } else buy(t, why, null);
  }

  /* ---------------- the loop: runs every time the radar re-prices (~20s) ---------------- */
  function tick() {
    S.scans++;
    if (firstTick && S.running && S.lastTick && Date.now() - S.lastTick > 3 * 60000)
      log('⏯️', `Back online after ${F.ago(S.lastTick)} away — stops could not fire while fomo was closed.`, 'warn');
    firstTick = false;
    manage();
    if (S.running) hunt();
    else thought.text = 'Paused. Hit ▶ Run to let the bot trade (paper money only).';
    S.lastTick = Date.now();
    const last = S.eq[S.eq.length - 1];
    if (!last || Date.now() - last[0] > 60000) {
      S.eq.push([Date.now(), equity()]);
      if (S.eq.length > 1440) S.eq.shift();
    }
    save();
    render();
  }

  /* ---------------- stats ---------------- */
  function stats() {
    const full = S.closed;
    const wins = full.filter((c) => c.pnl > 0), losses = full.filter((c) => c.pnl <= 0);
    const gw = wins.reduce((s, c) => s + c.pnl, 0), gl = -losses.reduce((s, c) => s + c.pnl, 0);
    let peak = -Infinity, dd = 0;
    S.eq.forEach(([, v]) => {
      peak = Math.max(peak, v);
      dd = Math.max(dd, (peak - v) / peak);
    });
    const eq = equity();
    return {
      eq, ret: (eq / S.start - 1) * 100, realized: full.reduce((s, c) => s + c.pnl, 0),
      unreal: S.pos.reduce((s, p) => s + liquidation(p, F.radar.get(p.key)) - p.cost, 0),
      trades: full.length, winRate: full.length ? (wins.length / full.length) * 100 : null,
      pf: gl > 0 ? gw / gl : wins.length ? Infinity : null, dd: dd * 100,
      avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    };
  }

  /* ---------------- panel ---------------- */
  let posView = 'open';
  const statusHTML = () => (S.running ? `<span class="live-dot"></span>Live · scanned ${F.ago(S.lastTick)} ago` : '<span class="live-dot off"></span>Paused');
  const ico = (src, sym) => (src ? `<img class="ti" src="${F.esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'ti',textContent:'${F.esc(String(sym).charAt(0).toUpperCase())}'}))">` : `<i class="ti">${F.esc(String(sym).charAt(0).toUpperCase())}</i>`);
  const money = (x) => `<span class="${F.dir(x)}">${x >= 0 ? '+' : '−'}${F.usd(Math.abs(x))}</span>`;

  // the balance glides to its new value instead of jumping
  let shownEq = null, eqAnim = 0;
  function tweenEq(to) {
    const el = F.$('#botEq');
    const from = shownEq == null ? to : shownEq;
    shownEq = to;
    cancelAnimationFrame(eqAnim);
    if (Math.abs(to - from) < 0.005) return void (el.textContent = F.usd(to));
    el.classList.remove('fl-up', 'fl-dn');
    void el.offsetWidth;
    el.classList.add(to > from ? 'fl-up' : 'fl-dn');
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 700);
      el.textContent = F.usd(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) eqAnim = requestAnimationFrame(step);
    };
    eqAnim = requestAnimationFrame(step);
  }

  const posEls = new Map();
  function renderPositions(pr) {
    const box = F.$('#botPos');
    const ids = new Set(S.pos.map((p) => p.id));
    posEls.forEach((el, id) => {
      if (!ids.has(id)) {
        el.remove();
        posEls.delete(id);
      }
    });
    const empty = box.querySelector('.empty');
    if (!S.pos.length) {
      if (!empty) box.innerHTML = `<p class="empty">No open positions. ${S.running ? 'Hunting…' : 'Start the bot to let it trade.'}</p>`;
      else empty.textContent = `No open positions. ${S.running ? 'Hunting…' : 'Start the bot to let it trade.'}`;
      return;
    }
    if (empty) empty.remove();
    S.pos.forEach((p) => {
      const t = F.radar.get(p.key);
      const val = liquidation(p, t);
      const pnl = val - p.cost;
      const chg = (p.last / p.entryPx - 1) * 100;
      const sub = `${F.usd(p.cost)} in · ${F.ago(p.openedAt)} · stop $${F.price(p.stopPx || p.entryPx * 0.88)}${p.partial ? ' · half banked' : ` · target $${F.price(p.tp1 || p.entryPx * 1.15)}`}`;
      const right = `<b>${F.usd(val)}</b>${F.chg(chg)}`;
      const foot = `<button class="xs" data-sell="${p.id}" type="button">Sell now</button> <span class="dim">P&amp;L ${pnl >= 0 ? '+' : '−'}${F.usd(Math.abs(pnl))} after fees</span>`;
      let el = posEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'pos enter';
        el.dataset.key = p.key;
        el.innerHTML = `${ico(p.icon, p.sym)}<div class="pm"><b>${F.esc(p.sym)}</b><small>${sub}</small></div><div class="pr">${right}</div>${p.ai ? `<div class="ai">🧠 ${F.esc(p.ai.thesis)}</div>` : ''}<div class="ai pf">${foot}</div>`;
        posEls.set(p.id, el);
        box.appendChild(el);
        el._v = val;
        return;
      }
      el.querySelector('.pm small').innerHTML = sub;
      el.querySelector('.pr').innerHTML = right;
      el.querySelector('.pf').innerHTML = foot;
      if (el._v != null && Math.abs(val - el._v) > 1e-9) flashEl(el.querySelector('.pr b'), val - el._v);
      el._v = val;
    });
  }
  function flashEl(el, dir) {
    if (!el) return;
    el.classList.remove('fl-up', 'fl-dn');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'fl-up' : 'fl-dn');
  }

  // activity: new entries slide in on top; nothing already on screen is rebuilt
  let logTop = null;
  function renderLog() {
    const box = F.$('#botLog');
    const top = S.log[0] ? S.log[0].ts + S.log[0].msg : null;
    if (top === logTop) return;
    const known = logTop;
    logTop = top;
    const row = (l) => `<div class="lg ${l.kind}"><i>${l.e}</i><span>${F.esc(l.msg)}<time data-ts="${l.ts}">${F.ago(l.ts)}</time></span></div>`;
    const idx = known == null ? -1 : S.log.findIndex((l) => l.ts + l.msg === known);
    if (idx <= 0 || !box.querySelector('.lg')) {
      box.innerHTML = S.log.slice(0, 80).map(row).join('') || '<p class="empty">Nothing yet.</p>';
      return;
    }
    box.insertAdjacentHTML('afterbegin', S.log.slice(0, idx).map(row).join(''));
    [...box.children].slice(0, idx).forEach((el) => el.classList.add('enter'));
    while (box.children.length > 80) box.lastElementChild.remove();
  }

  let closedN = -1;
  function render() {
    const root = F.$('#bot');
    if (!root) return;
    const st = stats();
    const pr = P();
    F.$('#botStatus').innerHTML = statusHTML();
    const run = F.$('#botRun');
    run.textContent = S.running ? 'Pause bot' : 'Start bot';
    run.className = 'btn big ' + (S.running ? 'stop' : 'go');
    tweenEq(st.eq);
    F.$('#botRet').innerHTML = `${money(st.eq - S.start)} <span class="${F.dir(st.ret)}">(${F.pct(st.ret, 2)})</span> <span class="dim">since start</span>`;
    F.$('#botCurve').innerHTML = F.spark(S.eq.map((x) => x[1]).concat([st.eq]), 340, 56, 'wide');
    F.$('#topEq').textContent = F.usd(st.eq);
    F.$('#topEqSub').innerHTML = `<span class="${F.dir(st.ret)}">${F.pct(st.ret, 2)}</span> · bot ${S.running ? 'live' : 'paused'}`;
    F.$('#botKpi').innerHTML = [
      ['Cash', F.usd(S.cash)],
      ['Open positions', `${S.pos.length} / ${pr.maxPos}`],
      ['Win rate', st.winRate == null ? '—' : `${st.winRate.toFixed(0)}% <span class="dim">of ${st.trades}</span>`],
      ['Realized P&L', money(st.realized)],
      ['Unrealized P&L', money(st.unreal)],
      ['Max drawdown', st.dd.toFixed(1) + '%'],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    F.$$('#botRisk button').forEach((b) => b.classList.toggle('on', b.dataset.p === S.preset));
    const fixed = S.fixedSize > 0;
    F.$('#botRiskNote').textContent = `${fixed ? F.usd(S.fixedSize) + ' per trade' : (pr.size * 100).toFixed(0) + '% of balance per trade'}, up to ${pr.maxPos} at once. Buys only "Worth buying" calls with ${Math.round(pr.minP * 100)}%+ odds and risk under ${pr.maxRisk}. Stops and targets scale with each coin's volatility; half comes off at the target, the rest trails.`;
    const ex = fixed ? S.fixedSize : 2;
    if (document.activeElement !== F.$('#feeIn')) F.$('#feeIn').value = S.feePct;
    F.$('#feePreview').textContent = `${F.usd(ex)} in → ${F.usd(ex * (1 - fee()))} into the coin. The fee is charged again when it sells.`;
    F.$('#botBank').textContent = F.usd(S.start);
    F.$$('#sizeMode button').forEach((b) => b.classList.toggle('on', (b.dataset.m === 'fixed') === fixed));
    F.$('#sizeFixedRow').hidden = !fixed;
    if (fixed && document.activeElement !== F.$('#sizeIn')) F.$('#sizeIn').value = S.fixedSize;
    F.$('#botCopilot').checked = !!S.copilot;
    F.$('#botCopilotNote').textContent = F.ai && F.ai.ready() ? (S.copilot ? 'reviews every buy' : 'off') : 'needs a Claude key';

    F.$('#botThought').innerHTML =
      `<p>🤖 ${F.esc(thought.text)}</p>` +
      (thought.near.length
        ? '<ul>' + thought.near.map(({ t, why }) => {
            const pp = t.sig ? Math.round(t.sig.p * 100) : 0;
            const lv = t.sig && t.sig.label === 'buy' ? 4 : pp >= 50 ? 3 : 2;
            return `<li data-key="${F.esc(t.key)}"><span class="score s${lv}">${pp}%</span><b>${F.esc(t.sym)}</b><span class="mut">${F.esc(why.join(' · '))}</span></li>`;
          }).join('') + '</ul>'
        : '');

    F.$('#botPos').hidden = posView !== 'open';
    F.$('#botClosed').hidden = posView !== 'closed';
    F.$$('#posTabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === posView));
    renderPositions(pr);
    if (closedN !== S.closed.length) {
      closedN = S.closed.length;
      F.$('#botClosed').innerHTML = S.closed.length
        ? S.closed.slice(0, 50).map((c) => `<div class="cl"><b>${c.emoji} ${F.esc(c.sym)}</b><span class="r ${F.dir(c.pnl)}">${c.pnl >= 0 ? '+' : '−'}${F.usd(Math.abs(c.pnl))}</span><small>${Math.round((c.closedAt - c.openedAt) / 60000)}m · ${F.esc(c.reason)}</small><small class="r">${F.chg(c.pnlPct)}</small></div>`).join('')
        : '<p class="empty">No closed trades yet. The scoreboard starts at zero.</p>';
    }
    renderLog();
  }

  function startFresh(n) {
    const keep = { preset: S.preset, copilot: S.copilot, fixedSize: S.fixedSize, running: S.running };
    S = Object.assign(fresh(), keep, { start: n, cash: n });
    shownEq = null;
    logTop = null;
    closedN = -1;
    posEls.forEach((el) => el.remove());
    posEls.clear();
    log('💵', `Fresh start with ${F.usd(n)} paper money. Track record cleared.`, 'info');
    save();
    render();
  }

  function bind() {
    F.$('#botRun').onclick = () => {
      S.running = !S.running;
      log(S.running ? '▶️' : '⏸️', S.running ? `Bot started in ${P().emoji} ${P().label} mode with ${F.usd(equity())} paper money.` : 'Bot paused. Open positions are still managed (stops keep working).', 'info');
      S.lastTick = Date.now();
      save();
      tick();
    };
    F.$$('#botRisk button').forEach((b) =>
      (b.onclick = () => {
        if (S.preset === b.dataset.p) return;
        S.preset = b.dataset.p;
        log(P().emoji, `Risk dial → ${P().label}.`, 'info');
        save();
        render();
      })
    );
    F.$('#botCopilot').onchange = (e) => {
      S.copilot = e.target.checked;
      save();
      render();
    };
    F.$('#botPanic').onclick = () => {
      if (!S.pos.length) return;
      if (!confirm('Sell every open paper position at the current price?')) return;
      [...S.pos].forEach((p) => sell(p, F.radar.get(p.key), 'manual panic sell', '🧯'));
      save();
      render();
    };
    const hasHistory = () => S.pos.length || S.closed.length;
    F.$('#botReset').onclick = () => {
      if (hasHistory() && !confirm(`Start over with ${F.usd(S.start)}? This clears the bot's positions and track record.`)) return;
      startFresh(S.start);
    };
    // bankroll: any amount above zero, cents included — quick buttons just fill the box, like fomo's buy panel
    const amount = (v) => {
      const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
      return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
    };
    F.$('#bankQuick').onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) F.$('#bankIn').value = b.dataset.v;
    };
    const setBank = () => {
      const n = amount(F.$('#bankIn').value);
      if (!n) return F.toast('Enter an amount above $0', 'bad');
      if (hasHistory() && !confirm(`Start fresh with ${F.usd(n)}? This clears the bot's positions and track record.`)) return;
      F.$('#bankIn').value = '';
      startFresh(n);
    };
    F.$('#bankSet').onclick = setBank;
    F.$('#bankIn').onkeydown = (e) => e.key === 'Enter' && setBank();
    F.$('#sizeMode').onclick = (e) => {
      const b = e.target.closest('button[data-m]');
      if (!b) return;
      if (b.dataset.m === 'auto') S.fixedSize = null;
      else if (!(S.fixedSize > 0)) S.fixedSize = Math.max(0.01, Math.round(S.start * P().size * 100) / 100);
      save();
      render();
    };
    F.$('#feeIn').onchange = (e) => {
      const n = parseFloat(String(e.target.value).replace(/[%\s]/g, ''));
      if (!(n >= 0 && n < 50)) return F.toast('Fee must be between 0% and 50%', 'bad');
      S.feePct = Math.round(n * 100) / 100;
      log('🧾', `Fee set to ${S.feePct}% per buy and per sell.`, 'info');
      save();
      render();
    };
    F.$('#sizeIn').onchange = (e) => {
      const n = amount(e.target.value);
      if (!n) return F.toast('Enter an amount above $0', 'bad');
      S.fixedSize = n;
      log('🎯', `Each trade is now ${F.usd(n)}.`, 'info');
      save();
      render();
    };
    F.$('#posTabs').onclick = (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      posView = b.dataset.v;
      render();
    };
    F.$('#topBot').onclick = () => F.emit('show-col', 'bot');
    F.$('#bot').addEventListener('click', (e) => {
      const s = e.target.closest('[data-sell]');
      if (s) {
        const p = S.pos.find((x) => x.id === s.dataset.sell);
        if (p) sell(p, F.radar.get(p.key), 'sold by you', '✋');
        save();
        render();
        return;
      }
      const k = e.target.closest('[data-key]');
      if (k) F.emit('open-token', k.dataset.key);
    });
  }

  let deb;
  F.bot = {
    PRESETS,
    feePct: () => S.feePct,
    tradeSize: (t) => intendedSpend(t),
    state: () => S,
    heldKeys: () => new Set(S.pos.map((p) => p.key)),
    stats,
    start() {
      bind();
      render();
      F.on('radar', () => {
        clearTimeout(deb);
        deb = setTimeout(tick, 600);
      });
      setInterval(() => {
        const el = F.$('#botStatus');
        if (el && S.running) el.innerHTML = statusHTML();
      }, 1000);
    },
  };
})();
