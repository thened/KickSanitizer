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
