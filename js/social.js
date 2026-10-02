/* fomo — the feed. "Crypto Twitter" without X or Discord:
   - verified outlets on Bluesky (the same Whale Alert / Watcher Guru / Decrypt accounts people follow on X)
   - crowd chatter from Bluesky search + Mastodon hashtags, spam-filtered
   - newsroom RSS (CoinDesk, The Block, Cointelegraph)
   Every post links to its original. Nothing is generated or paraphrased here. */
(function () {
  const F = window.F;

  // Handles are domains the outlet controls (Bluesky proves this via DNS), so they cannot be impersonated.
  const OUTLETS = [
    { h: 'whale-alert.io', name: 'Whale Alert', kind: 'whale', emoji: '🐋' },
    { h: 'watcher.guru', name: 'Watcher Guru', kind: 'breaking', emoji: '⚡' },
    { h: 'decrypt.co', name: 'Decrypt', kind: 'news', emoji: '📰' },
    { h: 'protos.com', name: 'Protos', kind: 'news', emoji: '🕵️' },
    { h: 'web3isgoinggreat.com', name: 'Web3 Is Going Great', kind: 'hack', emoji: '🔥' },
    { h: 'polymarket.com', name: 'Polymarket', kind: 'breaking', emoji: '🎲' },
    // General newsrooms: only their market / crypto / economy stories get through (MARKETS_RE)
    { h: 'bloomberg.com', name: 'Bloomberg', kind: 'stocks', marketsOnly: true },
    { h: 'reuters.com', name: 'Reuters', kind: 'stocks', marketsOnly: true },
    { h: 'wsj.com', name: 'The Wall Street Journal', kind: 'stocks', marketsOnly: true },
    { h: 'yahoofinance.com', name: 'Yahoo Finance', kind: 'stocks', marketsOnly: true },
    { h: 'cnbc.com', name: 'CNBC', kind: 'stocks', marketsOnly: true },
    { h: 'marketwatch.com', name: 'MarketWatch', kind: 'stocks', marketsOnly: true },
    { h: 'fortune.com', name: 'Fortune', kind: 'stocks', marketsOnly: true },
  ];
  const OUTLET_BY_HANDLE = Object.fromEntries(OUTLETS.map((o) => [o.h, o]));
  const IMPERSONATED = /whale\s*alert|watcher\s*guru|decrypt|coindesk|cointelegraph|lookonchain|the\s*block|bitcoin\s*magazine/i;
  // Crowd posts must actually be about markets to get in (a "crypto" search also returns politics and AI takes).
  const CROWD_RE = /\$[A-Za-z]{2,}|\b(crypto|bitcoin|btc|eth|ethereum|solana|memecoins?|meme ?coins?|altcoins?|tokens?|defi|airdrops?|pump\.fun|dex|on-?chain|blockchain|nfts?|stablecoins?|usdc|usdt|binance|coinbase|hyperliquid|bull ?run|bear market|stocks?|nasdaq|s&p|earnings|trading|traders?|whales?|rug ?pull|degen|hodl)\b/i;
  // General newsrooms only get in with crypto stories or genuinely market-moving ones (not every "market" mention).
  const MARKETS_RE = /\b(crypto|cryptocurrenc(y|ies)|bitcoin|btc|ether(eum)?|solana|xrp|dogecoin|stablecoins?|blockchain|memecoins?|meme stocks?|coinbase|binance|robinhood|tether|microstrategy|sec|etfs?|stocks?|shares (rose|fell|jumped|slid|surged|tumbled|sank|climbed|gained|dropped|soared|plunged)|s&p|nasdaq|dow jones|wall street|earnings|federal reserve|the fed|fed (cut|hike|holds?|chair)|rate cuts?|interest rates?|inflation|cpi|ipos?|treasury yields?|bond yields?|tariffs?|nvidia|tesla)\b|\$[A-Z]{1,5}\b/i;

  // Crypto newsrooms. Most block direct browser reads, so they go through rss2json — which rate-limits
  // registering many feeds at once, hence the staggered polling in start().
  const RSS = [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
    { url: 'https://www.theblock.co/rss.xml', name: 'The Block' },
    { url: 'https://cointelegraph.com/rss', name: 'Cointelegraph' },
    { url: 'https://bitcoinmagazine.com/feed', name: 'Bitcoin Magazine' },
    { url: 'https://cryptoslate.com/feed/', name: 'CryptoSlate' },
    { url: 'https://thedefiant.io/api/feed', name: 'The Defiant' },
    { url: 'https://unchainedcrypto.com/feed/', name: 'Unchained' },
  ];
  // MarketWatch's own feed allows direct reads (CORS *), so it skips the converter.
  const DIRECT_RSS = [{ url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', name: 'MarketWatch', h: 'marketwatch.com', kind: 'stocks' }];

  const BASE_QUERIES = ['memecoin', 'pump.fun', '$SOL', '$BTC', 'solana', 'altcoin', '$ETH', 'crypto'];
  const MASTO_TAGS = ['memecoin', 'crypto', 'bitcoin', 'solana', 'cryptocurrency'];
  const SPAM_LABELS = new Set(['spam', 'porn', 'sexual', 'nudity', 'graphic-media', '!hide', '!warn', 'impersonation', 'scam']);
  const EXCH = /#?(binance|coinbase|kraken|okx|okex|bybit|bitfinex|bitstamp|gemini|kucoin|htx|huobi|gate\.?io|bitget|mexc|upbit|crypto\.com|robinhood|bithumb|deribit|hyperliquid)\b/i;
  const STABLE = /\$(USDT|USDC|DAI|USDE|PYUSD|FDUSD|RLUSD|USD1|USDS)\b/i;

  const posts = new Map();
  const seenText = new Set();
  const seenLink = new Set();
  const authorHits = {};
  const filtered = { spam: 0, dup: 0, impostor: 0, flood: 0, offtopic: 0 };
  let order = [];

  /* ---------------- classification (heuristic; AI tags override when enabled) ---------------- */
  function classify(p) {
    const t = p.text;
    if (p.outlet && p.outlet.kind === 'whale') p.kind = 'whale';
    else if (/\b(hack|hacked|exploit|exploited|drain|drained|stolen|attacker|breach|rug ?pull(ed)?)\b/i.test(t)) p.kind = 'hack';
    else if (/(^|\s)(JUST IN|BREAKING)\b/.test(t)) p.kind = 'breaking';
    else if (p.outlet) p.kind = p.outlet.kind;
    else if (p.src === 'rss') p.kind = 'news';
    else if (/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/.test(t) || /pump\.fun\/|dexscreener\.com\/|\bCA\s*[:：]/i.test(t) || (p.tickers.length >= 2 && /🚀|100x|1000x|\bgem\b|moon|next \w+ ?x/i.test(t)))
      p.kind = 'shill';
    else p.kind = 'chatter';
    p.sent = F.sentiment(t);
    if (p.kind === 'whale') whale(p);
    return p;
  }

  // "1,035 $BTC (87,510,970 USD) transferred from unknown wallet to #Kraken"
  function whale(p) {
    const usd = p.text.match(/\(([\d,]+)\s*USD\)/);
    const m = p.text.match(/transferred from (.+?) to (.+?)(\s+https?:|\s+[a-z0-9-]+\.[a-z]{2,}\/|$)/i);
    const stable = STABLE.test(p.text);
    const asset = (p.text.match(/\$([A-Za-z0-9]{2,10})\b/) || [])[1];
    const tidy = (x) => String(x || '').replace(/#/g, '').replace(/\s+/g, ' ').trim().replace(/^unknown wallet$/i, 'unknown wallet');
    const w = { usd: usd ? +usd[1].replace(/,/g, '') : null, flow: 'transfer', note: '', asset: asset ? asset.toUpperCase() : '', from: m ? tidy(m[1]) : '', to: m ? tidy(m[2]) : '' };
    if (/\bminted\b/i.test(p.text)) {
      w.flow = 'mint';
      w.note = 'fresh stablecoins minted';
    } else if (/\bburned\b/i.test(p.text)) {
      w.flow = 'burn';
      w.note = 'stablecoins burned';
    } else if (m) {
      const fromEx = EXCH.test(m[1]), toEx = EXCH.test(m[2]);
      if (toEx && !fromEx) {
        w.flow = 'inflow';
        w.note = stable ? 'stables moving onto an exchange (often dry powder to buy)' : 'coins moving onto an exchange (often sell pressure)';
        p.sent = stable ? 1 : -1;
      } else if (fromEx && !toEx) {
        w.flow = 'outflow';
        w.note = stable ? 'stables leaving an exchange' : 'coins leaving an exchange (often accumulation)';
        p.sent = stable ? 0 : 1;
      } else {
        w.note = 'wallet-to-wallet transfer';
        p.sent = 0;
      }
    }
    p.whale = w;
  }

  /* ---------------- intake with spam + dedupe ---------------- */
  function add(p, crowd) {
    if (posts.has(p.id)) return false;
    const norm = p.text.toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9$ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (crowd) {
      if (norm.length < 15) return filtered.spam++, false;
      if (!CROWD_RE.test(p.text + ' ' + (p.linkTitle || ''))) return filtered.offtopic++, false;
      if ((p.text.match(/\$[A-Za-z]{2,}/g) || []).length > 5 || (p.text.match(/#\w+/g) || []).length > 8) return filtered.spam++, false;
      if (IMPERSONATED.test(p.author.name + ' ' + p.author.handle)) return filtered.impostor++, false;
      const hits = (authorHits[p.author.handle] = (authorHits[p.author.handle] || []).filter((t) => Date.now() - t < 30 * 60000));
      if (hits.length >= 3) return filtered.flood++, false;
      hits.push(Date.now());
    }
    if (norm.length > 20) {
      const k = F.hash(norm);
      if (seenText.has(k)) return filtered.dup++, false;
      seenText.add(k);
    }
    if (p.link) {
      const l = p.link.replace(/[?#].*$/, '').replace(/\/$/, '');
      if (seenLink.has(l)) return filtered.dup++, false;
      seenLink.add(l);
    }
    if (!Number.isFinite(p.ts) || p.ts < Date.now() - 3 * 86400000) return false;
    posts.set(p.id, classify(p));
    return true;
  }

  function reorder() {
    order = [...posts.values()].sort((a, b) => b.ts - a.ts);
    if (order.length > 450) {
      order.slice(450).forEach((p) => posts.delete(p.id));
      order = order.slice(0, 450);
    }
  }

  /* ---------------- Bluesky ---------------- */
  function bskyLinks(p) {
    const links = [];
    ((p.record && p.record.facets) || []).forEach((f) => (f.features || []).forEach((x) => x.uri && links.push(x.uri)));
    const e = p.embed || {};
    const ext = e.external || (e.media && e.media.external);
    if (ext && ext.uri) links.unshift(ext.uri);
    return { links, ext };
  }
  function fromBsky(p, outlet) {
    const rec = p.record || {};
    const a = p.author || {};
    const labels = [...(p.labels || []), ...(a.labels || [])].map((l) => l.val);
    if (labels.some((v) => SPAM_LABELS.has(v))) return null;
    const created = Date.parse(rec.createdAt), indexed = Date.parse(p.indexedAt);
    const ts = !Number.isFinite(created) || created > indexed + 300000 ? indexed : created;
    const { links, ext } = bskyLinks(p);
    const e = p.embed || {};
    const imgs = (e.images || (e.media && e.media.images) || []).map((i) => i.thumb);
    let text = rec.text || '';
    if (!text && ext) text = ext.title || '';
    const verified = outlet ? 'outlet' : a.verification && a.verification.verifiedStatus === 'valid' ? 'bsky' : null;
    return {
      id: 'b:' + p.uri,
      src: 'bsky',
      outlet,
      verified,
      author: { name: a.displayName || a.handle, handle: a.handle, avatar: a.avatar || '' },
      text,
      link: links[0] || null,
      linkTitle: ext ? ext.title : '',
      img: imgs[0] || (ext && ext.thumb) || '',
      url: `https://bsky.app/profile/${a.handle}/post/${p.uri.split('/').pop()}`,
      ts,
      likes: p.likeCount || 0,
      reposts: (p.repostCount || 0) + (p.quoteCount || 0),
      replies: p.replyCount || 0,
      tickers: F.tickers(text + ' ' + (ext ? ext.title : '')),
    };
  }

  async function pollOutlets() {
    let added = [];
    await Promise.all(
      OUTLETS.map(async (o) => {
        try {
          const d = await F.fetchJSON(`https://api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${o.h}&limit=15&filter=posts_no_replies`);
          (d.feed || []).forEach((it) => {
            if (it.reason) return; // reposts of other people
            const p = fromBsky(it.post, o);
            if (!p) return;
            if (o.marketsOnly && !MARKETS_RE.test(p.text + ' ' + p.linkTitle)) return void filtered.offtopic++;
            if (add(p, false)) added.push(p);
          });
          F.health.ok('bluesky');
        } catch (e) {
          F.health.fail('bluesky', o.h + ': ' + e.message);
        }
      })
    );
    commit(added);
  }

  let qi = 0;
  function nextQuery() {
    const hot = (F.radar ? F.radar.topSyms(3) : []).map((s) => '$' + s);
    const list = [...hot, ...BASE_QUERIES];
    return list[qi++ % list.length];
  }
  async function pollCrowd() {
    const q = nextQuery();
    try {
      const d = await F.fetchJSON(`https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&limit=25&lang=en`);
      const added = [];
      // Bluesky search ignores the "$", so "$BATMAN" also returns posts about the movie. Require the literal cashtag.
      const must = q.startsWith('$') ? new RegExp('\\$' + q.slice(1).replace(/[^A-Za-z0-9]/g, '') + '\\b', 'i') : null;
      (d.posts || []).forEach((raw) => {
        if (OUTLET_BY_HANDLE[raw.author && raw.author.handle]) return;
        if (must && !must.test((raw.record && raw.record.text) || '')) return void filtered.offtopic++;
        const p = fromBsky(raw, null);
        if (p && add(p, true)) added.push(p);
      });
      F.health.ok('bluesky', 'search “' + q + '”');
      commit(added);
    } catch (e) {
      F.health.fail('bluesky', 'search: ' + e.message);
    }
  }

  /* ---------------- Mastodon ---------------- */
  let mi = 0;
  const strip = (html) => {
    const d = new DOMParser().parseFromString('<div>' + (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n') + '</div>', 'text/html');
    return (d.body.textContent || '').trim();
  };
  async function pollMasto() {
    const tag = MASTO_TAGS[mi++ % MASTO_TAGS.length];
    try {
      const d = await F.fetchJSON(`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=20`);
      const added = [];
      d.forEach((s) => {
        if (s.reblog || s.sensitive || s.account.bot || (s.language && s.language !== 'en')) return;
        const text = strip(s.content);
        const card = s.card || {};
        const p = {
          id: 'm:' + s.uri,
          src: 'masto',
          outlet: null,
          verified: null,
          author: { name: s.account.display_name || s.account.username, handle: s.account.acct, avatar: s.account.avatar_static || s.account.avatar },
          text,
          link: card.url || null,
          linkTitle: card.title || '',
          img: ((s.media_attachments || []).find((m) => m.type === 'image') || {}).preview_url || '',
          url: s.url || s.uri,
          ts: Date.parse(s.created_at),
          likes: s.favourites_count || 0,
          reposts: s.reblogs_count || 0,
          replies: s.replies_count || 0,
          tickers: F.tickers(text),
        };
        if (add(p, true)) added.push(p);
      });
      F.health.ok('mastodon', '#' + tag);
      commit(added);
    } catch (e) {
      F.health.fail('mastodon', e);
    }
  }

  /* ---------------- newsroom RSS ---------------- */
  function rssPost(r, it, host) {
    const desc = strip(it.description || '').slice(0, 220);
    const text = it.title + (desc && !desc.startsWith(it.title.slice(0, 30)) ? '\n' + desc : '');
    return {
      id: 'r:' + (it.guid || it.link),
      src: 'rss',
      outlet: { h: host, name: r.name, kind: r.kind || 'news' },
      verified: 'outlet',
      author: { name: r.name, handle: host, avatar: '' },
      text,
      link: it.link,
      linkTitle: '',
      img: it.thumbnail || '',
      url: it.link,
      ts: it.ts,
      likes: 0,
      reposts: 0,
      replies: 0,
      tickers: F.tickers(it.title + ' ' + desc),
    };
  }
  async function pollOneRSS(r) {
    const added = [];
    try {
      const d = await F.fetchJSON('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(r.url));
      if (d.status !== 'ok') throw new Error(d.message || 'feed error');
      const host = new URL(r.url).hostname.replace(/^www\./, '');
      (d.items || []).forEach((it) => {
        const p = rssPost(r, Object.assign({}, it, { thumbnail: it.thumbnail || (it.enclosure && it.enclosure.link), ts: Date.parse(String(it.pubDate).replace(' ', 'T') + 'Z') }), host);
        if (add(p, false)) added.push(p);
      });
      F.health.ok('rss', r.name);
    } catch (e) {
      F.health.fail('rss', r.name + ': ' + e.message);
    }
    commit(added);
  }
  async function pollDirectRSS() {
    for (const r of DIRECT_RSS) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        const xml = await fetch(r.url, { signal: ctl.signal }).then((x) => x.text()).finally(() => clearTimeout(timer));
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const added = [];
        [...doc.querySelectorAll('item')].slice(0, 15).forEach((n) => {
          const g = (sel) => (n.querySelector(sel) || {}).textContent || '';
          const it = { title: g('title').trim(), description: g('description'), link: g('link').trim(), guid: g('guid'), ts: Date.parse(g('pubDate')) };
          const p = rssPost(r, it, r.h);
          if (MARKETS_RE.test(p.text) && add(p, false)) added.push(p);
        });
        commit(added);
      } catch (e) {
        F.health.fail('rss', r.name + ': ' + e.message);
      }
    }
  }
  function commit(added) {
    if (!added.length) return;
    reorder();
    F.emit('social', added);
  }

  /* ---------------- queries other modules use ---------------- */
  F.social = {
    OUTLETS,
    filtered,
    all: () => order,
    byId: (id) => posts.get(id),
    recent: (ms) => order.filter((p) => Date.now() - p.ts < ms),
    mentions: (sym, ms = 2 * 3600000) => order.filter((p) => Date.now() - p.ts < ms && p.tickers.includes(sym)),
    score: (p) => (p.ai ? p.ai.sentiment : p.sent),
    hydrate() {
      F.store.get('feed-snap', []).forEach((p) => {
        if (!posts.has(p.id) && Date.now() - p.ts < 6 * 3600000) posts.set(p.id, p);
      });
      if (posts.size) {
        reorder();
        F.emit('social', []);
      }
    },
    start() {
      this.hydrate();
      setInterval(() => F.store.set('feed-snap', order.filter((p) => !p.hidden).slice(0, 120)), 30000);
      pollOutlets();
      pollDirectRSS();
      setTimeout(pollCrowd, 1500);
      setTimeout(pollMasto, 3000);
      // one newsroom every 6s at startup, then each refreshes every 4 min, staggered
      RSS.forEach((r, i) => setTimeout(() => {
        pollOneRSS(r);
        setInterval(() => pollOneRSS(r), 4 * 60000);
      }, 800 + i * 6000));
      setInterval(pollOutlets, 30000);
      setInterval(pollCrowd, 20000);
      setInterval(pollMasto, 60000);
      setInterval(pollDirectRSS, 3 * 60000);
    },
  };
})();
