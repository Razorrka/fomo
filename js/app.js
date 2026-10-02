/* fomo — boot, layout plumbing, modals, toasts, brief + ask wiring. */
(function () {
  const F = window.F;

  F.toast = (msg, kind = '') => {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    F.$('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 4200);
    setTimeout(() => el.remove(), 4700);
  };

  /* ---------- data-source health ---------- */
  const ABOUT = {
    coinbase: ['Coinbase', 'Crypto prices, live websocket ticks'],
    hyperliquid: ['Hyperliquid', 'Stock prices via 24/7 stock perps'],
    dexscreener: ['DexScreener', 'Meme coin prices, liquidity, trades; paid promotions'],
    geckoterminal: ['GeckoTerminal', 'Organic trending pools across chains'],
    bluesky: ['Bluesky', 'Verified outlets + crowd search'],
    mastodon: ['Mastodon', 'Crowd hashtags'],
    rss: ['Newsroom RSS', 'CoinDesk, The Block, Cointelegraph'],
    feargreed: ['alternative.me', 'Crypto Fear & Greed index'],
    coingecko: ['CoinGecko', 'Total market cap, BTC dominance'],
  };
  function renderHealth() {
    const h = F.health.all();
    const names = Object.keys(ABOUT);
    const ok = names.filter((n) => h[n] && h[n].ok).length;
    const bad = names.filter((n) => h[n] && !h[n].ok).length;
    const btn = F.$('#healthBtn');
    btn.classList.toggle('warn', bad > 0);
    btn.querySelector('.dot').className = 'dot ' + (bad ? 'bad' : ok ? 'ok' : 'busy');
    F.$('#healthSum').textContent = bad ? `${ok}/${names.length} sources` : ok ? `Live · ${ok} sources` : 'Connecting…';
    F.$('#healthList').innerHTML = names.map((n) => {
      const x = h[n];
      const st = !x ? '<i class="dot busy"></i>connecting' : x.ok ? `<i class="dot ok"></i>ok · ${F.ago(x.at)} ago` : `<i class="dot bad"></i>${F.esc(x.err)}${x.at ? ` · last ok ${F.ago(x.at)} ago` : ''}`;
      return `<div class="hr"><b>${ABOUT[n][0]}</b><span class="mut">${ABOUT[n][1]}${x && x.note ? ' · ' + F.esc(x.note) : ''}</span><span>${st}</span></div>`;
    }).join('');
  }

  /* ---------- modals ---------- */
  function openModal(id) {
    F.$(id).hidden = false;
    if (id === '#settings') F.ai.renderSettings();
    if (id === '#healthModal') renderHealth();
  }
  function bindModals() {
    F.$('#settingsBtn').onclick = () => openModal('#settings');
    F.$('#healthBtn').onclick = () => openModal('#healthModal');
    F.$('#aiStatus').onclick = () => openModal('#settings');
    F.$$('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
      })
    );
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        F.$$('.modal').forEach((m) => (m.hidden = true));
        F.$('#askOut').hidden = true;
      }
      // "/" jumps to the ask bar, like the search in the fomo app
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        F.$('#askIn').focus();
      }
    });
  }

  /* ---------- brief + ask ---------- */
  let briefing = false;
  async function runBrief(auto) {
    if (briefing) return;
    if (!F.ai.ready()) {
      if (!auto) openModal('#settings');
      return;
    }
    briefing = true;
    const btn = F.$('#briefBtn');
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    try {
      await F.ai.makeBrief();
      F.ai.renderBrief();
      if (!auto) F.toast('Fresh brief is in 🤖');
    } catch (e) {
      if (!auto) F.toast('Brief failed: ' + e.message, 'bad');
    } finally {
      briefing = false;
      btn.disabled = false;
      btn.textContent = 'Brief me';
    }
  }
  function bindBrief() {
    F.$('#briefBtn').onclick = () => runBrief(false);
    F.on('brief:auto', () => runBrief(true));
    F.on('ai:changed', () => F.ai.renderBrief());
    const out = F.$('#askOut');
    const head = (q) => `<p class="q"><span>${F.esc(q)}</span><button type="button" data-x>✕</button></p>`;
    out.addEventListener('click', (e) => e.target.closest('[data-x]') && (out.hidden = true));
    document.addEventListener('click', (e) => {
      if (!out.hidden && !out.contains(e.target) && !e.target.closest('#askForm')) out.hidden = true;
    });
    F.$('#askForm').onsubmit = async (e) => {
      e.preventDefault();
      const q = F.$('#askIn').value.trim();
      if (!q) return;
      out.hidden = false;
      if (!F.ai.ready()) {
        out.innerHTML = head(q) + '<p>Ask fomo needs a Claude API key. Add one in Settings (the gear, top right).</p>';
        return;
      }
      out.innerHTML = head(q) + '<p><span class="spin">🤖</span> Reading the live feed and the radar…</p>';
      // if the question names a cashtag on the radar, focus the snapshot on that token
      const m = q.match(/\$([A-Za-z0-9]{2,12})/);
      const t = m && F.radar.list().find((x) => x.sym.toUpperCase() === m[1].toUpperCase());
      try {
        const r = await F.ai.ask(q, t ? t.key : null);
        out.innerHTML = head(q) + `<div class="a">${F.ai.linkify(r.text, r.ids)}</div>`;
      } catch (err) {
        out.innerHTML = head(q) + `<p>Error: ${F.esc(err.message)}</p>`;
      }
    };
  }

  /* ---------- columns on smaller screens ---------- */
  function showCol(id) {
    F.$$('.col').forEach((c) => c.classList.toggle('show', c.id === id));
    F.$('.grid').classList.toggle('show-bot', id === 'bot');
    F.$$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.col === id));
  }

  function boot() {
    bindModals();
    bindBrief();
    F.$('#tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-col]');
      if (b) showCol(b.dataset.col);
    });
    F.on('show-col', (id) => window.innerWidth <= 1180 && showCol(id));
    showCol('center');
    F.on('health', () => {
      clearTimeout(boot.h);
      boot.h = setTimeout(renderHealth, 300);
    });
    F.on('bot:trade', (x) => {
      if (x.side === 'buy') F.toast(`🚀 Bot bought ${x.sym}`, 'good');
      else F.toast(`Bot sold ${x.sym} · ${x.pnl >= 0 ? '+' : '−'}${F.usd(Math.abs(x.pnl))}`, x.pnl >= 0 ? 'good' : 'bad');
    });

    F.panels.start();
    F.markets.start();
    F.social.start();
    F.radar.start();
    F.bot.start();
    F.ai.start();
    renderHealth();
    setInterval(renderHealth, 15000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
