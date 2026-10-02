/* fomo — the scanner: new coins and announcements, from the sources that actually announce them.
     · Exchange listings: Binance's official listing / delisting announcements, OKX's newest markets,
       new Coinbase markets and new Hyperliquid perps (detected by diffing against what fomo saw before).
     · New coins: fresh pools with real liquidity and pump.fun graduations (GeckoTerminal), each fed into the
       radar so it gets the full rug check and a verdict.
     · Announcements in posts: listing / launch / airdrop / contract-drop posts from the feed. */
(function () {
  const F = window.F;
  const S = Object.assign({ v: 1, base: {}, baseAt: {}, items: [], viewedAt: 0 }, F.store.get('scan', {}));
  const save = () => F.store.set('scan', S);
  const checked = {};
  let booting = true;

  function addItem(it) {
    if (S.items.some((x) => x.id === it.id)) return false;
    S.items.push(it);
    S.items.sort((a, b) => b.ts - a.ts);
    if (S.items.length > 250) S.items.length = 250;
    // alert on genuinely fresh exchange news, never on the backlog loaded at start-up
    if (!booting && it.group === 'listing' && Date.now() - it.ts < 30 * 60000) F.emit('scan:alert', it);
    return true;
  }
  const tickersIn = (title) => {
    const out = new Set();
    for (const m of title.matchAll(/\(([A-Z0-9]{2,12})\)/g)) out.add(m[1]);
    for (const m of title.matchAll(/\b([A-Z0-9]{2,12})USDT?\b/g)) if (m[1].length > 1) out.add(m[1]);
    return [...out].slice(0, 6);
  };

  /* ---------- Binance: official announcements (new listings + delistings) ---------- */
  async function pollBinance() {
    for (const [cat, group] of [[48, 'listing'], [161, 'delisting']]) {
      try {
        const d = await F.fetchJSON(`https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${cat}&pageNo=1&pageSize=10`);
        const arts = (((d.data || {}).catalogs || [])[0] || {}).articles || [];
        arts.forEach((a) => {
          const t = a.title;
          const tag = group === 'delisting' ? 'Delisting' : /futures|perpetual/i.test(t) ? 'Futures' : /alpha/i.test(t) ? 'Binance Alpha' : /bstocks|stock trading|stocks? on/i.test(t) ? 'Stocks' : /will list|adds?\b/i.test(t) ? 'Spot listing' : 'Listing';
          addItem({ id: 'bn:' + a.id, group, ex: 'Binance', title: t.replace(/\s*[-–]\s*\d{4}-\d{2}-\d{2}$/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ''), tag, ts: a.releaseDate, url: `https://www.binance.com/en/support/announcement/detail/${a.code}`, tickers: tickersIn(t) });
        });
        checked.binance = Date.now();
      } catch (e) {
        F.health.fail('scanner', 'Binance: ' + e.message);
      }
    }
  }

  /* ---------- OKX: markets listed in the last 7 days, or opening soon ---------- */
  async function pollOKX() {
    try {
      const d = await F.fetchJSON('https://www.okx.com/api/v5/public/instruments?instType=SPOT');
      // a coin is new to OKX only if *every* market for it is recent — a new BTC/PLN pair is not a new listing
      const all = {};
      (d.data || []).forEach((x) => (all[x.baseCcy] = all[x.baseCcy] || []).push(x));
      const byBase = {};
      Object.entries(all).forEach(([base, list]) => {
        const first = Math.min(...list.map((x) => +x.listTime || 0));
        if (list.some((x) => x.state === 'preopen') || (first && Date.now() - first < 7 * 86400000)) byBase[base] = list;
      });
      Object.entries(byBase).forEach(([base, list]) => {
        const lt = Math.min(...list.map((x) => +x.listTime));
        const soon = lt > Date.now() || list.some((x) => x.state === 'preopen');
        addItem({ id: 'okx:' + base + ':' + lt, group: 'listing', ex: 'OKX', title: `OKX ${soon ? 'opens' : 'listed'} ${base} (${list.map((x) => x.quoteCcy).join(', ')} pairs)`, tag: soon ? 'Opening soon' : 'Spot listing', ts: Math.min(lt, Date.now()), url: `https://www.okx.com/trade-spot/${list[0].instId.toLowerCase()}`, tickers: [base] });
      });
      checked.okx = Date.now();
    } catch (e) {
      F.health.fail('scanner', 'OKX: ' + e.message);
    }
  }

  /* ---------- Coinbase + Hyperliquid: anything that wasn't there last time is a new listing ---------- */
  function diffBaseline(name, ids, make) {
    if (!S.base[name]) {
      S.base[name] = ids;
      S.baseAt[name] = Date.now();
      return;
    }
    const known = new Set(S.base[name]);
    ids.filter((id) => !known.has(id)).forEach((id) => addItem(make(id)));
    S.base[name] = [...new Set([...S.base[name], ...ids])];
  }
  async function pollCoinbase() {
    try {
      const d = await F.fetchJSON('https://api.exchange.coinbase.com/products');
      const live = d.filter((p) => p.status === 'online');
      const byId = Object.fromEntries(live.map((p) => [p.id, p]));
      diffBaseline('coinbase', live.map((p) => p.id), (id) => {
        const p = byId[id];
        return { id: 'cb:' + id, group: 'listing', ex: 'Coinbase', title: `Coinbase opened ${p.display_name || id}`, tag: p.auction_mode ? 'Auction' : p.limit_only || p.post_only ? 'Launch phase' : 'New market', ts: Date.now(), url: `https://exchange.coinbase.com/trade/${id}`, tickers: [p.base_currency] };
      });
      // markets currently in a launch phase (Coinbase opens new books in auction / post-only mode)
      live.filter((p) => p.auction_mode || p.post_only).forEach((p) => addItem({ id: 'cbphase:' + p.id, group: 'listing', ex: 'Coinbase', title: `Coinbase ${p.display_name || p.id} is in its ${p.auction_mode ? 'opening auction' : 'post-only launch phase'}`, tag: 'Launching now', ts: Date.now(), url: `https://exchange.coinbase.com/trade/${p.id}`, tickers: [p.base_currency] }));
      checked.coinbase = Date.now();
    } catch (e) {
      F.health.fail('scanner', 'Coinbase: ' + e.message);
    }
  }
  async function pollHyperliquid() {
    try {
      const d = await F.fetchJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'meta' }) });
      diffBaseline('hyperliquid', d.universe.filter((u) => !u.isDelisted).map((u) => u.name), (name) => ({ id: 'hl:' + name, group: 'listing', ex: 'Hyperliquid', title: `Hyperliquid listed ${name} perpetuals`, tag: 'Perps listing', ts: Date.now(), url: `https://app.hyperliquid.xyz/trade/${name}`, tickers: [name.replace(/^k/, '')] }));
      checked.hyperliquid = Date.now();
    } catch (e) {
      F.health.fail('scanner', 'Hyperliquid: ' + e.message);
    }
  }

  /* ---------- new coins: fresh pools with traction + pump.fun graduations ---------- */
  const GT2DS = { solana: 'solana', base: 'base' };
  async function pollNewPools() {
    for (const net of ['solana', 'base']) {
      try {
        const d = await F.gtFetch(`https://api.geckoterminal.com/api/v2/networks/${net}/new_pools?include=base_token`);
        const inc = Object.fromEntries((d.included || []).map((x) => [x.id, x.attributes]));
        (d.data || []).forEach((pool) => {
          const a = pool.attributes, r = pool.relationships || {};
          const ta = inc[(r.base_token && r.base_token.data || {}).id];
          if (!ta) return;
          const dex = (r.dex && r.dex.data && r.dex.data.id) || '';
          const liq = +a.reserve_in_usd || 0;
          const h1 = (a.transactions && a.transactions.h1) || {};
          const trades = (h1.buys || 0) + (h1.sells || 0);
          const created = Date.parse(a.pool_created_at);
          // only pools with real money and real activity — most new pools are dead on arrival
          if (liq < 8000 || trades < 25 || Date.now() - created > 6 * 3600000) return;
          const grad = /pump/.test(dex);
          const key = F.radar.track(GT2DS[net], ta.address, { sym: ta.symbol, name: ta.name, icon: ta.image_url && !/missing/.test(ta.image_url) ? ta.image_url : '', gtNet: net, gtPool: a.address }, 'new');
          addItem({ id: 'np:' + ta.address, group: 'coin', ex: grad ? 'pump.fun' : dex || net, title: `${ta.symbol} ${grad ? 'graduated from pump.fun' : `new pool on ${dex || net}`}`, tag: grad ? 'Graduated' : 'New pool', ts: created, key, tickers: [String(ta.symbol).toUpperCase()] });
        });
        checked.pools = Date.now();
      } catch (e) {
        F.health.fail('scanner', 'new pools: ' + e.message);
      }
    }
  }

  /* ---------- view ---------- */
  const TAG_CLS = { Delisting: 'bad', Graduated: 'grad', 'Launching now': 'hot', 'Opening soon': 'hot', Auction: 'hot', 'Launch phase': 'hot' };
  const ANN = { listing: 'Listing', launch: 'Launch', airdrop: 'Airdrop', ca: 'Contract drop', delisting: 'Delisting' };
  function row(it) {
    const t = it.key && F.radar.get(it.key);
    const vd = t && t.sig ? `<span class="vd ${t.sig.label}">${{ buy: 'Worth buying', wait: 'Wait', skip: 'Not worth it' }[t.sig.label]}</span>` : '';
    const stats = t ? `<small>${F.usd(t.liq)} liquidity · ${F.usd(t.mcap || t.fdv)} MC${t.tx.h1 ? ` · ${t.tx.h1.b} buys / ${t.tx.h1.s} sells 1h` : ''}</small>` : '';
    const inner = `<span class="sx ${F.esc(it.ex).replace(/[^a-z]/gi, '').toLowerCase()}">${F.esc(it.ex)}</span><span class="st"><b>${F.esc(it.title)}</b>${stats}</span><span class="tg ${TAG_CLS[it.tag] || ''}">${F.esc(it.tag)}</span>${vd}<time data-ts="${it.ts}">${F.ago(it.ts)}</time>`;
    return it.key ? `<div class="srow" data-key="${F.esc(it.key)}">${inner}</div>` : `<a class="srow" href="${F.esc(it.url)}" target="_blank" rel="noopener">${inner}</a>`;
  }
  function html() {
    const listings = S.items.filter((x) => x.group === 'listing' || x.group === 'delisting').slice(0, 14);
    const coins = S.items.filter((x) => x.group === 'coin' && F.radar.get(x.key)).slice(0, 12);
    const posts = F.social.all().filter((p) => p.announce && !p.hidden && Date.now() - p.ts < 24 * 3600000).slice(0, 14);
    const since = (n) => (S.baseAt[n] ? `new ${n === 'coinbase' ? 'Coinbase markets' : 'Hyperliquid perps'} since ${new Date(S.baseAt[n]).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '');
    const last = Math.max(0, ...Object.values(checked));
    return `<div class="scan">
      <p class="scan-h"><i class="dot ${last ? 'ok' : 'busy'}"></i>Watching Binance &amp; OKX announcements, ${[since('coinbase'), since('hyperliquid')].filter(Boolean).join(', ') || 'new Coinbase &amp; Hyperliquid markets'}, pump.fun graduations and fresh pools${last ? ` · checked ${F.ago(last)} ago` : ''}</p>
      <h4>Exchange listings <small>official sources</small></h4>
      ${listings.length ? listings.map(row).join('') : '<p class="empty">Loading exchange announcements…</p>'}
      <h4>New coins &amp; graduations <small>real liquidity and trading only · rug-checked</small></h4>
      ${coins.length ? coins.map(row).join('') : '<p class="empty">Scanning fresh pools…</p>'}
      <h4>Announcements in posts <small>listings, launches, airdrops</small></h4>
      ${posts.length ? posts.map((p) => `<a class="srow" href="${F.esc(p.url)}" target="_blank" rel="noopener"><span class="sx">${F.esc(p.author.name.split(' ')[0])}</span><span class="st"><b>${F.esc(p.text.split('\n')[0].slice(0, 150))}</b>${p.announce === 'ca' ? '<small class="warnline">Unverified contract drop from the crowd — most of these are shills</small>' : `<small>${F.esc(p.author.name)}${p.outlet ? ' · verified' : ''}</small>`}</span><span class="tg ${p.announce === 'ca' || p.announce === 'delisting' ? 'bad' : ''}">${ANN[p.announce]}</span><time data-ts="${p.ts}">${F.ago(p.ts)}</time></a>`).join('') : '<p class="empty">No listing, launch or airdrop posts in the last 24h yet.</p>'}
    </div>`;
  }

  F.scanner = {
    html,
    unseen: () => S.items.filter((x) => x.ts > S.viewedAt && x.group !== 'coin').length,
    markViewed() {
      S.viewedAt = Date.now();
      save();
    },
    start() {
      const run = async () => {
        await Promise.all([pollBinance(), pollOKX(), pollCoinbase(), pollHyperliquid()]);
        if (Object.keys(checked).length) F.health.ok('scanner', 'listings + new pools');
        save();
        F.emit('scan', null);
      };
      run().then(() => {
        booting = false;
        if (!S.viewedAt) S.viewedAt = Date.now() - 24 * 3600000;
      });
      setTimeout(() => pollNewPools().then(() => F.emit('scan', null)), 4000);
      setInterval(run, 2 * 60000);
      setInterval(() => pollNewPools().then(() => {
        save();
        F.emit('scan', null);
      }), 3 * 60000);
    },
  };
})();
