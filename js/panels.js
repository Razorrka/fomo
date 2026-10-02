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
        <div class="phd"><b>${F.esc(p.author.name)}</b>${check}<span class="hdl">${F.esc(handle)}</span><time data-ts="${p.ts}" title="${new Date(p.ts).toLocaleString()}">${F.ago(p.ts)}</time></div>
        <div class="ptx">${richText(p.text)}</div>
        ${w}${link}${img}${ai}
        <div class="pft">${tag}${sent}${p.likes ? `<span>♥ ${p.likes}</span>` : ''}<span>${SRC[p.src]}</span><a href="${F.esc(p.url)}" target="_blank" rel="noopener" class="open">Open ↗</a></div>
      </div>
    </article>`;
  }

  // Whale Alert posts in bursts. In the main feed, whale moves within 90 minutes of each other
  // collapse into one compact card so they can't drown out the news.
  const STABLES = /^(USDT|USDC|DAI|USDE|PYUSD|FDUSD|RLUSD|USD1|USDS)$/;
  const flowLabel = (w) => ({ inflow: 'to exchange', outflow: 'off exchange', mint: 'minted', burn: 'burned' })[w.flow] || 'transfer';
  function whaleGroupHTML(list) {
    const total = list.reduce((s, p) => s + ((p.whale && p.whale.usd) || 0), 0);
    return `<article class="post wgroup">
      <i class="av wav">🐋</i>
      <div class="pb">
        <div class="phd"><b>Whale Alert</b>${VCHK}<span class="hdl">${list.length} big moves · ${F.usd(total, 0)}</span><time data-ts="${list[0].ts}">${F.ago(list[0].ts)}</time></div>
        <div class="wrows">${list.map((p) => {
          const w = p.whale || {};
          const tone = p.sent > 0 ? 'up' : p.sent < 0 ? 'dn' : '';
          return `<a class="wrow" href="${F.esc(p.url)}" target="_blank" rel="noopener"><b>${w.usd ? F.usd(w.usd, 0) : '—'}</b><span class="wa${STABLES.test(w.asset || '') ? ' st' : ''}">${F.esc(w.asset || '?')}</span><span class="wft">${F.esc(w.from || '?')} → ${F.esc(w.to || '?')}</span><em class="${tone}">${flowLabel(w)}</em><time data-ts="${p.ts}">${F.ago(p.ts)}</time></a>`;
        }).join('')}</div>
      </div>
    </article>`;
  }

  function burstHTML(list) {
    const p0 = list[0];
    const av = p0.author.avatar ? `<img class="av" src="${F.esc(p0.author.avatar)}" alt="" loading="lazy" ${fallbackImg('av', initial(p0.author.name))}>` : `<i class="av">${initial(p0.author.name)}</i>`;
    return `<article class="post burst">
      ${av}
      <div class="pb">
        <div class="phd"><b>More from ${F.esc(p0.author.name)}</b>${VCHK}<span class="hdl">${list.length} posts</span><time data-ts="${p0.ts}">${F.ago(p0.ts)}</time></div>
        <div class="wrows">${list.map((p) => `<a class="hrow" href="${F.esc(p.url)}" target="_blank" rel="noopener"><span>${F.esc(p.text.split('\n')[0].slice(0, 140))}</span><time data-ts="${p.ts}">${F.ago(p.ts)}</time></a>`).join('')}</div>
      </div>
    </article>`;
  }

  // Main feed shaping, so no single source can take over:
  //  - Whale Alert moves within 90 min of each other collapse into one compact card
  //  - when one outlet posts 3+ times in a row, the first shows in full and the rest fold into a headline list
  function feedItems() {
    const rows = F.social.all().filter(feedMatch).slice(0, 200);
    const shaped = feedFilter === 'all';
    const used = new Set();
    const units = [];
    rows.forEach((p, i) => {
      if (used.has(p.id)) return;
      if (shaped && p.kind === 'whale') {
        const g = [p];
        for (let j = i + 1; j < rows.length && g.length < 8; j++) {
          const q = rows[j];
          if (q.kind === 'whale' && !used.has(q.id) && p.ts - q.ts < 90 * 60000) g.push(q);
        }
        g.forEach((q) => used.add(q.id));
        if (g.length > 1) return units.push({ whales: g });
      }
      used.add(p.id);
      units.push({ p });
    });
    const items = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.whales) {
        items.push({ key: 'g:' + u.whales[0].id, sig: u.whales.map((x) => x.id).join('|'), html: whaleGroupHTML(u.whales) });
        continue;
      }
      const p = u.p;
      items.push({ key: p.id, sig: p.id + '|' + (p.ai ? 1 : 0), html: postHTML(p) });
      if (!shaped || !p.outlet) continue;
      const run = [];
      while (i + 1 < units.length && units[i + 1].p && units[i + 1].p.outlet && units[i + 1].p.author.handle === p.author.handle) run.push(units[++i].p);
      if (run.length === 1) items.push({ key: run[0].id, sig: run[0].id + '|' + (run[0].ai ? 1 : 0), html: postHTML(run[0]) });
      else if (run.length > 1) items.push({ key: 'b:' + run[0].id, sig: run.map((x) => x.id).join('|'), html: burstHTML(run) });
    }
    return items.slice(0, 140);
  }

  // Keyed, in-place rendering: existing posts are never rebuilt (no image reloads, no jumping),
  // new ones slide in, and the reader's scroll position is held when posts land above them.
  const feedEls = new Map();
  let pendingNew = 0;
  const frag = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  function renderScan() {
    const list = F.$('#feedList');
    const html = F.scanner.html();
    if (list._scan !== html) {
      list.innerHTML = html;
      list._scan = html;
    }
    F.scanner.markViewed();
    paintScanBadge();
  }
  function paintScanBadge() {
    const n = feedFilter === 'scan' ? 0 : F.scanner.unseen();
    const b = F.$('#scanBadge');
    b.hidden = !n;
    b.textContent = n > 9 ? '9+' : n;
  }
  function renderFeed(reset) {
    if (feedFilter === 'scan') return renderScan();
    const list = F.$('#feedList');
    list._scan = null;
    if (reset) {
      list.innerHTML = '';
      feedEls.clear();
      list.scrollTop = 0;
      pendingNew = 0;
      F.$('#newPill').hidden = true;
    }
    const items = feedItems();
    const firstPaint = feedEls.size === 0;
    const scrolled = list.scrollTop > 40;
    const anchor = scrolled ? [...list.children].find((el) => el.offsetTop + el.offsetHeight > list.scrollTop) : null;
    const anchorOff = anchor ? anchor.offsetTop - list.scrollTop : 0;
    const keep = new Set(items.map((x) => x.key));
    feedEls.forEach((v, k) => {
      if (!keep.has(k)) {
        v.el.remove();
        feedEls.delete(k);
      }
    });
    const empty = list.querySelector('.empty');
    if (empty) empty.remove();
    let prev = null, fresh = 0;
    items.forEach((it) => {
      let v = feedEls.get(it.key);
      if (!v) {
        v = { el: frag(it.html), sig: it.sig };
        if (!firstPaint) {
          v.el.classList.add('enter');
          fresh++;
        }
        feedEls.set(it.key, v);
      } else if (v.sig !== it.sig) {
        const el = frag(it.html);
        v.el.replaceWith(el);
        v.el = el;
        v.sig = it.sig;
      }
      const want = prev ? prev.nextElementSibling : list.firstElementChild;
      if (want !== v.el) list.insertBefore(v.el, want);
      prev = v.el;
    });
    if (!items.length) list.innerHTML = '<p class="empty">Nothing here yet. Feeds are loading or this filter is quiet.</p>';
    if (anchor && anchor.isConnected) list.scrollTop = anchor.offsetTop - anchorOff;
    if (scrolled && fresh) {
      pendingNew += fresh;
      const pill = F.$('#newPill');
      pill.textContent = `↑ ${pendingNew} new post${pendingNew > 1 ? 's' : ''}`;
      pill.hidden = false;
    }
    const all = F.social.all();
    const f = F.social.filtered;
    const blocked = f.spam + f.dup + f.impostor + f.flood + f.offtopic;
    const srcs = new Set(all.map((p) => p.author.handle)).size;
    F.$('#feedMeta').innerHTML = `<i class="dot ok"></i>${all.length} posts from ${srcs} sources · ${all.filter((p) => p.outlet).length} verified · <span title="off-topic ${f.offtopic} · duplicates ${f.dup} · spam ${f.spam} · impostors ${f.impostor} · floods ${f.flood}">${blocked} filtered out</span>`;
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

  // cells[0] is the token text (the icon is kept separately so it never reloads)
  function radarCells(t, held) {
    const h1 = t.tx.h1 || { b: 0, s: 0 };
    const bp = h1.b + h1.s ? Math.round((h1.b / (h1.b + h1.s)) * 100) : null;
    return [
      `<b>${F.esc(t.sym)} ${t.created ? `<em${isNew(t) ? '' : ' class="dim"'}>${age(t)}</em>` : ''}${held ? '<span class="held-t">Holding</span>' : ''}</b><small><span class="pxs">$${F.price(t.price)} · </span>${F.usd(t.vol.h24)} Vol · ${F.esc(t.chain)}${promoted(t) ? ' · <span class="promo">Promoted</span>' : ''}</small>`,
      `$${F.price(t.price)}`,
      F.usd(t.mcap || t.fdv),
      F.chg(t.ch.m5, 1),
      F.chg(t.ch.h1, 1),
      F.usd(t.liq),
      `${flowBar(h1.b, h1.s)}<small>${bp == null ? '—' : bp + '% buys'}</small>`,
      scoreTag(t),
      riskTxt(t.risk),
      verdictTag(t.sig),
    ];
  }
  const CELL_CLS = ['tok', 'num px', 'num', '', '', 'num', 'flow', '', '', ''];
  const rowEls = new Map();
  function flash(el, dir) {
    el.classList.remove('fl-up', 'fl-dn');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'fl-up' : 'fl-dn');
  }
  function renderRadar() {
    const held = F.bot ? F.bot.heldKeys() : new Set();
    const all = F.radar.list();
    let rows = hideRisky ? all.filter((t) => t.risk < 60 || held.has(t.key)) : all.slice();
    const hidden = all.length - rows.length;
    const vrank = (t) => (t.sig ? { buy: 2, wait: 1, skip: 0 }[t.sig.label] * 1000 + t.sig.p * 100 : 0);
    const key = { fomo: (t) => vrank(t) + t.fomo / 100, h1: (t) => t.ch.h1 || 0, m5: (t) => t.ch.m5 || 0, vol: (t) => t.vol.h1 || 0, new: (t) => t.created || 0, risk: (t) => t.risk }[sortBy];
    rows.sort((a, b) => key(b) - key(a) || a.key.localeCompare(b.key));
    rows = rows.slice(0, 60);
    const list = F.$('#radarList');
    let head = list.querySelector('.rh');
    if (!head) {
      list.innerHTML = '<div class="rr rh"><span>Token</span><span>Price</span><span>MC</span><span>5m</span><span>1h</span><span>Liquidity</span><span>Buys / sells</span><span>FOMO</span><span>Risk</span><span>Verdict</span></div>';
      head = list.firstElementChild;
    }
    const empty = list.querySelector('.empty');
    if (!rows.length) {
      rowEls.forEach((el) => el.remove());
      rowEls.clear();
      if (!empty) list.insertAdjacentHTML('beforeend', '<p class="empty">Scanning DexScreener and GeckoTerminal…</p>');
    } else if (empty) empty.remove();
    // FLIP: remember where every row was, rearrange, then animate each row from old spot to new
    const before = new Map();
    rowEls.forEach((el, k) => before.set(k, el.getBoundingClientRect().top));
    const keep = new Set(rows.map((t) => t.key));
    rowEls.forEach((el, k) => {
      if (!keep.has(k)) {
        el.remove();
        rowEls.delete(k);
      }
    });
    let prev = head;
    rows.forEach((t) => {
      const cells = radarCells(t, held.has(t.key));
      let el = rowEls.get(t.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'rr' + (before.size ? ' enter' : '');
        el.dataset.key = t.key;
        el.innerHTML = cells.map((c, i) => (i === 0 ? `<span class="tok">${ico(t)}<span>${c}</span></span>` : `<span class="${CELL_CLS[i]}">${c}</span>`)).join('');
        el._c = cells;
        el._px = t.price;
        rowEls.set(t.key, el);
      } else {
        cells.forEach((c, i) => {
          if (el._c[i] === c) return;
          if (i === 0) el.children[0].children[1].innerHTML = c;
          else el.children[i].innerHTML = c;
        });
        if (t.price !== el._px && el._px != null && t.price != null) flash(el.children[1], t.price - el._px);
        el._c = cells;
        el._px = t.price;
      }
      el.classList.toggle('held', held.has(t.key));
      if (prev.nextElementSibling !== el) list.insertBefore(el, prev.nextElementSibling);
      prev = el;
    });
    rowEls.forEach((el, k) => {
      const was = before.get(k);
      if (was == null) return;
      const d = was - el.getBoundingClientRect().top;
      if (Math.abs(d) > 2) el.animate([{ transform: `translateY(${d}px)` }, { transform: 'translateY(0)' }], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
    radarMeta.total = all.length;
    radarMeta.hidden = hidden;
    paintRadarMeta();
  }
  const radarMeta = { total: 0, hidden: 0 };
  function paintRadarMeta() {
    const secs = F.radar.lastRefresh ? Math.max(0, Math.round((Date.now() - F.radar.lastRefresh) / 1000)) : null;
    F.$('#radarMeta').innerHTML = `${radarMeta.total} tokens · ${radarMeta.hidden} dangerous hidden · <span class="livetag"><i class="dot ok"></i>${secs == null ? 'connecting' : secs < 2 ? 'just updated' : secs + 's ago'}</span>`;
  }

  /* ================= MARKETS + FOOTER TICKER ================= */
  const TAPE = [['c', 'BTC'], ['c', 'ETH'], ['c', 'SOL'], ['c', 'HYPE'], ['c', 'DOGE'], ['s', 'SP500', 'S&P'], ['s', 'XYZ100', 'NDX'], ['s', 'NVDA'], ['s', 'TSLA']];
  const pxTxt = (o, kind) => (o.price == null ? '—' : kind === 'c' && o.price < 1 ? '$' + F.price(o.price) : F.usd(o.price, o.price >= 10000 ? 0 : 2));
  function buildTape() {
    F.$('#tape').innerHTML = TAPE.map(([k, s, label]) => `<span class="tp-${k}-${s}"><b>${label || s}</b><em>—</em><span class="chg flat">—</span></span>`).join('');
  }
  let mktBuilt = false;
  function buildMarkets() {
    const row = (o, kind) => `<div class="mr" id="mk-${kind}-${o.sym}"><span class="nm"><b>${o.sym === 'XYZ100' ? 'NDX' : o.sym === 'SP500' ? 'SPX' : o.sym}</b><small>${F.esc(o.name)}</small></span><span class="num">—</span><span class="chg flat">—</span></div>`;
    F.$('#mktCrypto').innerHTML = F.markets.COINS.map(([s]) => row(F.markets.crypto[s], 'c')).join('');
    F.$('#mktStocks').innerHTML = F.markets.STOCKS.map(([s]) => row(F.markets.stocks[s], 's')).join('');
    mktBuilt = true;
  }
  // paint one symbol everywhere it appears (markets card + footer), flashing on change
  const painted = {};
  function paintSym(kind, sym) {
    const o = kind === 'c' ? F.markets.crypto[sym] : F.markets.stocks[sym];
    if (!o || o.price == null) return;
    const id = kind + sym;
    const last = painted[id];
    painted[id] = o.price;
    const chg = F.chg(F.markets.chg(o));
    [F.$(`#mk-${kind}-${sym}`), F.$(`.tp-${kind}-${sym}`)].forEach((el) => {
      if (!el) return;
      el.children[1].textContent = pxTxt(o, kind);
      if (el.children[2].outerHTML !== chg) el.children[2].outerHTML = chg;
      if (last != null && last !== o.price) flash(el.children[1], o.price - last);
    });
  }
  // websocket ticks arrive many times a second; repaint each symbol at most every 400ms
  const tickTimers = {};
  function onTick(kind, sym) {
    const id = kind + sym;
    if (tickTimers[id]) return;
    tickTimers[id] = setTimeout(() => {
      tickTimers[id] = null;
      paintSym(kind, sym);
    }, 1000);
  }

  function renderMarkets() {
    if (!mktBuilt) buildMarkets();
    const ny = F.nyse();
    F.markets.COINS.forEach(([s]) => paintSym('c', s));
    F.markets.STOCKS.forEach(([s]) => paintSym('s', s));
    F.$('#nyse').innerHTML = ny.open ? '<span class="up">● Market open</span>' : `Market ${F.esc(ny.label)}`;
    F.$('#stockNote').textContent = `Live prices from Hyperliquid's 24/7 stock perps, which track each stock by oracle. ${ny.open ? 'The market is open, so they follow the live tape.' : 'The market is ' + ny.label + ', so they can drift from the last close.'} Change is vs 24h ago.`;
    const g = F.markets.gauges;
    if (g.fng != null) {
      F.$('#fng').innerHTML = `Fear &amp; Greed <b class="${g.fng >= 55 ? 'up' : g.fng < 45 ? 'dn' : ''}">${g.fng}</b>`;
      F.$('#fng').title = g.fngLabel + ' · alternative.me';
    }
  }

  /* ================= LIVE CALLS ================= */
  const FACTOR_LABEL = { mom: 'Momentum', accel: 'Volume pace', flow: 'Buy pressure', traders: 'Unique wallets', tape: 'Live tape', trend: 'Candle trend', heat: 'Heat (RSI)', depth: 'Liquidity', safety: 'Safety', buzz: 'Social buzz', exhaust: 'Exhaustion' };
  const VERDICT = { buy: 'Worth buying', wait: 'Wait', skip: 'Not worth it' };
  const verdictTag = (s) => (s ? `<span class="vd ${s.label}" title="${F.esc(s.reason || '')}">${VERDICT[s.label]}</span>` : '<span class="vd wait">…</span>');
  const pctOf = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(x * 100 >= 10 || x * 100 <= -10 ? 0 : 1)}%`;
  function ladderHTML(s, price) {
    return `<div class="ladder">
      <div class="lv stop"><span>Stop</span><b>$${F.price(s.stop)}</b><em>${pctOf(-s.stopPct)}</em></div>
      <div class="lv entry"><span>Now</span><b>$${F.price(price)}</b><em>buy under $${F.price(s.maxEntry)}</em></div>
      <div class="lv tp"><span>Target</span><b>$${F.price(s.tp1)}</b><em>${pctOf(s.tp1Pct)} · sell half</em></div>
      <div class="lv tp2"><span>Runner</span><b>$${F.price(s.tp2)}</b><em>${pctOf(s.tp2Pct)} · trail the rest</em></div>
    </div>`;
  }
  const aiTakes = {};
  let aiBusy = false, aiLast = 0;
  function callCard(t, rank) {
    const s = t.sig;
    if (rank > 0)
      return `<div class="call mini" data-key="${F.esc(t.key)}">${ico(t)}<div class="nm"><b>${F.esc(t.sym)}</b><small>${F.esc(t.chain)} · ${F.usd(t.mcap || t.fdv)} MC</small></div><div class="mn"><b>${Math.round(s.p * 100)}%</b><small>odds</small></div><div class="mn"><b class="${F.dir(s.ev)}">${pctOf(s.ev)}</b><small>EV</small></div><div class="mn"><b>$${F.price(s.stop)}</b><small>stop</small></div><div class="mn"><b>$${F.price(s.tp1)}</b><small>target</small></div>${verdictTag(s)}</div>`;
    const size = F.bot.tradeSize(t), fee = F.bot.feePct() / 100;
    const lose = size * (s.stopPct + 2 * fee + s.slip);
    const take = aiTakes[t.key];
    return `<div class="call" data-key="${F.esc(t.key)}">
      <div class="call-h">${ico(t)}<div class="nm"><b>${F.esc(t.sym)}</b><small>${F.esc(t.chain)} · ${t.created ? age(t) + ' old · ' : ''}${F.usd(t.mcap || t.fdv)} MC · ${F.usd(t.liq)} liquidity</small></div>${rank === 0 ? '<span class="vd buy big">Worth buying 🚀</span>' : verdictTag(s)}</div>
      <div class="call-nums">
        <div><span>Odds</span><b>${Math.round(s.p * 100)}%</b><small>target before stop</small></div>
        <div><span>Expected value</span><b class="${F.dir(s.ev)}">${pctOf(s.ev)}</b><small>per trade, after fees</small></div>
        <div><span>When</span><b>Now</b><small>skip it above $${F.price(s.maxEntry)}</small></div>
      </div>
      ${ladderHTML(s, t.price)}
      <p class="size">With your bot settings: <b>${F.usd(size)}</b> in → ${F.usd(size * (1 - fee))} into the coin after the ${F.bot.feePct()}% fee. If the stop hits you lose about <b>${F.usd(lose)}</b>.</p>
      <ul class="why">${s.why.map((x) => `<li class="pro">${F.esc(x.txt)}</li>`).join('')}${s.against.map((x) => `<li class="con">${F.esc(x.txt)}</li>`).join('')}</ul>
      ${take ? `<p class="take ${take.verdict === 'buy' ? 'agree' : 'disagree'}">🧠 Claude ${take.verdict === 'buy' ? 'agrees' : 'disagrees'} (conviction ${take.conviction}): ${F.esc(take.thesis)}${take.red_flags && take.red_flags.length ? ' · Red flags: ' + F.esc(take.red_flags.join('; ')) : ''}</p>` : ''}
    </div>`;
  }
  function trackHTML() {
    const st = F.engine.stats();
    const recent = F.engine.calls().slice(0, 8);
    const chip = (c) => {
      if (c.status === 'open') {
        const t = F.radar.get(c.key);
        const r = t && t.price ? t.price / c.entry - 1 : 0;
        return `<span class="cc open" title="open ${F.ago(c.at)}">${F.esc(c.sym)} <em class="${F.dir(r)}">${pctOf(r)}</em> live</span>`;
      }
      const ok = c.status === 'win' || (c.status === 'timeout' && c.net > 0);
      return `<span class="cc ${ok ? 'win' : 'loss'}" title="${c.status} · ${F.ago(c.closedAt)} ago">${ok ? '✓' : '✗'} ${F.esc(c.sym)} <em>${pctOf(c.net)}</em></span>`;
    };
    const head = st.n
      ? `<b>${st.n}</b> graded calls in 7 days · <b>${Math.round(st.hit * 100)}%</b> hit · <b class="${F.dir(st.avgNet)}">${pctOf(st.avgNet)}</b> average per call after fees${st.open ? ` · ${st.open} open` : ''}`
      : `No graded calls yet${st.open ? ` · ${st.open} open now` : ''}. Every “Worth buying” call is logged and graded against the live price (target, stop, or 2-hour timeout), wins and losses alike.`;
    const cal = st.n ? `<div class="cal">${st.buckets.map(([l, b]) => `<span>${l} odds: ${b.n ? `${Math.round(b.hit * 100)}% hit of ${b.n}` : '—'}</span>`).join('')}<span>model learned from ${st.learned} result${st.learned === 1 ? '' : 's'}</span></div>` : '';
    return `<p class="track-h">Track record: ${head}</p>${cal}${recent.length ? `<div class="chips2">${recent.map(chip).join('')}</div>` : ''}`;
  }
  function renderCalls() {
    const best = F.engine.best(3);
    let html;
    if (best.length) html = best.map(callCard).join('');
    else {
      const near = F.radar.list().filter((t) => t.sig && t.sig.label === 'wait').sort((a, b) => b.sig.p - a.sig.p).slice(0, 3);
      html = `<div class="nocall"><b>Nothing worth buying right now.</b> The engine only calls a buy when the odds and the expected value after fees are both on your side.${near.length ? `<ul>${near.map((t) => `<li data-key="${F.esc(t.key)}"><span class="score s2">${Math.round(t.sig.p * 100)}%</span><b>${F.esc(t.sym)}</b><span class="mut">${F.esc(t.sig.reason)}</span></li>`).join('')}</ul>` : ''}</div>`;
    }
    const body = F.$('#callsBody');
    if (body._h !== html) {
      body.innerHTML = html;
      body._h = html;
    }
    const tr = trackHTML();
    const track = F.$('#callsTrack');
    if (track._h !== tr) {
      track.innerHTML = tr;
      track._h = tr;
    }
    const n = F.radar.list().filter((t) => t.sig && t.sig.label === 'buy').length;
    F.$('#callsMeta').innerHTML = `${n} worth buying · ${F.radar.list().filter((t) => t.sig && t.sig.label === 'skip').length} not worth it`;
    // Claude's second opinion on the top call (one at a time, at most every 2 minutes)
    const top = best[0];
    if (top && F.ai && F.ai.ready() && !aiTakes[top.key] && !aiBusy && Date.now() - aiLast > 120000) {
      aiBusy = true;
      aiLast = Date.now();
      F.ai.copilot(top, F.social.mentions(top.sym.toUpperCase(), 6 * 3600000).slice(0, 10), F.bot.PRESETS.degen)
        .then((v) => (aiTakes[top.key] = v))
        .catch(() => {})
        .finally(() => {
          aiBusy = false;
          renderCalls();
        });
    }
  }

  /* ================= TOKEN DRAWER ================= */
  let drawerKey = null;

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
    const rows = F.candles.get(t);
    if (rows) return candleSVG(rows);
    return F.candles.hasPool(t) ? '<p class="empty">Loading chart…</p>' : F.spark(t.hist.map((x) => x[1]), 500, 120, 'wide');
  };
  function drawerCallHTML(t) {
    const s = t.sig;
    if (!s) return '';
    const bars = F.engine.FACTORS.map((k) => {
      const v = (s.f[k] || 0);
      return `<div class="fb"><span>${FACTOR_LABEL[k]}</span><i class="fbar"><i class="${v >= 0 ? 'pos' : 'neg'}" style="${v >= 0 ? 'left:50%' : `left:${50 + v * 50}%`};width:${Math.abs(v) * 50}%"></i></i><em class="${F.dir(v)}">${v >= 0 ? '+' : ''}${v.toFixed(2)}</em></div>`;
    }).join('');
    const sf = t.safety;
    const safe = sf
      ? `<div class="safe"><b>${F.esc(sf.src)} check</b><span>Top 10 wallets: <b>${sf.top10.toFixed(0)}%</b></span>${sf.holders ? `<span>Holders: <b>${sf.holders.toLocaleString()}</b></span>` : ''}<span>Mint: <b class="${sf.mint ? 'dn' : 'up'}">${sf.mint ? 'ON' : 'off'}</b></span><span>Freeze: <b class="${sf.freeze ? 'dn' : 'up'}">${sf.freeze ? 'ON' : 'off'}</b></span>${sf.src === 'RugCheck' || sf.lpLocked ? `<span>LP locked: <b>${sf.lpLocked.toFixed(0)}%</b></span>` : ''}${sf.insiderPct ? `<span>Insiders: <b>${sf.insiderPct.toFixed(0)}%</b></span>` : ''}${sf.sellTax ? `<span>Sell tax: <b class="dn">${sf.sellTax.toFixed(1)}%</b></span>` : ''}${sf.honeypot ? '<span><b class="dn">HONEYPOT</b></span>' : ''}</div>`
      : `<div class="safe"><span class="mut">${t.chain === 'solana' || ['ethereum', 'bsc', 'base', 'arbitrum'].includes(t.chain) ? 'Contract and holder check runs when this coin gets close to a call.' : 'No contract scanner covers this chain — be extra careful.'}</span></div>`;
    return `<div class="dcall ${s.label}">
      <div class="dcall-h">${verdictTag(s)}<span class="mut">${F.esc(s.reason || (s.label === 'buy' ? 'Odds and expected value both clear the bar.' : ''))}</span></div>
      <div class="call-nums"><div><span>Odds</span><b>${Math.round(s.p * 100)}%</b><small>target before stop</small></div><div><span>Expected value</span><b class="${F.dir(s.ev)}">${pctOf(s.ev)}</b><small>after fees</small></div><div><span>Volatility</span><b>${s.atr ? (s.atr * 100).toFixed(1) + '%' : '—'}</b><small>per 5-min candle</small></div></div>
      ${ladderHTML(s, t.price)}
      <h4>What the model sees</h4><div class="fbars">${bars}</div>
      ${safe}
    </div>`;
  }

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
      <div class="tiles dr-tiles" data-live="tiles">
        <div class="tile"><span>Market cap</span><b>${F.usd(t.mcap || t.fdv)}</b></div>
        <div class="tile"><span>Price</span><b>$${F.price(t.price)}</b></div>
        <div class="tile"><span>24H change</span><b>${F.chg(t.ch.h24)}</b></div>
        <div class="tile"><span>24H vol</span><b>${F.usd(t.vol.h24)}</b></div>
        <div class="tile"><span>Liquidity</span><b>${F.usd(t.liq)}</b></div>
      </div>
      <div data-live="call">${drawerCallHTML(t)}</div>
      <div class="dr-chart" id="drChart">${chartHTML(t)}</div>
      <p class="dr-note" data-live="note">${F.candles.hasPool(t) ? '5-minute candles · GeckoTerminal' : 'Price since fomo radar started watching'} · price via ${F.esc(t.via || '—')}, updated ${F.ago(t.at)} ago</p>
      <div class="tf" data-live="tf">${[['5M', 'm5'], ['1H', 'h1'], ['6H', 'h6'], ['24H', 'h24']].map(([l, w]) => `<div><span>${l}</span>${F.chg(t.ch[w])}</div>`).join('')}</div>
      <div data-live="flow">${flow('m5', 'last 5 min')}${flow('h1', 'last hour')}${flow('h24', 'last 24h')}</div>
      <h3>Scores</h3>
      <div class="scores" data-live="scores">
        <div class="tile"><span>FOMO</span><b>${scoreTag(t)}</b><small class="mut">momentum ${Math.round((p.mom || 0) * 100)} · ${Math.round((p.bp || 0) * 100)}% buys · volume accel ${Math.round((p.accel || 0) * 100)} · ${t.buzz} posts</small></div>
        <div class="tile"><span>Rug risk</span><b>${riskTxt(t.risk)} <span class="mut">${t.risk}/100</span></b><small class="mut">${t.flags.filter((f) => f[0] !== 'info').length} warning${t.flags.filter((f) => f[0] !== 'info').length === 1 ? '' : 's'}</small></div>
      </div>
      <div data-live="flags">${t.flags.length ? `<ul class="flags">${t.flags.map((f) => `<li class="${f[0]}">${F.esc(f[2])}</li>`).join('')}</ul>` : '<p class="ok">No risk flags tripped. That isn\'t the same as safe: meme coins can go to zero in minutes.</p>'}</div>
      <div class="dr-bot" data-live="bot">🤖 ${held ? `The bot holds <b>${F.usd(held.cost)}</b> of this, bought ${F.ago(held.openedAt)} ago at $${F.price(held.entryPx)}.` : 'The bot isn\'t holding this.'}</div>
      <div class="links">${F.radar.links(t).map(([n, u]) => `<a href="${F.esc(u)}" target="_blank" rel="noopener">${F.esc(n)} ↗</a>`).join('')}</div>
      <div class="dr-ai"><button class="btn go big" id="drAsk" type="button">Ask Claude for the honest read on ${F.esc(t.sym)}</button><div id="drAskOut" class="aiout" hidden></div></div>
      <h3 data-live="ph">Posts mentioning $${F.esc(t.sym)} <small>${ment.length} in 24h</small></h3>
      <div class="dr-posts" data-live="posts">${ment.length ? ment.map(postHTML).join('') : '<p class="empty">No posts with this cashtag yet. fomo radar searches Bluesky for the hottest tickers every few minutes.</p>'}</div>`;
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
    F.candles.load(t)
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
  // Live refresh: only the sections whose content changed are swapped, so the open drawer never flickers
  // and an AI answer being read stays put. Candles re-pull once a minute.
  function refreshDrawer() {
    const t = F.radar.get(drawerKey);
    if (!t) return;
    const next = document.createElement('div');
    next.innerHTML = drawerHTML(t);
    F.$$('#drawerBody [data-live]').forEach((el) => {
      const n = next.querySelector(`[data-live="${el.dataset.live}"]`);
      if (n && n.innerHTML !== el.innerHTML) el.innerHTML = n.innerHTML;
    });
    if (F.candles.hasPool(t))
      F.candles.load(t)
        .then((rows) => {
          if (drawerKey === t.key && rows) {
            const html = candleSVG(rows);
            if (F.$('#drChart')._h !== html) F.$('#drChart').innerHTML = F.$('#drChart')._h = html;
          }
        })
        .catch(() => {});
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
        renderFeed(true);
      });
      document.addEventListener('click', (e) => {
        const tk = e.target.closest('.tk[data-tk]');
        if (tk) {
          feedTicker = tk.dataset.tk;
          renderFeed(true);
          F.emit('show-col', 'feed');
          return;
        }
        if (e.target.id === 'clearTk') {
          feedTicker = null;
          renderFeed(true);
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
      F.on('scan', () => (feedFilter === 'scan' ? renderScan() : paintScanBadge()));
      F.on('radar', () => {
        clearTimeout(rd);
        rd = setTimeout(() => {
          renderRadar();
          renderCalls();
          if (feedFilter === 'scan') renderScan();
          if (drawerKey) refreshDrawer();
        }, 200);
      });
      F.on('markets', () => {
        clearTimeout(md);
        md = setTimeout(renderMarkets, 300);
      });
      F.on('tick', ({ sym }) => onTick('c', sym));
      F.on('stocktick', ({ sym }) => onTick('s', sym));
      const fl = F.$('#feedList');
      F.$('#newPill').onclick = () => {
        fl.scrollTo({ top: 0, behavior: 'smooth' });
        pendingNew = 0;
        F.$('#newPill').hidden = true;
      };
      fl.addEventListener('scroll', () => {
        if (fl.scrollTop < 30 && pendingNew) {
          pendingNew = 0;
          F.$('#newPill').hidden = true;
        }
      }, { passive: true });
      setInterval(paintRadarMeta, 1000);
      F.on('open-token', openDrawer);
      setInterval(renderMarkets, 5000);
      setInterval(() => F.$$('time[data-ts]').forEach((el) => (el.textContent = F.ago(+el.dataset.ts))), 15000);
      renderFeed();
      renderRadar();
      renderCalls();
      renderMarkets();
      F.on('call:new', (c) => {
        renderCalls();
        F.toast(`🤖 New call: ${c.sym} is worth buying (${Math.round(c.p * 100)}% odds)`, 'good');
      });
      F.on('call:closed', () => renderCalls());
    },
  };
})();
