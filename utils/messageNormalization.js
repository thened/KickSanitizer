// messageNormalization.js — Pure text utilities for comparing and classifying messages.
// No DOM access here — all functions operate on plain strings.

window.KS = window.KS || {};

KS.Normalize = {

  // Normalize a string for comparison
  text: function (str, options) {
    if (!str) return '';
    options = options || {};
    let s = str;
    s = s.toLowerCase();
    s = s.trim();
    s = s.replace(/\s+/g, ' ');
    if (options.removePunctuation) s = s.replace(/[^\w\s]/g, '');
    return s;
  },

  // Check whether two strings are the same after normalization
  areSimilar: function (a, b, mode) {
    mode = mode || 'normalized';
    if (mode === 'exact') return a.trim() === b.trim();
    return this.text(a) === this.text(b);
  },

  // True when the string is nothing but Unicode emoji and whitespace.
  //
  // Kick emotes are span[data-emote-id] elements, so "hide emote-only messages"
  // never saw a message like "🤣🤣🤣" — to the DOM that is ordinary text.
  // Extended_Pictographic covers the pictographs; the rest of the class handles
  // the pieces that join them: variation selectors, zero-width joiners, skin
  // tone modifiers, keycaps and regional indicators (flags).
  isEmojiOnly: function (str) {
    const s = String(str || '').trim();
    if (!s) return false;
    let stripped;
    try {
      stripped = s.replace(
        /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\s]/gu,
        ''
      );
    } catch (_) {
      return false;            // no Unicode property escapes — fail open
    }
    if (stripped.length) return false;
    // Whitespace alone is not emoji-only; there has to be a pictograph.
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s);
  },

  // True when the string consists mainly of a single repeated character or short pattern
  isRepeatedChars: function (str) {
    if (!str) return false;
    const s = str.trim();
    if (s.length < 4) return false;
    // Single character repeating
    if (/^(.)\1{3,}$/.test(s)) return true;
    // Short pattern (1–4 chars) repeating 4+ times
    if (/^(.{1,4})\1{3,}$/.test(s)) return true;
    return false;
  },

  // True when the string is predominantly uppercase letters (and long enough to matter)
  isAllCaps: function (str) {
    if (!str) return false;
    const s = str.trim();
    if (s.length < 6) return false;
    const letters = s.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 4) return false;
    const upperCount = (s.match(/[A-Z]/g) || []).length;
    return upperCount / letters.length >= 0.8;
  },

  // True when the message begins with a bot command (! followed by a word)
  isBotCommand: function (str) {
    if (!str) return false;
    return /^\s*!\w/.test(str);
  },

  // Undo the tricks people use to get a link past chat filters, so the link
  // test below sees what a reader sees. Handles:
  //   example dot com · example(dot)com · example[.]com · example . com
  //   e x a m p l e . c o m · hxxp:// · zero-width characters
  deobfuscateLink: function (str) {
    let s = String(str || '').toLowerCase();

    // Zero-width and soft hyphens — invisible, purely for evasion.
    s = s.replace(/[​‌‍⁠﻿­]/g, '');

    // hxxp / h**p style scheme mangling.
    s = s.replace(/\bh[x*]{2}ps?\b/g, 'http');

    // Characters spaced out one by one: "e x a m p l e" -> "example".
    // Runs of 3+ single characters only, so ordinary prose survives. Done
    // BEFORE the dot handling: collapsing dots first welds "e . c" into "e.c",
    // which breaks the run and leaves a stranded "c o m".
    const joinRuns = t => t.replace(/(?:\b\w\s+){2,}\b\w\b/g, m => m.replace(/\s+/g, ''));
    s = joinRuns(s);

    // "dot" spelled out, optionally bracketed.
    s = s.replace(/\s*[([{]?\s*(?:dot|d0t)\s*[)\]}]?\s*/g, '.');

    // Bracketed or spaced literal dots: example[.]com, example . com
    s = s.replace(/\s*[([{]\s*\.\s*[)\]}]\s*/g, '.');
    s = s.replace(/\s*\.\s*/g, '.');

    // Again: the dot pass can expose a new run ("scamsite.c o m").
    s = joinRuns(s);

    return s;
  },

  // True when the message contains a URL — including one broken up to evade
  // this check. Kick chat is full of "site dot com" precisely because a naive
  // link filter only looks for the literal form.
  containsLink: function (str) {
    if (!str) return false;
    const direct = /(?:https?:\/\/|www\.)\S+/.test(str) ||
      /\b\S+\.(?:com|net|org|io|tv|gg|me|xyz|live|co|uk|stream)\b/i.test(str);
    if (direct) return true;

    const clean = this.deobfuscateLink(str);
    if (clean === String(str || '').toLowerCase()) return false;  // nothing changed
    return /(?:https?:\/\/|www\.)\S+/.test(clean) ||
      /\b[\w-]+\.(?:com|net|org|io|tv|gg|me|xyz|live|co|uk|stream)\b/i.test(clean);
  },

  // Bigram-based similarity score (0–1)
  similarity: function (a, b) {
    const na = this.text(a);
    const nb = this.text(b);
    if (na === nb) return 1;
    if (!na || !nb) return 0;

    function bigrams(s) {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s[i] + s[i + 1]);
      return set;
    }

    const ba = bigrams(na);
    const bb = bigrams(nb);
    let hits = 0;
    for (const g of ba) { if (bb.has(g)) hits++; }
    return (2 * hits) / (ba.size + bb.size);
  },
};
