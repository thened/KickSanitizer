// pageFilters.js — Page-level element filters (Kicks, Top Gifters, animations, etc.)
// Adds KS.PageFilters to the KS namespace.

window.KS = window.KS || {};

KS.PageFilters = (function () {

  let _settings = null;
  let _observer = null;
  let _pendingRestore = false;

  // ── Filter registry ────────────────────────────────────────────────────────
  // Each filter: { key, label, find, reason }
  // key      — settings key that enables this filter
  // find     — function returning an array of elements to evaluate
  // reason   — data-ks-hidden value applied when hidden

  const FILTERS = [
    {
      key: 'page_hideKicks',
      reason: 'kicks',
      find() {
        const els = [];
        // Explicit selectors
        els.push(...KS.Sel.findAll(KS.Sel.kicksWidget));
        els.push(...KS.Sel.findAll(KS.Sel.kicksButton));
        els.push(...KS.Sel.findAll(KS.Sel.kicksBanner));
        els.push(...KS.Sel.findAll(KS.Sel.kicksChatNotice));
        // Text-based: panels with "Kicks" heading
        _findByHeadingAndPanel('kicks', els);
        return _dedup(els);
      },
    },
    {
      key: 'page_hideTopGifters',
      reason: 'top-gifters',
      find() {
        const els = [];
        els.push(...KS.Sel.findAll(KS.Sel.topGiftersPanel));
        _findByHeadingAndPanel('top gifters', els);
        _findByHeadingAndPanel('top supporter', els);
        _findByHeadingAndPanel('gifter leaderboard', els);
        return _dedup(els);
      },
    },
    {
      key: 'page_hideGiftAnimations',
      reason: 'gift-animation',
      find() {
        return _dedup(KS.Sel.findAll(KS.Sel.giftAnimation));
      },
    },
    {
      key: 'page_hidePinnedMessages',
      reason: 'pinned-message',
      find() {
        return _dedup(KS.Sel.findAll(KS.Sel.pinnedMessage));
      },
    },
    {
      key: 'page_hidePollsPredictions',
      reason: 'poll-prediction',
      find() {
        const els = [];
        els.push(...KS.Sel.findAll(KS.Sel.pollWidget));
        els.push(...KS.Sel.findAll(KS.Sel.predictionWidget));
        _findByHeadingAndPanel('poll', els);
        _findByHeadingAndPanel('prediction', els);
        return _dedup(els);
      },
    },
    {
      key: 'page_hideGoals',
      reason: 'goal',
      find() {
        const els = [];
        els.push(...KS.Sel.findAll(KS.Sel.goalWidget));
        _findByHeadingAndPanel('channel goal', els);
        _findByHeadingAndPanel('stream goal', els);
        _findByHeadingAndPanel('sub goal', els);
        return _dedup(els);
      },
    },
    {
      key: 'page_hideSuggestedChannels',
      reason: 'suggested-channels',
      find() {
        const els = [];
        // Confirmed DOM: <button> > <a data-testid="sidebar-recommended-channel-N">
        // Hide the <button> wrapper so no empty shell remains
        for (const a of KS.Sel.findAll(KS.Sel.suggestedChannels)) {
          els.push(a.parentElement || a);
        }
        // The "Show More" / "Show Less" row under the list. Hiding only the
        // channel tiles leaves it behind as an orphaned divider. Both controls
        // share one wrapper div, which also holds the divider lines — hide that.
        // Note: they render only while the sidebar is EXPANDED (confirmed live
        // 2026-08-16: absent at the 56px collapsed width), so this must run from
        // the MutationObserver, not just the initial scan.
        for (const c of KS.Sel.findAll(KS.Sel.suggestedChannelsControls)) {
          els.push(c.parentElement || c);
        }
        _findByHeadingAndPanel('suggested channels', els);
        _findByHeadingAndPanel('recommended channels', els);
        _findByHeadingAndPanel('channels to watch', els);
        return _dedup(els);
      },
    },
    {
      key: 'page_hideRecommendedStreams',
      reason: 'recommended-streams',
      find() {
        const els = [];
        for (const a of KS.Sel.findAll(KS.Sel.recommendedStreams)) {
          els.push(a.parentElement || a);
        }
        _findByHeadingAndPanel('recommended streams', els);
        _findByHeadingAndPanel('you might also like', els);
        return _dedup(els);
      },
    },
    {
      key: 'page_hideAutoplayOverlays',
      reason: 'autoplay',
      find() {
        return _dedup(KS.Sel.findAll(KS.Sel.autoplayOverlay));
      },
    },
    {
      key: 'page_hideChannelPoints',
      reason: 'channel-points',
      find() { return _dedup(KS.Sel.findAll(KS.Sel.channelPointsButton)); },
    },
    {
      key: 'page_hideKicksBalance',
      reason: 'kicks-balance',
      find() { return _dedup(KS.Sel.findAll(KS.Sel.kicksBalanceButton)); },
    },
    {
      key: 'page_hideBanNotice',
      reason: 'ban-notice',
      find() {
        const els = [];
        els.push(...KS.Sel.findAll(KS.Sel.banNotice));
        els.push(...KS.Sel.findAll(KS.Sel.unbanRequest));
        // Confirmed fallback: find the disabled "You're banned from chat" input
        // and walk up to its wrapper div (the container holds both input + unban button)
        const bannedInput = document.querySelector('input[placeholder*="banned" i][disabled]');
        if (bannedInput) {
          // Walk up two levels: input → div.border-... → div.flex.flex-col (the target)
          const wrapper = bannedInput.parentElement && bannedInput.parentElement.parentElement;
          if (wrapper && !els.includes(wrapper)) els.push(wrapper);
        }
        return _dedup(els);
      },
    },
  ];

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _findByHeadingAndPanel(text, out) {
    const heading = KS.Sel.findByHeadingText(text);
    if (!heading) return;
    const panel = KS.Sel.findContainerPanel(heading) || heading.parentElement;
    if (panel && !out.includes(panel)) out.push(panel);
  }

  function _dedup(arr) {
    return arr.filter((el, i, a) => el && a.indexOf(el) === i);
  }

  // Mark the sidebar badges that actually say "LIVE". The same span shows a
  // viewer count on some entries, so this cannot be a CSS-only match — that
  // would paint "LAME" over the number. Identified as the span beside the green
  // dot, which is what the badge is, rather than by a Tailwind class.
  //
  // Re-run on every scan: React replaces these nodes when a channel goes live
  // or offline, which drops the attribute and can also swap LIVE for a count.
  function _markLiveBadges(on) {
    const spans = document.querySelectorAll(
      '[data-testid^="sidebar-"] .bg-green-500 + span');
    for (const span of spans) {
      // A badge already showing a real viewer count keeps it — replacing a
      // number with the word LAME would destroy information, and both features
      // draw through the same ::after.
      const isLive = on && !span.dataset.ksViewers
        && (span.textContent || '').trim().toUpperCase() === 'LIVE';
      if (isLive) span.dataset.ksLame = '1';
      else delete span.dataset.ksLame;
    }
  }

  // ── Forced viewer counts in the sidebar ───────────────────────────────────
  //
  // Kick renders "LIVE" for followed channels instead of the number. The number
  // is not anywhere in the DOM, so it has to be asked for: one lookup per live
  // channel, refreshed every 10 minutes. That interval is deliberately long —
  // this is the only thing the extension does that generates real traffic, and
  // a sidebar number does not need to be fresher than that.
  //
  // Written as a data attribute and drawn by CSS, not as textContent: the
  // sidebar is React-rendered and rewrites its own text whenever a channel goes
  // live or offline. Same split as the LAME badge for the same reason.
  const VIEWERS_REFRESH_MS = 10 * 60 * 1000;
  const VIEWERS_STAGGER_MS = 250;

  const _viewerCounts = new Map();   // slug -> formatted string
  let _viewersTimer = null;
  let _viewersBusy = false;

  function _liveBadges() {
    return document.querySelectorAll('[data-testid^="sidebar-"] .bg-green-500 + span');
  }

  function _slugFor(badge) {
    const link = badge.closest('a[href]');
    const m = link && (link.getAttribute('href') || '').match(/^\/([^\/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  }

  function _formatViewers(n) {
    if (!Number.isFinite(n) || n < 0) return null;
    if (n < 1000) return String(n);
    if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'K';
    return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  // The field name is NOT confirmed against a live response, so several shapes
  // are tried and anything unrecognised yields null. Failing open leaves the
  // badge reading LIVE, which is merely the current behaviour; guessing wrong
  // and rendering a number would be worse than showing nothing.
  function _extractViewers(data) {
    const ls = data && (data.livestream || data.livestream_data || data);
    if (!ls || typeof ls !== 'object') return null;
    const raw = ls.viewer_count ?? ls.viewers ?? ls.viewerCount ?? ls.current_viewers;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async function _refreshViewerCounts() {
    if (_viewersBusy) return;
    if (!_settings || !_settings.enabled || !_settings.page_forceViewerCount) return;

    const slugs = [];
    for (const badge of _liveBadges()) {
      const slug = _slugFor(badge);
      // Only channels showing LIVE. One that already displays a number needs no
      // lookup, and asking for it would be traffic for nothing.
      if (slug && (badge.textContent || '').trim().toUpperCase() === 'LIVE'
          && !slugs.includes(slug)) slugs.push(slug);
    }
    if (!slugs.length) return;

    _viewersBusy = true;
    try {
      for (const slug of slugs) {
        try {
          const r = await fetch('/api/v2/channels/' + encodeURIComponent(slug),
                                { headers: { Accept: 'application/json' } });
          if (r.ok) {
            const n = _extractViewers(await r.json());
            const text = _formatViewers(n);
            if (text) _viewerCounts.set(slug, text);
          }
        } catch (_) { /* one channel failing must not stop the rest */ }
        // Spaced out rather than fired as a burst — a dozen simultaneous
        // requests from a page that normally makes none is the kind of thing
        // rate limiting notices.
        await new Promise(res => setTimeout(res, VIEWERS_STAGGER_MS));
      }
    } finally {
      _viewersBusy = false;
    }
    _applyViewerCounts();
  }

  // Re-applied on every scan, because React replaces these nodes and drops the
  // attribute with them. Reads only from cache, so it costs nothing.
  function _applyViewerCounts() {
    const on = !!(_settings && _settings.enabled && _settings.page_forceViewerCount);
    for (const badge of _liveBadges()) {
      if (!on) { delete badge.dataset.ksViewers; continue; }
      const slug = _slugFor(badge);
      const text = slug && _viewerCounts.get(slug);
      // Only override the word LIVE. If Kick is already showing a number, that
      // number is fresher than ours and must not be replaced by a stale one.
      if (text && (badge.textContent || '').trim().toUpperCase() === 'LIVE') {
        badge.dataset.ksViewers = text;
      } else {
        delete badge.dataset.ksViewers;
      }
    }
  }

  function _syncViewerTimer() {
    const on = !!(_settings && _settings.enabled && _settings.page_forceViewerCount);
    if (on && !_viewersTimer) {
      _viewersTimer = setInterval(_refreshViewerCounts, VIEWERS_REFRESH_MS);
      _refreshViewerCounts();
    } else if (!on && _viewersTimer) {
      clearInterval(_viewersTimer);
      _viewersTimer = null;
      _viewerCounts.clear();
      _applyViewerCounts();
    }
  }

  // Hiding Kick's ban box takes the unban-request button with it — which is the
  // point — but it also removes the only sign that you are banned, so the input
  // just looks broken. Replace it with one quiet line.
  //
  // Detected by the disabled input whose placeholder says "banned", which is the
  // confirmed marker the ban filter itself already uses.
  function _applyBanNotice() {
    const on = !!(_settings && _settings.enabled && _settings.page_hideBanNotice);
    const existing = document.querySelector('.ks-banned-notice');
    const bannedInput = document.querySelector('input[placeholder*="banned" i][disabled]');

    if (!on || !bannedInput) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.isConnected) return;

    // input -> bordered div -> the wrapper the ban filter hides.
    const wrapper = bannedInput.parentElement && bannedInput.parentElement.parentElement;
    if (!wrapper || !wrapper.parentElement) return;

    const note = document.createElement('div');
    note.className = 'ks-banned-notice';
    note.textContent = '😢 You are banned from this chat';
    // Beside the hidden box, not inside it — anything inside inherits the
    // display:none we just applied.
    wrapper.parentElement.insertBefore(note, wrapper);
  }

  function _hideEl(el, reason) {
    if (!el.dataset.ksHidden) {
      if (window.KS && KS.Stats) KS.Stats.count(reason);
      el.dataset.ksHidden = reason;
    }
  }

  function _showEl(el) {
    delete el.dataset.ksHidden;
  }

  // ── Channel blocklist (suggested channel dislike) ──────────────────────────

  function _applyChannelBlocklist(settings) {
    // If the whole suggested section is hidden, nothing to do
    if (settings && settings.page_hideSuggestedChannels) return;

    // Un-hide any tiles that may have been removed from the blocklist
    document.querySelectorAll('[data-ks-hidden="blocked-channel"]').forEach(_showEl);

    const blocked = (settings && settings.blockedChannels) || [];
    // Confirmed DOM: selector matches <a data-testid="sidebar-recommended-channel-N" href="/slug">
    const tiles = KS.Sel.findAll(KS.Sel.suggestedChannels);
    for (const tile of tiles) {
      // Hide the <button> wrapper (parent of <a>) so nothing bleeds through
      const wrapper = tile.parentElement || tile;
      if (wrapper.dataset.ksHidden) continue;
      const slug = _getChannelSlug(tile);
      if (!slug) continue;
      if (blocked.includes(slug)) {
        _hideEl(wrapper, 'blocked-channel');
      } else if (!tile.querySelector('.ks-dislike-btn')) {
        _injectDislikeBtn(tile, slug, wrapper);
      }
    }
  }

  function _getChannelSlug(tile) {
    // Confirmed: tile is the <a> element itself, href="/channelslug"
    const href = tile.getAttribute ? tile.getAttribute('href') : null;
    if (href) {
      const m = href.match(/^\/([^\/\?#]+)/);
      if (m && m[1]) return m[1].toLowerCase();
    }
    // Fallback: find a link inside
    const link = tile.querySelector && tile.querySelector('a[href]');
    if (link) {
      const m = (link.getAttribute('href') || '').match(/^\/([^\/\?#]+)/);
      if (m && m[1]) return m[1].toLowerCase();
    }
    return null;
  }

  function _injectDislikeBtn(tile, slug, wrapper) {
    const btn = document.createElement('button');
    btn.className = 'ks-dislike-btn';
    btn.title = 'Hide ' + slug + ' from suggestions';
    btn.setAttribute('aria-label', 'Hide ' + slug + ' from suggestions');
    btn.textContent = '✕';
    // tile is the <a>; make it position:relative so the absolute btn works
    tile.style.position = 'relative';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.storage.local.get(['blockedChannels'], (data) => {
        const list = data.blockedChannels || [];
        if (!list.includes(slug)) {
          list.push(slug);
          chrome.storage.local.set({ blockedChannels: list });
        }
      });
      _hideEl(wrapper, 'blocked-channel');
    });
    tile.appendChild(btn);
  }

  // ── Apply / restore ────────────────────────────────────────────────────────

  function apply(settings) {
    _settings = settings;
    // Body class rather than a FILTERS entry: this restyles an element, it does
    // not hide one, so there is nothing to find or restore.
    const lame = !!(settings.enabled && settings.page_liveSaysLame);
    document.body.classList.toggle('ks-lame', lame);
    _syncViewerTimer();
    // Viewer counts first: _markLiveBadges refuses to touch a badge that has
    // one, and that guard only works if the attribute is already there.
    _applyViewerCounts();
    _markLiveBadges(lame);
    _applyBanNotice();
    if (!settings.enabled) { restoreAll(); return; }

    for (const filter of FILTERS) {
      const active = settings[filter.key];
      if (active) {
        for (const el of filter.find()) {
          // Avoid hiding structural ancestors of the chat or video player
          if (!_isSafeToHide(el)) continue;
          _hideEl(el, filter.reason);
        }
      } else {
        // Restore elements hidden by this specific filter
        const sel = `[data-ks-hidden="${filter.reason}"]`;
        document.querySelectorAll(sel).forEach(_showEl);
      }
    }

    _applyChannelBlocklist(settings);
  }

  // Safety check: don't hide the video player, chat input, or body-level containers
  function _isSafeToHide(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const tag = el.tagName && el.tagName.toLowerCase();
    if (tag === 'video' || tag === 'iframe') return false;
    // Don't hide elements that contain the chat input
    if (el.querySelector('input[type="text"], textarea, [contenteditable]')) return false;
    return true;
  }

  function restoreAll() {
    const reasons = FILTERS.map(f => f.reason);
    for (const reason of reasons) {
      document.querySelectorAll(`[data-ks-hidden="${reason}"]`).forEach(_showEl);
    }
  }

  // ── Handle new DOM additions ───────────────────────────────────────────────

  // Page furniture changes rarely; chat messages arrive constantly. Doing a
  // full filter pass per added node was the extension's dominant CPU cost.
  //
  // Measured on a live Kick page: filter.find() is document-wide, and the
  // heading-based lookups inside it enumerate every h1-h6/p/span/button on the
  // page (435 elements even on an idle one), six times — ~2.7 ms PER NODE,
  // against 0.041 ms for the entire per-message path. It also degrades as it
  // runs: every message adds spans, growing the set each later node scans.
  //
  // One coalesced pass instead. A sidebar tile appearing 400 ms later than it
  // could have is imperceptible; a browser pegged at 100% is not.
  const SCAN_DEBOUNCE_MS = 400;
  let _scanPending = null;

  function handleAddedNode(node) {
    if (!_settings || !_settings.enabled) return;
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (_scanPending) return;                 // a pass is already queued
    _scanPending = setTimeout(() => {
      _scanPending = null;
      try { scan(document.body); } catch (_) { }
      _applyChannelBlocklist(_settings);
    }, SCAN_DEBOUNCE_MS);
  }

  function scan(root) {
    if (!_settings || !_settings.enabled) return;
    for (const filter of FILTERS) {
      if (!_settings[filter.key]) continue;
      for (const el of filter.find()) {
        if (_isSafeToHide(el)) _hideEl(el, filter.reason);
      }
    }
    _applyViewerCounts();
    _markLiveBadges(!!_settings.page_liveSaysLame);
    _applyBanNotice();
    _applyChannelBlocklist(_settings);
  }

  function update(settings) {
    apply(settings);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init: apply,
    update,
    apply,
    scan,
    handleAddedNode,
    restoreAll,
  };
}());
