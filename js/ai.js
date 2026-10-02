/* fomo — the AI layer (Claude, via the official Anthropic TypeScript SDK loaded as an ES module).
   Four jobs, all grounded in the live snapshot the app already fetched — Claude never "remembers" prices:
     1. tag the feed (sentiment / kind / tickers / credibility / one-line takeaway)
     2. the brief: what's moving and why, with every claim cited back to a post or data row
     3. the bot's risk officer: reviews each entry and can veto it
     4. ask fomo: free-form questions about the current snapshot
   The key is yours, stays in this browser, and spend is metered against a daily cap. */
(function () {
  const F = window.F;
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
  const MODELS = {
    'claude-opus-5-5': { label: 'Claude Opus 5.5', pin: 4, pout: 20, effort: true, fallback: true },
    'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', pin: 2, pout: 10, effort: true, fallback: true },
    'claude-haiku-4-5': { label: 'Claude Haiku 4.5', pin: 1, pout: 5, effort: false, fallback: false },
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const cfg = Object.assign({ key: '', model: 'claude-opus-5-5', budget: 5, autoTag: true, autoBrief: true, spend: { day: today(), usd: 0, calls: 0 } }, F.store.get('ai', {}));
  if (!MODELS[cfg.model]) cfg.model = 'claude-opus-5-5';
  const save = () => F.store.set('ai', cfg);
  const model = () => MODELS[cfg.model] || MODELS['claude-opus-5-5'];
  let Anthropic = null, client = null, sdkErr = '', lastErr = '', busy = 0;

  function spend() {
    if (cfg.spend.day !== today()) cfg.spend = { day: today(), usd: 0, calls: 0 };
    return cfg.spend;
  }
  const overBudget = () => spend().usd >= cfg.budget;

  async function getClient() {
    if (!cfg.key) throw new Error('No Claude API key — add one in ⚙ Settings');
    if (!Anthropic) {
      try {
        const mod = await import(SDK_URL);
        Anthropic = mod.default || mod.Anthropic;
      } catch (e) {
        sdkErr = 'Could not load the Anthropic SDK from jsDelivr (' + e.message + ')';
        throw new Error(sdkErr);
      }
    }
    if (!client || client.__key !== cfg.key) {
      client = new Anthropic({ apiKey: cfg.key, dangerouslyAllowBrowser: true, maxRetries: 2 });
      client.__key = cfg.key;
    }
    return client;
  }

  function explain(e) {
    if (Anthropic) {
      if (e instanceof Anthropic.AuthenticationError) return 'API key rejected (401) — check it in ⚙';
      if (e instanceof Anthropic.PermissionDeniedError) return 'Key lacks permission for this model (403)';
      if (e instanceof Anthropic.NotFoundError) return 'Model not available to this key (404)';
      if (e instanceof Anthropic.RateLimitError) return 'Rate limited (429) — will retry later';
      if (e instanceof Anthropic.BadRequestError) return 'Bad request (400): ' + e.message;
      if (e instanceof Anthropic.APIConnectionError) return 'Network error reaching api.anthropic.com';
      if (e instanceof Anthropic.APIError) return 'API error ' + (e.status || '') + ': ' + e.message;
    }
    return e.message || String(e);
  }

  async function call({ system, user, schema, effort = 'low', max = 8000, purpose }) {
    if (overBudget()) throw new Error(`Daily AI budget of ${F.usd(cfg.budget)} reached — raise it in ⚙`);
    const c = await getClient();
    const m = model();
    const params = { model: cfg.model, max_tokens: max, system, messages: [{ role: 'user', content: user }] };
    const oc = {};
    if (m.effort) oc.effort = effort;
    if (schema) oc.format = { type: 'json_schema', schema };
    if (Object.keys(oc).length) params.output_config = oc;
    busy++;
    renderStatus();
    try {
      // Server-side fallback: if a safety classifier declines, the API re-runs the request on its recommended model.
      const res = m.fallback
        ? await c.beta.messages.create(Object.assign({}, params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }))
        : await c.messages.create(params);
      const priced = MODELS[res.model] || { pin: 5, pout: 25 };
      const u = res.usage || {};
      const inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
      const usd = (inTok * priced.pin + (u.output_tokens || 0) * priced.pout) / 1e6;
      const s = spend();
      s.usd += usd;
      s.calls++;
      save();
      lastErr = '';
      if (res.stop_reason === 'refusal') throw new Error('Claude declined this request' + (res.stop_details && res.stop_details.category ? ' (' + res.stop_details.category + ')' : ''));
      if (res.stop_reason === 'max_tokens') throw new Error('Response was cut off (max_tokens) — try again');
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return schema ? JSON.parse(text) : text;
    } catch (e) {
      lastErr = (purpose ? purpose + ': ' : '') + explain(e);
      throw new Error(explain(e));
    } finally {
      busy--;
      renderStatus();
    }
  }

  /* ---------------- shared snapshot (the only facts Claude is allowed to use) ---------------- */
  function snapshot(opts = {}) {
    const ids = {};
    let n = 0;
    const pick = F.social.recent(opts.hours ? opts.hours * 3600000 : 3 * 3600000).filter((p) => !p.hidden);
    const rank = (p) => (p.outlet ? 3 : 0) + (['whale', 'hack', 'breaking'].includes(p.kind) ? 2 : 0) + (p.tickers.length ? 1 : 0) - (p.kind === 'shill' ? 2 : 0);
    const chosen = (opts.posts || pick.sort((a, b) => rank(b) - rank(a) || b.ts - a.ts).slice(0, opts.maxPosts || 45)).map((p) => {
      const id = 'p' + ++n;
      ids[id] = { type: 'post', post: p };
      return {
        id, who: p.author.name + (p.outlet ? ' (verified outlet)' : p.verified === 'bsky' ? ' (Bluesky-verified)' : ' (crowd, unverified)'),
        via: { bsky: 'Bluesky', masto: 'Mastodon', rss: 'RSS' }[p.src], age: F.ago(p.ts) + ' ago', kind: p.kind,
        text: (p.text + (p.linkTitle ? ' [link: ' + p.linkTitle + ']' : '')).slice(0, 320),
      };
    });
    const toks = opts.tokens || F.radar.list().sort((a, b) => b.fomo - a.fomo).slice(0, 12).concat(F.radar.list().sort((a, b) => b.risk - a.risk).slice(0, 3));
    const seen = new Set();
    const radar = toks.filter((t) => !seen.has(t.key) && seen.add(t.key)).map((t) => {
      const base = 'tok:' + (t.sym.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'X');
      let id = base;
      for (let i = 2; ids[id]; i++) id = base + i;
      ids[id] = { type: 'token', key: t.key };
      const h1 = t.tx.h1 || { b: 0, s: 0 };
      return {
        id, symbol: t.sym, name: t.name, chain: t.chain, price_usd: t.price, change_pct: t.ch, liquidity_usd: t.liq, volume_usd: t.vol,
        buys_1h: h1.b, sells_1h: h1.s, fdv_usd: t.fdv, pool_age_hours: t.created ? +((Date.now() - t.created) / 3600000).toFixed(1) : null,
        fomo_score: t.fomo, rug_risk: t.risk, risk_flags: t.flags.map((f) => f[2]), social_mentions_2h: t.buzz,
        listed_by: [...t.src].map((s) => (s === 'trending' ? 'organic trending' : 'paid promotion')),
      };
    });
    const majors = Object.values(F.markets.crypto).filter((c) => c.price != null).map((c) => {
      ids['mkt:' + c.sym] = { type: 'mkt' };
      return { id: 'mkt:' + c.sym, symbol: c.sym, price_usd: c.price, change_24h_pct: +F.markets.chg(c).toFixed(2) };
    });
    const stocks = Object.values(F.markets.stocks).filter((s) => s.price != null).map((s) => {
      ids['mkt:' + s.sym] = { type: 'mkt' };
      return { id: 'mkt:' + s.sym, symbol: s.sym, name: s.name, price_usd: s.price, change_24h_pct: +F.markets.chg(s).toFixed(2) };
    });
    const g = F.markets.gauges;
    const bot = F.bot.stats();
    const data = {
      now_utc: new Date().toISOString(), nyse: F.nyse().label,
      gauges: { fear_greed: g.fng, fear_greed_label: g.fngLabel, total_crypto_mcap_change_24h_pct: g.mcapChg, btc_dominance_pct: g.btcDom },
      majors, stock_perps_note: 'Hyperliquid 24/7 perps tracking the stocks; outside NYSE hours they can drift from the last close', stocks,
      meme_radar: radar, posts: chosen,
      paper_bot: { equity_usd: +bot.eq.toFixed(2), return_pct: +bot.ret.toFixed(2), open_positions: F.bot.state().pos.map((p) => p.sym) },
    };
    return { data, ids };
  }

  const GROUNDING = `Ground rules (these are what make fomo trustworthy):
- Use ONLY facts in the JSON snapshot. It was fetched seconds ago; your own training knowledge of prices, projects and events is stale — never add it.
- Crowd posts are unverified chatter: write "people are saying…", never "X happened". Verified outlets can be reported as "Decrypt reports…".
- FOMO score = momentum + order flow + social attention. It is not quality. Rug-risk flags are real warnings.
- Never tell the user to buy or sell. Describe what is moving, plausible reasons, and what could go wrong.
- If the snapshot is thin or contradictory, say so plainly.`;

  /* ---------------- 1. feed tagging ---------------- */
  const TAG_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'sentiment', 'kind', 'tickers', 'credibility', 'takeaway'],
          properties: {
            id: { type: 'string' },
            sentiment: { type: 'integer', description: '-2 very bearish … 0 neutral … +2 very bullish, for the assets the post is about' },
            kind: { type: 'string', enum: ['news', 'breaking', 'whale', 'hack', 'shill', 'scam_warning', 'opinion', 'meme', 'macro', 'stocks', 'offtopic'] },
            tickers: { type: 'array', items: { type: 'string' } },
            credibility: { type: 'string', enum: ['low', 'medium', 'high'] },
            takeaway: { type: 'string', description: 'at most 14 words; only what the post itself says' },
          },
        },
      },
    },
  };
  const tagQueue = [];
  let tagging = false;
  async function tagBatch() {
    if (!ready() || !cfg.autoTag || tagging || !tagQueue.length) return;
    tagging = true;
    const batch = tagQueue.splice(0, 30);
    const map = {};
    const items = batch.map((p, i) => {
      map['t' + i] = p;
      return { id: 't' + i, author: p.author.name + (p.outlet ? ' (verified outlet)' : ' (crowd)'), text: p.text.slice(0, 400) };
    });
    try {
      const out = await call({
        purpose: 'tagging',
        effort: 'low',
        max: 6000,
        system: 'You tag social posts for a crypto, meme-coin and stock market feed. Judge each post only by its own text. tickers = asset symbols the post is actually about (uppercase, no $). credibility: high = a named outlet reporting a fact or an on-chain alert; low = anonymous hype, shilling, engagement bait, or unsourced claims. Mark posts unrelated to markets as offtopic. shill = promoting a token with hype or a contract address; scam_warning = warning others about a scam or rug.',
        user: JSON.stringify(items),
        schema: TAG_SCHEMA,
      });
      (out.items || []).forEach((r) => {
        const p = map[r.id];
        if (!p) return;
        p.ai = { sentiment: F.clamp(Math.round(r.sentiment), -2, 2), kind: r.kind, credibility: r.credibility, takeaway: r.takeaway };
        const tk = (r.tickers || []).map((x) => String(x).toUpperCase().replace(/^\$/, '')).filter((x) => /^[A-Z0-9]{2,12}$/.test(x));
        p.tickers = [...new Set([...p.tickers, ...tk])].slice(0, 8);
        if (r.kind === 'offtopic' && !p.outlet) p.hidden = true;
        if (['hack', 'whale', 'shill', 'scam_warning'].includes(r.kind)) p.kind = r.kind === 'scam_warning' ? 'hack' : r.kind;
      });
      F.emit('social', []);
    } catch (e) {
      if (/budget|key/i.test(e.message)) tagQueue.length = 0;
      else tagQueue.unshift(...batch.slice(0, 10));
    } finally {
      tagging = false;
    }
  }

  /* ---------------- 2. the brief ---------------- */
  const BRIEF_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['headline', 'mood', 'bullets', 'watch', 'warnings'],
    properties: {
      headline: { type: 'string' },
      mood: { type: 'string', enum: ['euphoric', 'greedy', 'neutral', 'fearful', 'panicked'] },
      bullets: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['emoji', 'text', 'cites'], properties: { emoji: { type: 'string' }, text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } } } },
      watch: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['symbol', 'why', 'risk', 'cites'], properties: { symbol: { type: 'string' }, why: { type: 'string' }, risk: { type: 'string', enum: ['low', 'medium', 'high', 'extreme'] }, cites: { type: 'array', items: { type: 'string' } } } } },
      warnings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'cites'], properties: { text: { type: 'string' }, cites: { type: 'array', items: { type: 'string' } } } } },
    },
  };
  let brief = F.store.get('brief', null);
  let briefIds = {};
  async function makeBrief() {
    const { data, ids } = snapshot();
    const out = await call({
      purpose: 'brief',
      effort: 'medium',
      max: 12000,
      system: `You are fomo's market desk — a sharp, fun, strictly factual briefer for crypto, meme coins and stocks. You get a live JSON snapshot.
${GROUNDING}
Output: a punchy headline (≤ 12 words); mood of the market; 3–6 bullets (≤ 28 words, one emoji each) covering the biggest moves and the stories behind them; up to 4 tokens or tickers worth watching (symbols MUST appear in the snapshot) with why and a risk level; and warnings (hacks, rugs, honeypots, liquidity pulls, impersonation) if any.
Every bullet, watch item and warning must list in "cites" the snapshot ids it relies on (post ids like "p7", data ids like "tok:PENGU" or "mkt:BTC"). No citation, no claim.`,
      user: JSON.stringify(data),
      schema: BRIEF_SCHEMA,
    });
    // keep only citations that exist, and watch symbols that exist in the snapshot
    const valid = (c) => (c || []).filter((x) => ids[x]);
    const symbols = new Set([...data.meme_radar.map((t) => t.symbol.toUpperCase()), ...data.majors.map((m) => m.symbol), ...data.stocks.map((s) => s.symbol)]);
    out.bullets = out.bullets.map((b) => Object.assign(b, { cites: valid(b.cites) }));
    out.warnings = out.warnings.map((b) => Object.assign(b, { cites: valid(b.cites) }));
    const dropped = out.watch.filter((w) => !symbols.has(w.symbol.toUpperCase().replace(/^\$/, ''))).length;
    out.watch = out.watch.filter((w) => symbols.has(w.symbol.toUpperCase().replace(/^\$/, ''))).map((w) => Object.assign(w, { cites: valid(w.cites) }));
    out.at = Date.now();
    out.model = model().label;
    out.dropped = dropped;
    out.postCount = data.posts.length;
    // store the resolved citation targets so links survive a reload
    out.refs = {};
    Object.entries(ids).forEach(([k, v]) => {
      if (v.type === 'post') out.refs[k] = { url: v.post.url, who: v.post.author.name };
      else if (v.type === 'token') out.refs[k] = { key: v.key };
    });
    brief = out;
    briefIds = ids;
    F.store.set('brief', brief);
    return out;
  }

  /* ---------------- 3. the bot's risk officer ---------------- */
  const COPILOT_SCHEMA = {
    type: 'object', additionalProperties: false, required: ['verdict', 'conviction', 'thesis', 'red_flags'],
    properties: {
      verdict: { type: 'string', enum: ['buy', 'pass'] },
      conviction: { type: 'integer', description: '0–100' },
      thesis: { type: 'string', description: 'at most 25 words' },
      red_flags: { type: 'array', items: { type: 'string' } },
    },
  };
  async function copilot(t, mentions, preset) {
    const { data } = snapshot({ posts: mentions, tokens: [t], maxPosts: 10 });
    const out = await call({
      purpose: 'bot check',
      effort: 'medium',
      max: 6000,
      system: `You are the risk officer for fomo's PAPER-trading bot (simulated money, used to measure whether its strategy works). The bot's rules picked this meme token as a momentum entry. Your job is to catch what rules cannot: posts revealing a rug, hack, team dump, impersonation or dead project; numbers that do not add up (volume with no holders, buys with no sells, valuation far beyond liquidity); a pump that is clearly in its final blow-off. If in doubt, pass — a missed trade costs nothing.
${GROUNDING}
Bot mode: ${preset.label} (stop −${Math.round(preset.stop * 100)}%, trailing ${Math.round(preset.trail * 100)}%). Answer with verdict, conviction 0–100, a thesis of at most 25 words, and any red flags.`,
      user: JSON.stringify({ candidate: data.meme_radar[0], posts_mentioning_it: data.posts, market: { gauges: data.gauges, majors: data.majors.slice(0, 4) } }),
      schema: COPILOT_SCHEMA,
    });
    out.conviction = F.clamp(Math.round(out.conviction), 0, 100);
    out.red_flags = (out.red_flags || []).slice(0, 4);
    return out;
  }

  /* ---------------- 4. ask fomo ---------------- */
  async function ask(question, focusKey) {
    const t = focusKey && F.radar.get(focusKey);
    const { data, ids } = t ? snapshot({ tokens: [t], posts: F.social.mentions(t.sym.toUpperCase(), 24 * 3600000).slice(0, 25) }) : snapshot({ maxPosts: 40 });
    const text = await call({
      purpose: 'ask',
      effort: 'medium',
      max: 10000,
      system: `You are fomo 🤖, a friendly, blunt market assistant for crypto, meme coins and stocks. Answer the user's question from the live JSON snapshot.
${GROUNDING}
Cite sources inline as [p3] or [tok:SYMBOL] or [mkt:BTC] using ids from the snapshot. Keep it under 180 words, plain text, a couple of emojis welcome. If the snapshot can't answer it, say what's missing.`,
      user: JSON.stringify(data) + '\n\nQuestion: ' + question,
    });
    return { text, ids };
  }

  /* ---------------- rendering ---------------- */
  function cites(list, refs) {
    return (list || []).map((c) => {
      const r = refs[c];
      if (!r) return '';
      if (r.url) return `<a class="cite" href="${F.esc(r.url)}" target="_blank" rel="noopener" title="${F.esc(r.who)}">${F.esc(c)}</a>`;
      if (r.key) return `<a class="cite" href="#" data-key="${F.esc(r.key)}">${F.esc(c.replace('tok:', '$'))}</a>`;
      return '';
    }).join('');
  }
  function linkify(text, ids) {
    return F.esc(text).replace(/\[((?:p\d+|tok:[A-Za-z0-9]+|mkt:[A-Za-z0-9]+)(?:\s*,\s*(?:p\d+|tok:[A-Za-z0-9]+|mkt:[A-Za-z0-9]+))*)\]/g, (m, inner) =>
      inner.split(/\s*,\s*/).map((id) => {
        const v = ids[id];
        if (!v) return '';
        if (v.type === 'post') return `<a class="cite" href="${F.esc(v.post.url)}" target="_blank" rel="noopener">${id}</a>`;
        if (v.type === 'token') return `<a class="cite" href="#" data-key="${F.esc(v.key)}">${id.replace('tok:', '$')}</a>`;
        return `<span class="cite">${id.replace('mkt:', '')}</span>`;
      }).join('')
    ).replace(/\n/g, '<br>');
  }

  function localBrief() {
    // No-AI fallback: assembled from the same live data, clearly labelled as automatic.
    const hot = F.radar.list().filter((t) => t.risk < 60).sort((a, b) => b.fomo - a.fomo);
    const btc = F.markets.crypto.BTC, g = F.markets.gauges;
    const whales = F.social.recent(3600000).filter((p) => p.whale && p.whale.usd).sort((a, b) => b.whale.usd - a.whale.usd);
    const hacks = F.social.recent(12 * 3600000).filter((p) => p.kind === 'hack');
    const counts = {};
    F.social.recent(2 * 3600000).forEach((p) => p.tickers.forEach((s) => (counts[s] = (counts[s] || 0) + 1)));
    const talked = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const tiles = [];
    if (btc && btc.price) tiles.push(['Bitcoin', F.usd(btc.price, 0), F.chg(F.markets.chg(btc))]);
    if (g.fng != null) tiles.push(['Fear & Greed', String(g.fng), `<span class="mut">${F.esc(g.fngLabel)}</span>`]);
    if (g.mcap) tiles.push(['Crypto market', F.usd(g.mcap), F.chg(g.mcapChg)]);
    if (hot[0]) tiles.push(['Hottest token', F.esc(hot[0].sym), `<span class="mut">FOMO ${hot[0].fomo}</span>`]);
    const rows = [];
    if (hot.length > 1) rows.push(['🔥', 'Also heating up: ' + hot.slice(1, 4).map((t) => `${t.sym} (${t.fomo})`).join(', ')]);
    if (whales[0]) rows.push(['🐋', `Biggest whale move this hour: ${F.usd(whales[0].whale.usd, 0)}, ${whales[0].whale.note}`]);
    if (talked.length) rows.push(['💬', 'Most talked about in 2h: ' + talked.map(([s, n]) => `$${s} ×${n}`).join(', ')]);
    if (hacks.length) rows.push(['🚨', `${hacks.length} hack or exploit post${hacks.length > 1 ? 's' : ''} in the last 12h`]);
    return { tiles, rows };
  }

  const MOODS = { euphoric: 'Euphoric', greedy: 'Greedy', neutral: 'Neutral', fearful: 'Fearful', panicked: 'Panicked' };
  function renderBrief() {
    const el = F.$('#briefBody');
    if (!el) return;
    if (!ready() || !brief) {
      const { tiles, rows } = localBrief();
      el.innerHTML = (tiles.length ? `<div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join('')}</div>` : '<p class="empty">Gathering live data…</p>') +
        (rows.length ? '<ul class="bl">' + rows.map(([e, t]) => `<li><i>${e}</i><span>${F.esc(t)}</span></li>`).join('') + '</ul>' : '') +
        `<p class="brief-meta">Auto-summary from live data. ${ready() ? 'Hit Brief me for Claude’s read on why things are moving.' : 'Add a Claude key in Settings for an AI brief that explains why things are moving.'}</p>`;
      return;
    }
    const b = brief, refs = b.refs || {};
    el.innerHTML = `<div class="brief-h"><h3>${F.esc(b.headline)}</h3><span class="mood ${F.esc(b.mood)}">${MOODS[b.mood] || 'Neutral'}</span></div>
      <ul class="bl">${b.bullets.map((x) => `<li><i>${F.esc(x.emoji)}</i><span>${F.esc(x.text)} ${cites(x.cites, refs)}</span></li>`).join('')}</ul>
      ${b.watch.length ? `<div class="watch">${b.watch.map((w) => `<div class="w r-${F.esc(w.risk)}"><b>${F.esc(w.symbol.replace(/^\$/, ''))}<em>${F.esc(w.risk)} risk</em></b><span>${F.esc(w.why)} ${cites(w.cites, refs)}</span></div>`).join('')}</div>` : ''}
      ${b.warnings.length ? `<div class="warns">${b.warnings.map((w) => `<p>⚠️ ${F.esc(w.text)} ${cites(w.cites, refs)}</p>`).join('')}</div>` : ''}
      <p class="brief-meta">${F.esc(b.model)} · ${F.ago(b.at)} ago · read ${b.postCount} posts${b.dropped ? ` · removed ${b.dropped} unsupported ticker${b.dropped > 1 ? 's' : ''}` : ''}</p>`;
  }

  function renderStatus() {
    const el = F.$('#aiStatus');
    if (!el) return;
    const s = spend();
    const [dot, label] = !cfg.key ? ['off', 'AI off'] : busy ? ['busy', 'Thinking…'] : lastErr ? ['bad', 'AI error'] : overBudget() ? ['bad', 'Budget hit'] : ['ok', 'AI on'];
    el.innerHTML = `<b><i class="dot ${dot}"></i>${label}</b><span>${cfg.key ? `${F.usd(s.usd)} of ${F.usd(cfg.budget, 0)} today` : 'Add Claude key'}</span>`;
    el.title = lastErr || (cfg.key ? model().label + ' · ' + s.calls + ' calls today' : 'Add a Claude API key in Settings');
    const err = F.$('#aiErr');
    if (err) {
      err.textContent = lastErr ? lastErr : '';
      err.hidden = !lastErr;
    }
  }

  /* ---------------- settings ---------------- */
  function renderSettings() {
    F.$('#setKey').value = cfg.key ? '••••••••' + cfg.key.slice(-4) : '';
    F.$('#setModel').innerHTML = Object.entries(MODELS).map(([id, m]) => `<option value="${id}" ${id === cfg.model ? 'selected' : ''}>${m.label} — $${m.pin}/$${m.pout} per M tokens</option>`).join('');
    F.$('#setBudget').value = cfg.budget;
    F.$('#setAutoTag').checked = cfg.autoTag;
    F.$('#setAutoBrief').checked = cfg.autoBrief;
    F.$('#setSpend').textContent = `Spent today: ${F.usd(spend().usd)} over ${spend().calls} calls (estimated from token usage).`;
  }
  function bindSettings() {
    F.$('#setKey').addEventListener('focus', (e) => {
      if (e.target.value.startsWith('••')) e.target.value = '';
    });
    F.$('#setSave').onclick = () => {
      const k = F.$('#setKey').value.trim();
      if (k && !k.startsWith('••')) cfg.key = k;
      if (MODELS[F.$('#setModel').value]) cfg.model = F.$('#setModel').value;
      cfg.budget = Math.max(0.5, +F.$('#setBudget').value || 5);
      cfg.autoTag = F.$('#setAutoTag').checked;
      cfg.autoBrief = F.$('#setAutoBrief').checked;
      lastErr = '';
      save();
      renderSettings();
      renderStatus();
      F.emit('ai:changed');
      F.$('#setMsg').textContent = '✅ Saved.';
    };
    F.$('#setForget').onclick = () => {
      cfg.key = '';
      client = null;
      save();
      renderSettings();
      renderStatus();
      F.emit('ai:changed');
      F.$('#setMsg').textContent = '🗑️ Key removed from this browser.';
    };
    F.$('#setTest').onclick = async () => {
      F.$('#setSave').click();
      F.$('#setMsg').textContent = '⏳ Testing…';
      try {
        const out = await call({ purpose: 'test', effort: 'low', max: 2000, system: 'Reply with the JSON object requested.', user: 'Return ok=true.', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } });
        F.$('#setMsg').textContent = out.ok ? `✅ Key works with ${model().label}. 🤖🚀` : '⚠️ Unexpected reply.';
      } catch (e) {
        F.$('#setMsg').textContent = '❌ ' + e.message;
      }
      renderSettings();
    };
  }

  function ready() {
    return !!cfg.key && !overBudget() && !sdkErr;
  }

  F.ai = {
    ready, ask, copilot, makeBrief, linkify, renderBrief, renderSettings,
    cfg: () => cfg,
    start() {
      bindSettings();
      renderSettings(); // the form always mirrors saved settings, so Save can never write blanks
      renderStatus();
      renderBrief();
      F.on('social', (added) => {
        if (added && added.length && cfg.key && cfg.autoTag) {
          added.forEach((p) => tagQueue.push(p));
          if (tagQueue.length > 120) tagQueue.splice(0, tagQueue.length - 120);
        }
      });
      setInterval(tagBatch, 120000);
      setTimeout(tagBatch, 20000);
      setInterval(() => {
        if (ready() && cfg.autoBrief && (!brief || Date.now() - brief.at > 15 * 60000)) F.emit('brief:auto');
      }, 60000);
      setInterval(renderBrief, 30000);
      // the no-AI auto-summary is built from live data, so repaint it as data lands (throttled)
      let rb = 0;
      ['radar', 'markets', 'social'].forEach((ev) =>
        F.on(ev, () => {
          if (brief && ready()) return;
          if (Date.now() - rb < 5000) return;
          rb = Date.now();
          setTimeout(renderBrief, 400);
        })
      );
    },
  };
})();
