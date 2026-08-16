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

  // True when the message contains a URL
  containsLink: function (str) {
    if (!str) return false;
    return /(?:https?:\/\/|www\.)\S+/.test(str) ||
      /\b\S+\.(?:com|net|org|io|tv|gg|me|xyz|live|co|uk|stream)\b/i.test(str);
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
