/* fomo — rendering for the feed, radar, markets, footer ticker and token drawer. */
(function () {
  const F = window.F;

  const VCHK = '<svg class="vchk" viewBox="0 0 24 24" aria-label="verified"><circle cx="12" cy="12" r="10" fill="#7c8cff"/><path d="m7.6 12.4 3 3 5.8-6.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const initial = (s) => F.esc(String(s || '?').replace(/^[^A-Za-z0-9]+/, '').charAt(0).toUpperCase() || '?');
  const fallbackImg = (cls, letter) => `onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'${cls}',textContent:'${letter}'}))"`;

  /* ================= FEED ================= */
  const KIND = { whale: 'Whale', hack: 'Hack', breaking: 'Breaking', news: 'News', stocks: 'Markets', shill: 'Shill', opinion: 'Opinion', meme: 'Meme', macro: 'Macro' };
  const SRC = { bsky: 'Bluesky', masto: 'Mastodon', rss: 'RSS' };
  let feedFilter = 'all', feedTicker = null;

  function feedMatch(p) {
    if (p.hidden) return false;
    if (feedTicker && !p.tickers.includes(feedTicker)) return false;
    switch (feedFilter) {
      case 'outlets': return !!p.outlet;
      case 'whale': return p.kind === 'whale';
      case 'news': return p.kind === 'news' || p.kind === 'breaking' || p.src === 'rss';
      case 'hack': return p.kind === 'hack';
      case 'crowd': return !p.outlet;
      case 'stocks': return p.kind === 'stocks' || (p.ai && p.ai.kind === 'stocks') || p.tickers.some((t) => F.markets.stocks[t]);
      default: return true;
    }
  }

  function richText(t) {
    return F.esc(t)
      .replace(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/g, (m, s) => `<button class="tk" data-tk="${s.toUpperCase()}">$${s}</button>`)
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (m, a, u) => `${a}<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').slice(0, 34)}${u.length > 44 ? '…' : ''}</a>`)
      .replace(/\n/g, '<br>');
  }

  function postHTML(p) {
    const s = F.social.score(p);
    const av = p.author.avatar ? `<img class="av" src="${F.esc(p.author.avatar)}" alt="" loading="lazy" ${fallbackImg('av', initial(p.author.name))}>` : `<i class="av">${initial(p.author.name)}</i>`;
    const check = p.outlet || p.verified === 'bsky' ? VCHK : '';
    const handle = p.outlet ? p.outlet.h : '@' + p.author.handle;
    const w = p.whale && p.whale.usd ? `<div class="whale"><b>${F.usd(p.whale.usd, 0)}</b><span>${F.esc(p.whale.note)}</span></div>` : '';
    const link = p.link && p.src !== 'rss' && !p.text.includes(p.link) ? `<a class="lnk" href="${F.esc(p.link)}" target="_blank" rel="noopener">${F.esc(p.linkTitle || p.link.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</a>` : '';
    const img = p.img ? `<img class="pimg" src="${F.esc(p.img)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const ai = p.ai ? `<div class="aitk"><b>AI</b>${F.esc(p.ai.takeaway)}<em class="cred">· ${F.esc(p.ai.credibility)} credibility</em></div>` : '';
    const tag = KIND[p.kind] ? `<span class="tag ${p.kind}-t">${KIND[p.kind]}</span>` : '';
    const sent = s > 0 ? '<span class="bull">Bullish</span>' : s < 0 ? '<span class="bear">Bearish</span>' : '';
    return `<article class="post k-${p.kind}" data-id="${F.esc(p.id)}">
      ${av}
      <div class="pb">
        <div class="phd"><b>${F.esc(p.author.name)}</b>${check}<span class="hdl">${F.esc(handle)}</span><time title="${new Date(p.ts).toLocaleString()}">${F.ago(p.ts)}</time></div>
        <div class="ptx">${richText(p.text)}</div>
        ${w}${link}${img}${ai}
        <div class="pft">${tag}${sent}${p.likes ? `<span>♥ ${p.likes}</span>` : ''}<span>${SRC[p.src]}</span><a href="${F.esc(p.url)}" target="_blank" rel="noopener" class="open">Open ↗</a></div>
      </div>
    </article>`;
  }

  function renderFeed() {
    const list = F.$('#feedList');
    let anchor = null, off = 0;
    if (list.scrollTop > 60) {
      anchor = F.$$('.post', list).find((el) => el.offsetTop + el.offsetHeight > list.scrollTop);
      if (anchor) off = anchor.offsetTop - list.scrollTop;
    }
    const rows = F.social.all().filter(feedMatch).slice(0, 160);
    list.innerHTML = rows.length ? rows.map(postHTML).join('') : '<p class="empty">Nothing here yet. Feeds are loading or this filter is quiet.</p>';
    if (anchor) {
      const again = list.querySelector(`[data-id="${CSS.escape(anchor.dataset.id)}"]`);
      if (again) list.scrollTop = again.offsetTop - off;
    }
    const all = F.social.all();
    const f = F.social.filtered;
    const blocked = f.spam + f.dup + f.impostor + f.flood + f.offtopic;
    F.$('#feedMeta').innerHTML = `${all.length} posts · ${all.filter((p) => p.outlet).length} verified · <span title="off-topic ${f.offtopic} · duplicates ${f.dup} · spam ${f.spam} · impostors ${f.impostor} · floods ${f.flood}">${blocked} filtered out</span>`;
    const ft = F.$('#feedTicker');
    ft.hidden = !feedTicker;
    if (feedTicker) ft.innerHTML = `<span>Posts about <b>$${F.esc(feedTicker)}</b></span><button id="clearTk" type="button">Clear</button>`;
  }

  /* ================= RADAR ================= */
  let sortBy = 'fomo', hideRisky = true;
  const riskTxt = (r) => (r >= 60 ? `<span class="risk r3" title="Rug risk ${r}/100">Danger</span>` : r >= 30 ? `<span class="risk r2" title="Rug risk ${r}/100">Caution</span>` : `<span class="risk r1" title="Rug risk ${r}/100">Low</span>`);
  const scoreTag = (t) => {
    const lv = t.fomo >= 75 ? 4 : t.fomo >= 62 ? 3 : t.fomo >= 45 ? 2 : 1;
    return `<span class="score s${lv}" title="FOMO score: momentum + order flow + social buzz">${t.fomo}</span>`;
  };
  const age = (t) => (t.created ? F.ago(t.created) : '');
  const isNew = (t) => t.created && Date.now() - t.created < 86400000;
  const ico = (t, cls = 'ti') => (t.icon ? `<img class="${cls}" src="${F.esc(t.icon)}" alt="" loading="lazy" ${fallbackImg(cls, initial(t.sym))}>` : `<i class="${cls}">${initial(t.sym)}</i>`);
  const flowBar = (b, s) => (b + s ? `<span class="bar"><i class="b" style="flex:${b}"></i><i class="s" style="flex:${s}"></i></span>` : '<span class="bar"><i style="flex:1;background:var(--tile2)"></i></span>');
  const promoted = (t) => (t.src.has('boost') || t.src.has('profile')) && !t.src.has('trending');

  function renderRadar() {
    const held = F.bot ? F.bot.heldKeys() : new Set();
    let rows = F.radar.list();
    const total = rows.length;
    if (hideRisky) rows = rows.filter((t) => t.risk < 60 || held.has(t.key));
    const key = { fomo: (t) => t.fomo, h1: (t) => t.ch.h1 || 0, m5: (t) => t.ch.m5 || 0, vol: (t) => t.vol.h1 || 0, new: (t) => t.created || 0, risk: (t) => t.risk }[sortBy];
    rows.sort((a, b) => key(b) - key(a));
    rows = rows.slice(0, 60);
    F.$('#radarList').innerHTML =
      `<div class="rr rh"><span>Token</span><span>Price</span><span>5m</span><span>1h</span><span>24h</span><span>Liquidity</span><span>MC</span><span>Buys / sells</span><span>FOMO</span><span>Risk</span></div>` +
      (rows.length
        ? rows.map((t) => {
            const h1 = t.tx.h1 || { b: 0, s: 0 };
            const bp = h1.b + h1.s ? Math.round((h1.b / (h1.b + h1.s)) * 100) : null;
            return `<div class="rr${held.has(t.key) ? ' held' : ''}" data-key="${F.esc(t.key)}">
              <span class="tok">${ico(t)}<span><b>${F.esc(t.sym)} ${t.created ? `<em${isNew(t) ? '' : ' class="dim"'}>${age(t)}</em>` : ''}${held.has(t.key) ? '<span class="held-t">Holding</span>' : ''}</b><small><span class="pxs">$${F.price(t.price)} · </span>${F.usd(t.vol.h24)} Vol · ${F.esc(t.chain)}${promoted(t) ? ' · <span class="promo">Promoted</span>' : ''}</small></span></span>
              <span class="num">$${F.price(t.price)}</span>
              <span>${F.chg(t.ch.m5, 1)}</span>
              <span>${F.chg(t.ch.h1, 1)}</span>
              <span>${F.chg(t.ch.h24, 0)}</span>
              <span class="num">${F.usd(t.liq)}</span>
              <span class="num">${F.usd(t.mcap || t.fdv)}</span>
              <span class="flow">${flowBar(h1.b, h1.s)}<small>${bp == null ? '—' : bp + '% buys'}</small></span>
              <span>${scoreTag(t)}</span>
              <span>${riskTxt(t.risk)}</span>
            </div>`;
          }).join('')
        : '<p class="empty">Scanning DexScreener and GeckoTerminal…</p>');
    F.$('#radarMeta').textContent = `${total} tokens · ${total - F.radar.list().filter((t) => t.risk < 60 || held.has(t.key)).length} dangerous hidden`;
  }

  /* ================= MARKETS + FOOTER TICKER ================= */
  const TAPE = [['c', 'BTC'], ['c', 'ETH'], ['c', 'SOL'], ['c', 'HYPE'], ['c', 'DOGE'], ['s', 'SP500', 'S&P'], ['s', 'XYZ100', 'NDX'], ['s', 'NVDA'], ['s', 'TSLA']];
  const pxTxt = (o, kind) => (o.price == null ? '—' : kind === 'c' && o.price < 1 ? '$' + F.price(o.price) : F.usd(o.price, o.price >= 10000 ? 0 : 2));
  function buildTape() {
    F.$('#tape').innerHTML = TAPE.map(([k, s, label]) => `<span class="tp-${k}-${s}"><b>${label || s}</b><em>—</em><span class="chg flat">—</span></span>`).join('');
  }
  function paintTape(sym, kind, flash) {
    const o = kind === 'c' ? F.markets.crypto[sym] : F.markets.stocks[sym];
    const el = F.$(`.tp-${kind}-${sym}`);
    if (!o || o.price == null || !el) return;
    el.children[1].textContent = pxTxt(o, kind);
    el.children[2].outerHTML = F.chg(F.markets.chg(o));
    if (flash) {
      el.classList.remove('fl-up', 'fl-dn');
      void el.offsetWidth;
      el.classList.add(flash > 0 ? 'fl-up' : 'fl-dn');
    }
  }

  function renderMarkets() {
    const ny = F.nyse();
    const row = (o, kind) => `<div class="mr"><span class="nm"><b>${o.sym === 'XYZ100' ? 'NDX' : o.sym === 'SP500' ? 'SPX' : o.sym}</b><small>${F.esc(o.name)}</small></span><span class="num">${pxTxt(o, kind)}</span>${F.chg(F.markets.chg(o))}</div>`;
    F.$('#mktCrypto').innerHTML = F.markets.COINS.map(([s]) => row(F.markets.crypto[s], 'c')).join('');
    F.$('#mktStocks').innerHTML = F.markets.STOCKS.map(([s]) => row(F.markets.stocks[s], 's')).join('');
    F.$('#nyse').innerHTML = ny.open ? '<span class="up">● Market open</span>' : `Market ${F.esc(ny.label)}`;
    F.$('#stockNote').textContent = `Prices from Hyperliquid's 24/7 stock perps, which track each stock by oracle. ${ny.open ? 'The market is open, so they follow the live tape.' : 'The market is ' + ny.label + ', so they can drift from the last close.'} Change is vs 24h ago.`;
    const g = F.markets.gauges;
    if (g.fng != null) {
      F.$('#fng').innerHTML = `Fear &amp; Greed <b class="${g.fng >= 55 ? 'up' : g.fng < 45 ? 'dn' : ''}">${g.fng}</b>`;
      F.$('#fng').title = g.fngLabel + ' · alternative.me';
    }
    TAPE.forEach(([k, s]) => paintTape(s, k));
  }

  /* ================= TOKEN DRAWER ================= */
  let drawerKey = null;

  // Real 5-minute candles from GeckoTerminal for the same (deepest) pool DexScreener prices.
  const candles = {};
  const poolOf = (t) => {
    const net = t.gtNet || F.radar.DS2GT[t.chain];
    const pool = t.pair || t.gtPool;
    return net && pool ? { net, pool, k: net + ':' + pool } : null;
  };
  async function loadCandles(t) {
    const p = poolOf(t);
    if (!p) return null;
    const c = candles[p.k];
    if (c && Date.now() - c.at < 60000) return c.rows;
    const d = await F.fetchJSON(`https://api.geckoterminal.com/api/v2/networks/${p.net}/pools/${p.pool}/ohlcv/minute?aggregate=5&limit=72&currency=usd&token=${t.addr}`, { headers: { accept: 'application/json' } });
    const rows = (d.data.attributes.ohlcv_list || []).slice().reverse();
    candles[p.k] = { at: Date.now(), rows };
    return rows;
  }
  function candleSVG(rows) {
    if (!rows || rows.length < 2) return '<p class="empty">Not enough trading history for a chart yet.</p>';
    const w = 520, h = 150, vh = 28, ph = h - vh - 6;
    const lo = Math.min(...rows.map((r) => r[3])), hi = Math.max(...rows.map((r) => r[2]));
    const rng = hi - lo || hi * 0.01 || 1;
    const vmax = Math.max(...rows.map((r) => r[5])) || 1;
    const y = (v) => ((hi - v) / rng) * ph + 2;
    // fixed slot width, newest candle on the right — a 10-minute-old token shows two thin candles, not two slabs
    const cw = w / Math.max(rows.length, 60), bw = Math.max(1.2, cw * 0.62), x0 = w - rows.length * cw;
    const body = rows.map((r, i) => {
      const [, o, hh, l, c, v] = r;
      const x = x0 + i * cw + cw / 2, col = c >= o ? 'var(--up)' : 'var(--dn)';
      const top = y(Math.max(o, c)), bh = Math.max(1, Math.abs(y(o) - y(c)));
      return `<line x1="${x}" x2="${x}" y1="${y(hh)}" y2="${y(l)}" stroke="${col}" stroke-width="1" vector-effect="non-scaling-stroke"/>` +
        `<rect x="${x - bw / 2}" y="${top}" width="${bw}" height="${bh}" fill="${col}"/>` +
        `<rect x="${x - bw / 2}" y="${h - (v / vmax) * vh}" width="${bw}" height="${(v / vmax) * vh}" fill="${col}" opacity=".35"/>`;
    }).join('');
    const first = rows[0][1], last = rows[rows.length - 1][4];
    return `<svg class="candles" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${body}</svg>
      <div class="cax"><span>H $${F.price(hi)} · L $${F.price(lo)}</span><span>${F.ago(rows[0][0] * 1000)} ago → now ${F.chg((last / first - 1) * 100)}</span></div>`;
  }
  const chartHTML = (t) => {
    const p = poolOf(t);
    const c = p && candles[p.k];
    if (c) return candleSVG(c.rows);
    return p ? '<p class="empty">Loading chart…</p>' : F.spark(t.hist.map((x) => x[1]), 500, 120, 'wide');
  };
  function drawerHTML(t) {
    const tx = (w) => t.tx[w] || { b: 0, s: 0 };
    const held = F.bot.state().pos.find((p) => p.key === t.key);
    const ment = F.social.mentions(t.sym.toUpperCase(), 24 * 3600000).slice(0, 12);
    const p = t.parts || {};
    const flow = (w, label) => {
      const x = tx(w);
      return `<div class="flowrow"><div class="lbl"><span><b>${x.b.toLocaleString()}</b> <span class="mut">buys</span></span><span class="mut">${label}</span><span><b>${x.s.toLocaleString()}</b> <span class="mut">sells</span></span></div>${flowBar(x.b, x.s)}</div>`;
    };
    return `<button class="iconbtn dr-x" id="drClose" type="button">✕</button>
      <div class="dr-h">${ico(t, 'ti big')}<div><h2>${F.esc(t.sym)} <small>${F.esc(t.name)}</small></h2>
        <div class="sub"><span class="chain">${F.esc(t.chain)}</span><span>${F.esc(t.addr.slice(0, 5))}…${F.esc(t.addr.slice(-4))}</span><button class="xs" id="drCopy" type="button">Copy</button>${t.created ? `<span>${age(t)} old</span>` : ''}${promoted(t) ? '<span class="promo">Promoted</span>' : ''}</div></div></div>
      <div class="tiles dr-tiles">
        <div class="tile"><span>Market cap</span><b>${F.usd(t.mcap || t.fdv)}</b></div>
        <div class="tile"><span>Price</span><b>$${F.price(t.price)}</b></div>
        <div class="tile"><span>24H change</span><b>${F.chg(t.ch.h24)}</b></div>
        <div class="tile"><span>24H vol</span><b>${F.usd(t.vol.h24)}</b></div>
        <div class="tile"><span>Liquidity</span><b>${F.usd(t.liq)}</b></div>
      </div>
      <div class="dr-chart" id="drChart">${chartHTML(t)}</div>
      <p class="dr-note">${poolOf(t) ? '5-minute candles · GeckoTerminal' : 'Price since fomo radar started watching'} · price via ${F.esc(t.via || '—')}, updated ${F.ago(t.at)} ago</p>
      <div class="tf">${[['5M', 'm5'], ['1H', 'h1'], ['6H', 'h6'], ['24H', 'h24']].map(([l, w]) => `<div><span>${l}</span>${F.chg(t.ch[w])}</div>`).join('')}</div>
      ${flow('m5', 'last 5 min')}${flow('h1', 'last hour')}${flow('h24', 'last 24h')}
      <h3>Scores</h3>
      <div class="scores">
        <div class="tile"><span>FOMO</span><b>${scoreTag(t)}</b><small class="mut">momentum ${Math.round((p.mom || 0) * 100)} · ${Math.round((p.bp || 0) * 100)}% buys · volume accel ${Math.round((p.accel || 0) * 100)} · ${t.buzz} posts</small></div>
        <div class="tile"><span>Rug risk</span><b>${riskTxt(t.risk)} <span class="mut">${t.risk}/100</span></b><small class="mut">${t.flags.filter((f) => f[0] !== 'info').length} warning${t.flags.filter((f) => f[0] !== 'info').length === 1 ? '' : 's'}</small></div>
      </div>
      ${t.flags.length ? `<ul class="flags">${t.flags.map((f) => `<li class="${f[0]}">${F.esc(f[2])}</li>`).join('')}</ul>` : '<p class="ok">No risk flags tripped. That isn\'t the same as safe: meme coins can go to zero in minutes.</p>'}
      <div class="dr-bot">🤖 ${held ? `The bot holds <b>${F.usd(held.cost)}</b> of this, bought ${F.ago(held.openedAt)} ago at $${F.price(held.entryPx)}.` : 'The bot isn\'t holding this.'}</div>
      <div class="links">${F.radar.links(t).map(([n, u]) => `<a href="${F.esc(u)}" target="_blank" rel="noopener">${F.esc(n)} ↗</a>`).join('')}</div>
      <div class="dr-ai"><button class="btn go big" id="drAsk" type="button">Ask Claude for the honest read on ${F.esc(t.sym)}</button><div id="drAskOut" class="aiout" hidden></div></div>
      <h3>Posts mentioning $${F.esc(t.sym)} <small>${ment.length} in 24h</small></h3>
      <div class="dr-posts">${ment.length ? ment.map(postHTML).join('') : '<p class="empty">No posts with this cashtag yet. fomo radar searches Bluesky for the hottest tickers every few minutes.</p>'}</div>`;
  }
  function openDrawer(key) {
    const t = F.radar.get(key);
    if (!t) return;
    drawerKey = key;
    const d = F.$('#drawer');
    F.$('#drawerBody').innerHTML = drawerHTML(t);
    d.hidden = false;
    requestAnimationFrame(() => d.classList.add('open'));
    F.$('#drClose').onclick = closeDrawer;
    loadCandles(t)
      .then((rows) => {
        if (drawerKey === key && rows) F.$('#drChart').innerHTML = candleSVG(rows);
      })
      .catch(() => {
        if (drawerKey === key) F.$('#drChart').innerHTML = F.spark(t.hist.map((x) => x[1]), 500, 120, 'wide');
      });
    F.$('#drCopy').onclick = () => navigator.clipboard && navigator.clipboard.writeText(t.addr).then(() => F.toast('Address copied'));
    F.$('#drAsk').onclick = async () => {
      const out = F.$('#drAskOut');
      out.hidden = false;
      if (!F.ai.ready()) {
        out.innerHTML = 'Add a Claude API key in Settings to use this.';
        return;
      }
      out.innerHTML = '<span class="spin">🤖</span> Reading the numbers and the posts…';
      try {
        const r = await F.ai.ask(`Give me the honest read on $${t.sym}: what the numbers say, what people are posting, and the biggest risks. Is the FOMO real or manufactured?`, key);
        out.innerHTML = F.ai.linkify(r.text, r.ids);
      } catch (e) {
        out.innerHTML = 'Error: ' + F.esc(e.message);
      }
    };
  }
  function closeDrawer() {
    const d = F.$('#drawer');
    d.classList.remove('open');
    drawerKey = null;
    setTimeout(() => (d.hidden = true), 220);
  }

  /* ================= wiring ================= */
  F.panels = {
    openDrawer, closeDrawer,
    start() {
      buildTape();
      F.$('#feedFilters').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-f]');
        if (!b) return;
        feedFilter = b.dataset.f;
        F.$$('#feedFilters button').forEach((x) => x.classList.toggle('on', x === b));
        F.$('#feedList').scrollTop = 0;
        renderFeed();
      });
      document.addEventListener('click', (e) => {
        const tk = e.target.closest('.tk[data-tk]');
        if (tk) {
          feedTicker = tk.dataset.tk;
          F.$('#feedList').scrollTop = 0;
          renderFeed();
          F.emit('show-col', 'feed');
          return;
        }
        if (e.target.id === 'clearTk') {
          feedTicker = null;
          renderFeed();
          return;
        }
        const k = e.target.closest('[data-key]');
        if (k && !e.target.closest('#bot') && !e.target.closest('a[href^="http"]')) {
          e.preventDefault();
          openDrawer(k.dataset.key);
        }
      });
      F.$('#radarSort').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-s]');
        if (!b) return;
        sortBy = b.dataset.s;
        F.$$('#radarSort button').forEach((x) => x.classList.toggle('on', x === b));
        renderRadar();
      });
      F.$('#hideRisky').onchange = (e) => {
        hideRisky = e.target.checked;
        renderRadar();
      };
      document.addEventListener('keydown', (e) => e.key === 'Escape' && drawerKey && closeDrawer());

      let fd, rd, md;
      F.on('social', () => {
        clearTimeout(fd);
        fd = setTimeout(renderFeed, 250);
      });
      F.on('radar', () => {
        clearTimeout(rd);
        rd = setTimeout(() => {
          renderRadar();
          if (drawerKey && F.radar.get(drawerKey)) {
            // refresh the numbers without wiping an AI answer the user is reading
            const out = F.$('#drAskOut');
            const keep = out && !out.hidden ? out.innerHTML : null;
            const sc = F.$('#drawer').scrollTop;
            openDrawer(drawerKey);
            if (keep) {
              F.$('#drAskOut').hidden = false;
              F.$('#drAskOut').innerHTML = keep;
            }
            F.$('#drawer').scrollTop = sc;
          }
        }, 200);
      });
      F.on('markets', () => {
        clearTimeout(md);
        md = setTimeout(renderMarkets, 300);
      });
      F.on('tick', ({ sym, price, prev }) => paintTape(sym, 'c', prev == null ? 0 : price - prev));
      F.on('open-token', openDrawer);
      setInterval(renderMarkets, 5000);
      setInterval(() => F.$$('#feedList time').forEach((el) => {
        const p = F.social.byId(el.closest('.post').dataset.id);
        if (p) el.textContent = F.ago(p.ts);
      }), 20000);
      renderFeed();
      renderRadar();
      renderMarkets();
    },
  };
})();
