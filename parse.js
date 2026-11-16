// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer whose
// parse(markdown) returns exactly the HTML marked 18.1.3 produces with its
// default options (gfm on, breaks off, pedantic off, async off).
//
// Design: the document is split into lines once. Blocks are rendered
// straight to strings by a small recursive line parser (no token tree, no
// per-node allocation for the common shapes), and inline content is scanned
// left to right with one shared "next special character" search, building a
// flat node list only where emphasis or links need structure. Nothing is
// kept between parse() calls: every call is pure.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST_RE = /[&<>"']/;
const ESCAPE_ATTR_RE = /[<>\"']/g;
const ESCAPE_ATTR_TEST_RE = /[<>\"']/;
// An ampersand is left alone when it starts something shaped like a
// character reference (&name;, &#123;, &#x1f;); every other & is escaped.
// This matches marked's attribute escaping exactly.
const ATTR_AMP_RE = /&(?!(?:\w+|#\d+|#[xX][0-9a-fA-F]+);)/g;
const ESCAPE_CODE_RE = /[&<>"']/g;

function escText(s) {
  // Fast path: most text needs no escaping at all.
  if (!ESCAPE_TEST_RE.test(s)) return s;
  return s.replace(ESCAPE_RE, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

function escAttr(s) {
  if (!ESCAPE_ATTR_TEST_RE.test(s) && s.indexOf('&') === -1) return s;
  return s.replace(ATTR_AMP_RE, '&amp;').replace(ESCAPE_ATTR_RE, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

// Attribute escaping for autolink hrefs: the reference escapes every
// '&' there, so a '&amp;' in the matched text becomes '&amp;amp;'.
// Explicit-link hrefs keep valid entities (their destination is
// entity-decoded first), so they use escAttr instead.
function escAttrAll(s) {
  return s.replace(/&/g, '&amp;').replace(ESCAPE_ATTR_RE, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}

function escCode(s) {
  if (!ESCAPE_TEST_RE.test(s)) return s;
  return s.replace(ESCAPE_CODE_RE, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });
}

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

function isAlphaNum(c) {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// ASCII punctuation (CommonMark's punctuation set).
function isAsciiPunct(c) {
  const code = c.charCodeAt(0);
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) || (code >= 123 && code <= 126);
}

// Unicode punctuation or symbol (used for flanking rules). Fast path for
// ASCII, then a single-character Unicode property test.
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(c) {
  const code = c.charCodeAt(0);
  if (code < 128) return isAsciiPunct(c);
  return UNICODE_PUNCT_RE.test(c);
}

function isWhitespace(c) {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  if (code < 128) return code === 32 || (code >= 9 && code <= 13);
  return /\s/.test(c);
}

// Column width of the leading whitespace of a line: a tab advances to the
// next multiple of 4 columns. Returns [columns, indexOfFirstNonSpace].
function leadingIndent(line) {
  let col = 0;
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { col += 1; i += 1; }
    else if (ch === 9) { col += 4 - (col % 4); i += 1; }
    else break;
  }
  return [col, i];
}

// Remove up to `cols` columns of leading whitespace from a line. A tab
// that starts at or after the cut stays a literal tab; a tab straddling
// the cut is replaced by only the columns that survive it. Used for
// code-block content, where a tab past the indent is literal.
function stripCols(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { col += 1; i += 1; }
    else {
      const m = 4 - (col % 4);
      if (col + m <= cols) { col += m; i += 1; }
      else return ' '.repeat(col + m - cols) + line.slice(i + 1);
    }
  }
  return line.slice(i);
}

// Remove `cols` columns after expanding every leading tab to spaces by
// its original column position. Used when stripping a list item's or a
// blockquote's indent, where the content's columns are counted expanded.
function stripColsExpand(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') { out += ' '; col += 1; i += 1; }
    else { const m = 4 - (col % 4); out += ' '.repeat(m); col += m; i += 1; }
  }
  return out.slice(cols) + line.slice(i);
}

// Strip a blockquote marker: up to 3 spaces, '>', then one optional
// column of whitespace (a tab after '>' loses one column of its width).
// Returns the content, or null when the line is not a quote line.
function stripBlockquoteMarker(s) {
  let i = 0;
  while (i < s.length && s[i] === ' ') i += 1;
  if (i > 3 || s[i] !== '>') return null;
  let pos = i + 1;
  let col = i + 1;
  let spaces = '';
  while (pos < s.length && (s[pos] === ' ' || s[pos] === '\t')) {
    if (s[pos] === ' ') { spaces += ' '; col += 1; }
    else { const n = 4 - (col % 4); spaces += ' '.repeat(n); col += n; }
    pos += 1;
  }
  return spaces.slice(1) + s.slice(pos);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// Entity handling, as marked does it (verified against the reference):
//   - a numeric reference &#123; / &#x1f600; decodes to the character
//     (0, surrogates and > 0x10FFFF become U+FFFD);
//   - a named reference &name; is passed through verbatim, whatever the
//     name is (&notanentity; stays &notanentity;);
//   - anything else starting with & is a literal & (escaped on output).
// parseEntity returns [kind, text, length]: kind 0 = decoded character
// (goes into a text node), kind 1 = verbatim reference (its own node),
// or null when there is no reference here.
function parseEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let code = 0;
    let valid = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j += 1;
      const start = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c >= 48 && c <= 57) code = code * 16 + (c - 48);
        else if (c >= 97 && c <= 102) code = code * 16 + (c - 87);
        else if (c >= 65 && c <= 70) code = code * 16 + (c - 55);
        else break;
        j += 1;
      }
      // At most 6 hex digits.
      valid = j > start && j - start <= 6 && j < n && s[j] === ';';
    } else {
      const start = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c >= 48 && c <= 57) code = code * 10 + (c - 48);
        else break;
        j += 1;
      }
      // At most 7 decimal digits.
      valid = j > start && j - start <= 7 && j < n && s[j] === ';';
    }
    if (!valid) return null;
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    return [0, String.fromCodePoint(code), j - i + 1];
  }
  // Named reference: & followed by word characters and a semicolon.
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j += 1;
    else break;
  }
  if (j < n && s[j] === ';' && j > i + 1) return [1, s.slice(i, j + 1), j - i + 1];
  return null;
}

// URL cleaning: marked does not block any scheme (javascript: and data:
// links pass through); it only percent-encodes the href with encodeURI
// and then un-does the encoding of '%' itself, so existing %XX escapes
// survive. encodeURI throws on lone surrogates: then the link is dropped
// (its text renders with no anchor).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Node kinds: 0 text, 1 code span, 2 delimiter run, 3 link/image,
// 4 raw HTML, 5 hard break, 6 emphasis wrapper, 7 verbatim entity (&name;).
const SPECIAL_RE = /[\\`*_!\[<&~\n\]]/g;
// GFM extended autolinks. The www pattern's path may run past characters
// that are special elsewhere (* _ ` [ & ~), so it is matched against the
// raw text, not against a pre-split chunk.
const WWW_RE = /www\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9]{2,}(?:[^\s<]*)?/g;
const EMAIL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)+/g;
// Bare scheme URLs: only http/https/ftp link (no dot required, no
// preceding-character restriction, case-insensitive scheme). sftp,
// ssh, git and other schemes do not autolink; the ftp part of
// sftp:// still does, starting at the 'f'.
const SCHEME_URL_RE = /(?:https?|ftp):\/\/[^\s<]*/gi;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;
const EMAIL_FULL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// A backslash escape in a destination or title: \ + ASCII punctuation
// yields the punctuation, anything else keeps the backslash.
function unescapeInline(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) { out += s[i + 1]; i += 1; }
    else out += s[i];
  }
  return out;
}

function normalizeLabel(s) {
  return s.toLowerCase().replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();
}

// True when s contains an unescaped '[' or ']' — such a label can never
// be a link reference (definitions and reference lookups forbid them,
// even though inline link labels may nest brackets).
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && (s[i + 1] === '[' || s[i + 1] === ']')) { i += 1; continue; }
    if (c === '[' || c === ']') return true;
  }
  return false;
}

// Validate a link label's raw text the way marked's label grammar does.
// Backslash escapes are opaque. A backtick unit is a maximal backtick run,
// then characters with no backtick in them, then a maximal backtick run of
// any length. A backtick run of length >= 2 sitting right at the end of
// the label (before its closing bracket) is literal text. Any other
// unmatched backtick makes the label unusable, so no link forms.
function validLabelText(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 96) {
      let run = 1;
      while (i + run < n && s.charCodeAt(i + run) === 96) run += 1;
      let j = i + run;
      while (j < n && s.charCodeAt(j) !== 96) {
        if (s.charCodeAt(j) === 92) j += 2;
        else j += 1;
      }
      if (j < n) {
        let run2 = 1;
        while (j + run2 < n && s.charCodeAt(j + run2) === 96) run2 += 1;
        i = j + run2;
        continue;
      }
      if (i + run === n && run >= 2) return true;
      return false;
    }
    i += 1;
  }
  return true;
}

// Find the end of a bracketed label starting at s[start] === '['.
// Returns the index just past the closing ']' or -1. Brackets may nest
// two deep; backtick units follow the same rule as validLabelText.
function scanLabelEnd(s, start) {
  const n = s.length;
  let depth = 0;
  let j = start + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 96) {
      let run = 1;
      while (j + run < n && s.charCodeAt(j + run) === 96) run += 1;
      let k = j + run;
      while (k < n && s.charCodeAt(k) !== 96) {
        if (s.charCodeAt(k) === 92) k += 2;
        else k += 1;
      }
      if (k < n) {
        let run2 = 1;
        while (k + run2 < n && s.charCodeAt(k + run2) === 96) run2 += 1;
        j = k + run2;
        continue;
      }
      if (j + run < n && s[j + run] === ']' && depth === 0 && run >= 2) { j += run; continue; }
      return -1;
    }
    if (c === 91) {
      depth += 1;
      if (depth > 2) return -1;
      j += 1;
      continue;
    }
    if (c === 93) {
      if (depth === 0) return j + 1;
      depth -= 1;
      j += 1;
      continue;
    }
    j += 1;
  }
  return -1;
}

function skipInlineWS(s, p) {
  const n = s.length;
  while (p < n) {
    const c = s.charCodeAt(p);
    if (c === 32 || c === 9 || c === 10 || c === 13) p += 1;
    else break;
  }
  return p;
}

// After a destination (or after '(' when the destination is empty):
// optional title, then ')'. Returns {title, end} or null.
function parseTitleAndClose(s, p) {
  p = skipInlineWS(s, p);
  if (p >= s.length) return null;
  if (s[p] === ')') return { title: null, end: p + 1 };
  const q = s[p];
  if (q === '"' || q === "'") {
    let j = p + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === q) {
        const title = unescapeInline(s.slice(p + 1, j));
        const after = skipInlineWS(s, j + 1);
        if (after < s.length && s[after] === ')') return { title, end: after + 1 };
        return null;
      }
      j += 1;
    }
    return null;
  }
  if (q === '(') {
    // A parenthesised title ends at the first unescaped ')' (no nesting).
    let j = p + 1;
    while (j < s.length) {
      if (s[j] === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (s[j] === ')') {
        const title = unescapeInline(s.slice(p + 1, j));
        const after = skipInlineWS(s, j + 1);
        if (after < s.length && s[after] === ')') return { title, end: after + 1 };
        return null;
      }
      j += 1;
    }
    return null;
  }
  return null;
}

// Parse an inline link's (destination title) starting at s[j] === '('.
// Returns {href, title, end} or null.
function parseInlineLink(s, j) {
  const n = s.length;
  let p = skipInlineWS(s, j + 1);
  if (p >= n) return null;
  if (s[p] === '<') {
    // Angle-bracket destination: it ends at the first UNESCAPED '>' after
    // which the rest completes the link. Content may hold spaces, '<'
    // and '>', but no line ending or control character.
    let q = p + 1;
    while (true) {
      const gt = s.indexOf('>', q);
      if (gt === -1) return null;
      // A '>' preceded by an unescaped backslash does not close the dest.
      let bs = 0;
      for (let k = gt - 1; k > p && s[k] === '\\'; k--) bs += 1;
      if (bs % 2 === 1) { q = gt + 1; continue; }
      const content = s.slice(p + 1, gt);
      let bad = false;
      for (let k = 0; k < content.length; k++) {
        const code = content.charCodeAt(k);
        if (code === 10 || code === 13 || (code < 32 && code !== 9) || code === 127) { bad = true; break; }
      }
      if (!bad) {
        const res = parseTitleAndClose(s, gt + 1);
        if (res) return { href: unescapeInline(content), title: res.title, end: res.end };
      }
      q = gt + 1;
    }
  }
  // Bare destination: balanced parentheses, no spaces or control chars.
  let depth = 0;
  let q = p;
  let out = '';
  while (q < n) {
    const c = s[q];
    if (c === '\\' && q + 1 < n && isAsciiPunct(s[q + 1])) { out += s[q + 1]; q += 2; continue; }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    const code = s.charCodeAt(q);
    if (code < 32 || code === 127) return null;
    if (c === '(') { depth += 1; out += c; q += 1; continue; }
    if (c === ')') {
      if (depth === 0) return { href: out, title: null, end: q + 1 };
      depth -= 1;
      out += c;
      q += 1;
      continue;
    }
    out += c;
    q += 1;
  }
  if (q >= n) return null;
  const res = parseTitleAndClose(s, q);
  if (!res) return null;
  return { href: out, title: res.title, end: res.end };
}

// Parse an inline HTML tag starting at s[i] === '<'. Returns the index
// just past the tag or -1 when this is not a tag.
function parseHtmlTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s[i + 4] === '>') return i + 5;
    if (s[i + 4] === '-' && s[i + 5] === '>') return i + 6;
    const end = s.indexOf('-->', i + 4);
    return end === -1 ? -1 : end + 3;
  }
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    return end === -1 ? -1 : end + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    return end === -1 ? -1 : end + 3;
  }
  if (s.startsWith('<!', i) && i + 2 < n) {
    const c = s.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const end = s.indexOf('>', i + 2);
      return end === -1 ? -1 : end + 1;
    }
    return -1;
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j += 1; }
  if (j >= n) return -1;
  const c0 = s.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j += 1;
    else break;
  }
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j += 1;
    return j < n && s[j] === '>' ? j + 1 : -1;
  }
  // After the tag name only whitespace, '/' or '>' may follow.
  if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '\r' && s[j] !== '/' && s[j] !== '>') return -1;
  // Open tag: attributes until '>' or '/>'.
  while (true) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j += 1;
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (s[j] === '/') return -1;
    // Attribute name: [A-Za-z_:][A-Za-z0-9_.:-]* (marked's rule).
    const nameStart = j;
    const c0 = s.charCodeAt(j);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95 || c0 === 58)) return -1;
    j += 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 46 || c === 58 || c === 45) j += 1;
      else break;
    }
    if (j === nameStart) return -1;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j += 1;
    if (j < n && s[j] === '=') {
      j += 1;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j += 1;
      if (j >= n) return -1;
      if (s[j] === '"' || s[j] === "'") {
        const quote = s[j];
        j += 1;
        while (j < n && s[j] !== quote) j += 1;
        if (j >= n) return -1;
        j += 1;
      } else {
        const valStart = j;
        while (j < n) {
          const c = s.charCodeAt(j);
          if (c === 32 || c === 9 || c === 10 || c === 13 || c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96 || c < 32 || c === 127) break;
          j += 1;
        }
        if (j === valStart) return -1;
      }
      // After a value only whitespace, '/' or '>' may follow.
      if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '\r' && s[j] !== '/' && s[j] !== '>') return -1;
    }
  }
}

// Punctuation a bare autolink match may end with only when more text
// follows it (the reference's backpedal set, minus '(' ')' '&' which
// are handled separately).
const BACKPEDAL_PUNCT = '?!.,:;*_\'"~)';

// Trim a www/scheme autolink match the way the reference backpedals it:
// /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
// applied until it stops changing. One left-to-right pass reaches the
// Trim a bare autolink match the way the reference's _backpedal does:
// an ordinary run is kept; '(' opens a group that runs to the next ')'
// (an unmatched '(' ends the match there); '&' is kept unless it starts
// a named-entity suffix at the very end; a punctuation run is kept only
// when more text follows it, so trailing punctuation and a trailing ')'
// that closes no group are dropped. The backpedal is applied until the
// result is stable: dropping an unmatched '(' can expose trailing
// punctuation that must then be dropped too. Returns the trimmed length.
function trimWww(m) {
  let end = m.length;
  for (;;) {
    const t = trimWwwOnce(m, end);
    if (t === end) return t;
    // Only an unmatched '(' can expose more to trim; a trailing
    // punctuation or entity suffix is already stable.
    if (m[t] !== '(') return t;
    end = t;
  }
}

function trimWwwOnce(m, n) {
  let i = 0;
  while (i < n) {
    const c = m[i];
    if (c === '(') {
      const close = m.indexOf(')', i + 1);
      if (close === -1 || close >= n) break;
      i = close + 1;
    } else if (c === '&') {
      let j = i + 1;
      while (j < n) {
        const d = m.charCodeAt(j);
        if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) j += 1;
        else break;
      }
      if (j > i + 1 && j === n - 1 && m[j] === ';') break;
      i += 1;
    } else if (BACKPEDAL_PUNCT.indexOf(c) !== -1) {
      let j = i;
      while (j < n && BACKPEDAL_PUNCT.indexOf(m[j]) !== -1) j += 1;
      if (j === n) break;
      i = j;
    } else {
      let j = i;
      while (j < n && BACKPEDAL_PUNCT.indexOf(m[j]) === -1 && m[j] !== '(' && m[j] !== '&') j += 1;
      i = j;
    }
  }
  return i;
}

// Find the earliest www/email/scheme autolink starting in text[from, to).
// The match may run past `to` (its path can hold specials). Returns
// {start, end, href, text} or null.
// Once an inline <a href=...> tag has been seen, marked stops creating
// bare (www/email/scheme) autolinks for the rest of the document.
// Explicit links and <...> autolinks are unaffected. Reset per parse().
let autolinkSuppressed = false;
// An opening <a> tag whose name is followed by a literal space (any
// attribute, a self-closing '/', or just a space before '>') suppresses
// bare autolinks for the rest of the document until an inline </a>.
// A bare <a>, <a/> (no space), or <a\t...>/<a\n...> does NOT suppress.
const A_HREF_RE = /^<a /i;

function findAutolink(text, from, to, endLimit) {
  if (autolinkSuppressed) return null;
  if (endLimit === undefined) endLimit = -1;
  // A match must not run past the next ']' when we are inside a link
  // label, or it would swallow the bracket that closes the link.
  const cap = (m) => {
    if (endLimit !== -1 && m.index + m[0].length > endLimit) {
      const len = endLimit - m.index;
      if (len <= 0) return null;
      return m[0].slice(0, len);
    }
    return m[0];
  };
  let best = null;
  const consider = (cand) => {
    if (!cand) return;
    if (!best || cand.start < best.start || (cand.start === best.start && cand.end > best.end)) best = cand;
  };
  // Cheap gates: each autolink regex only runs when its trigger text
  // occurs at all in the remaining input. indexOf is a native memchr;
  // the regexes (especially EMAIL_RE) are the single hottest cost in
  // the whole parser on long documents.
  if (text.indexOf('www.', from) !== -1) {
  WWW_RE.lastIndex = from;
  let m = WWW_RE.exec(text);
  while (m) {
    if (m.index >= to) break;
    const prev = m.index === 0 ? '' : text[m.index - 1];
    if (prev === '' || !isAlphaNum(prev)) {
      const raw0 = cap(m);
      if (raw0 === null) { WWW_RE.lastIndex = m.index + 1; m = WWW_RE.exec(text); continue; }
      const len = trimWww(raw0);
      if (len > 0) { consider({ start: m.index, end: m.index + len, href: 'http://' + raw0.slice(0, len), text: raw0.slice(0, len) }); break; }
    }
    WWW_RE.lastIndex = m.index + 1;
    m = WWW_RE.exec(text);
  }
  }
  if (text.indexOf('://', from) !== -1) {
  SCHEME_URL_RE.lastIndex = from;
  let m = SCHEME_URL_RE.exec(text);
  while (m) {
    if (m.index >= to) break;
    const raw0 = cap(m);
    if (raw0 === null) { SCHEME_URL_RE.lastIndex = m.index + 1; m = SCHEME_URL_RE.exec(text); continue; }
    const len = trimWww(raw0);
    if (len > 0) { consider({ start: m.index, end: m.index + len, href: raw0.slice(0, len), text: raw0.slice(0, len) }); break; }
    SCHEME_URL_RE.lastIndex = m.index + 1;
    m = SCHEME_URL_RE.exec(text);
  }
  }
  // xmpp: + email + optional path (e.g. xmpp:foo@bar.baz/txt).
  if (text.indexOf('xmpp:', from) !== -1) {
  const XMPP_RE = /xmpp:/g;
  XMPP_RE.lastIndex = from;
  let m = XMPP_RE.exec(text);
  while (m) {
    if (m.index >= to) break;
    const prev = m.index === 0 ? '' : text[m.index - 1];
    if (prev !== '' && isAlphaNum(prev)) { XMPP_RE.lastIndex = m.index + 1; m = XMPP_RE.exec(text); continue; }
    EMAIL_RE.lastIndex = m.index + 5;
    const em = EMAIL_RE.exec(text);
    if (em && em.index === m.index + 5) {
      const afterEmail = em.index + em[0].length;
      // A '-' or '_' right after the email kills the whole autolink.
      if (text[afterEmail] !== '-' && text[afterEmail] !== '_') {
        // The path after the email is a single segment ('/txt', not
        // '/txt/bin').
        let end = afterEmail;
        if (text[end] === '/') {
          end += 1;
          while (end < text.length && text[end] !== '/' && text[end] !== ']' && text[end] !== ' ' && text[end] !== '\t' && text[end] !== '\n' && text[end] !== '\r' && text[end] !== '<') end += 1;
        }
        if (endLimit !== -1 && end > endLimit) end = endLimit;
        const raw = text.slice(m.index, end);
        const len = trimWww(raw);
        if (len > 0) { consider({ start: m.index, end: m.index + len, href: raw.slice(0, len), text: raw.slice(0, len) }); break; }
      }
    }
    XMPP_RE.lastIndex = m.index + 1;
    m = XMPP_RE.exec(text);
  }
  }
  if (text.indexOf('@', from) !== -1) {
  EMAIL_RE.lastIndex = from;
  let m = EMAIL_RE.exec(text);
  while (m) {
    if (m.index >= to) break;
    // A '-' or '_' right after the email kills the whole autolink, with
    // two exceptions: the char is part of the domain (followed by a word
    // character), or a trailing '_' is the closer of an emphasis run that
    // opened before the email (e.g. __foo@bar.baz__).
    const afterEmail = m.index + m[0].length;
    if (text[afterEmail] === '-' || text[afterEmail] === '_') {
      let kill = true;
      if (text[afterEmail] === '_') {
        // Look for the nearest left-flanking '_' run before the email
        // that this trailing run could close (an opener). Skip runs that
        // cannot open (e.g. intraword '_').
        let k = m.index - 1;
        while (k >= 0 && text[k] !== '\n') {
          if (text[k] === '_') {
            let s = k;
            while (s > 0 && text[s - 1] === '_') s--;
            if (s === 0 || /[\s\p{P}]/u.test(text[s - 1])) { kill = false; break; }
            k = s - 1;
          } else k--;
        }
      }
      if (kill) { EMAIL_RE.lastIndex = m.index + 1; m = EMAIL_RE.exec(text); continue; }
    }
    // A 'mailto:' prefix is part of the link when it is not preceded by
    // an alphanumeric character.
    let start = m.index, disp = m[0];
    if (text.slice(Math.max(0, m.index - 7), m.index).toLowerCase() === 'mailto:') {
      const before = m.index - 7;
      if (before === 0 || !isAlphaNum(text[before - 1])) { start = before; disp = 'mailto:' + m[0]; }
    }
    consider({ start, end: m.index + m[0].length, href: 'mailto:' + m[0], text: disp });
    break;
  }
  }
  return best;
}

// ---------------------------------------------------------------- inline state
// Node kinds: 0 text, 1 code span, 2 delimiter, 3 link/image, 4 raw html,
// 5 hard break, 6 wrapper (em/strong/del), 7 verbatim entity.
// A parseInlineNodes result is { nodes, head, tail }; kids of a link node
// are such a result (its own node array), kids of a wrapper are indexes
// into the same array.
function mkNode(st, obj) {
  obj.nx = -1; obj.pv = -1; obj.nd = -1; obj.pd = -1;
  st.nodes.push(obj);
  return st.nodes.length - 1;
}
function appendNode(st, idx) {
  if (st.tail !== -1) { st.nodes[st.tail].nx = idx; st.nodes[idx].pv = st.tail; }
  else st.head = idx;
  st.tail = idx;
}
function appendDelim(st, idx) {
  if (st.delimTail !== -1) { st.nodes[st.delimTail].nd = idx; st.nodes[idx].pd = st.delimTail; }
  else st.delimHead = idx;
  st.delimTail = idx;
}
function unlinkDelim(st, idx) {
  const nd = st.nodes[idx];
  if (nd.pd !== -1) st.nodes[nd.pd].nd = nd.nd; else st.delimHead = nd.nd;
  if (nd.nd !== -1) st.nodes[nd.nd].pd = nd.pd; else st.delimTail = nd.pd;
  nd.nd = -1; nd.pd = -1;
}

// Flanking info for a delimiter run of length m starting at i.
function flanking(text, i, m) {
  const before = i > 0 ? text[i - 1] : undefined;
  const after = i + m < text.length ? text[i + m] : undefined;
  const bSpace = before === undefined || isWhitespace(before);
  const bPunct = before !== undefined && isPunct(before);
  const aSpace = after === undefined || isWhitespace(after);
  const aPunct = after !== undefined && isPunct(after);
  const left = !aSpace && (!aPunct || bSpace || bPunct);
  const right = !bSpace && (!bPunct || aSpace || aPunct);
  return [left, right, bPunct, aPunct];
}

function processEmphasis(st, text) {
  const nodes = st.nodes;
  // Is this closer run the lone `*` (or `_`) swallowed by the
  // reference's right-delimiter scan between two double runs of the
  // other character (`__...*...__`, `**..._...**`)? Its scan consumes
  // that span as plain text at the start, so the run never closes
  // this opener; a later run still can. Positions are raw-text
  // offsets; only intact runs (n === tot) are judged, since a run
  // already shortened by an inner match sits elsewhere in the text.
  function swallowedByDoubleRuns(oNode, cNode) {
    const other = cNode.ch === '*' ? '_' : '*';
    if (cNode.n !== 1 || cNode.n !== cNode.tot) return false;
    if (oNode.n !== oNode.tot) return false;
    let i = oNode.pos + oNode.tot;
    while (i < text.length && text[i] !== '*' && text[i] !== '_') i += 1;
    if (i + 1 >= text.length || text[i] !== other || text[i + 1] !== other) return false;
    let j = i + 2;
    while (j < text.length && text[j] !== '*' && text[j] !== '_') j += 1;
    if (j !== cNode.pos || text[j] !== cNode.ch) return false;
    if (j + 1 < text.length && text[j + 1] === cNode.ch) return false;
    let k = j + 1;
    while (k < text.length && text[k] !== '*' && text[k] !== '_') k += 1;
    if (k + 1 >= text.length || text[k] !== other || text[k + 1] !== other) return false;
    return true;
  }
  // Is this delimiter node still linked into the delimiter chain?
  function inDelimChain(idx) {
    return nodes[idx].pd !== -1 || nodes[idx].nd !== -1 || st.delimHead === idx;
  }
  let cur = st.delimHead;
  while (cur !== -1) {
    const cNode = nodes[cur];
    if (cNode.close) {
      let o = cNode.pd;
      let found = -1;
      while (o !== -1) {
        const oNode = nodes[o];
        if (oNode.ch === cNode.ch && oNode.open) {
          if (cNode.ch === '~') {
            if (oNode.n === cNode.n) { found = o; break; }
          } else {
            const odd = (oNode.open && oNode.close) || (cNode.open && cNode.close);
            // The odd-match rule uses the TOTAL run lengths (the
            // reference's emStrong walks back over the run, so a
            // leftover run still counts its already-consumed part),
            // not the remaining counts. It does not apply when both
            // runs are multiples of 3.
            const bothMult3 = oNode.tot % 3 === 0 && cNode.tot % 3 === 0;
            if (odd && (oNode.tot + cNode.tot) % 3 === 0 && !bothMult3) { o = oNode.pd; continue; }
            // A lone closer swallowed between two double runs of the
            // other character never closes this opener. Record the
            // opener on the swallowed run: a later closer that
            // completes it redirects here instead of matching the
            // swallowed run as an opener (the reference's scan
            // already consumed that run as plain text).
            if (swallowedByDoubleRuns(oNode, cNode)) {
              if (cNode.spentFor === -1) cNode.spentFor = o;
              o = oNode.pd; continue;
            }
            // This opener was itself swallowed as a partial closer by
            // an earlier opener X: if the current closer completes
            // X's coverage, X is the match, not this opener.
            if (oNode.spentFor !== -1) {
              const x = oNode.spentFor;
              const xNode = nodes[x];
              if (xNode && xNode.open && xNode.n > 0 && inDelimChain(x) && (xNode.cov || 0) + cNode.n >= xNode.n) { o = x; continue; }
            }
            // The reference's scan adds closer runs up until the
            // opener is covered: a closer that can also open, shorter
            // than the opener's remaining need, is swallowed into
            // the opener's coverage instead of matching — but only
            // when no later closer could still cover the opener.
            // When a later closer can cover it, the direct match
            // below stands: the inner emphasis forms first and the
            // outer one wraps it, which is how the reference's
            // recursive re-lexing of the span turns out. A close-only
            // closer is never swallowed: the reference retries the
            // opener from its next character, which the direct match
            // below reproduces (its leftover opener chars stay
            // literal).
            const need = oNode.n - (oNode.cov || 0);
            if (cNode.n < need && cNode.open) {
              let later = 0;
              let d = cNode.nd;
              while (d !== -1) {
                const dn = nodes[d];
                if (dn.ch === cNode.ch && dn.close) later += dn.n;
                d = dn.nd;
              }
              if ((oNode.cov || 0) + cNode.n + later < oNode.n) {
                oNode.cov = (oNode.cov || 0) + cNode.n;
                cNode.spentFor = o;
                break;
              }
            }
            // A single closer cannot match across an already-formed
            // emphasis wrapper when the opener is a multi run.
            // A wrapper whose closer run IS this very closer node
            // (its leftover sits right after the wrapper) does not
            // block: the outer match closes the same run's tail.
            if (cNode.n === 1 && oNode.n >= 2) {
              let hasWrap = false;
              let q = oNode.nx;
              while (q !== -1 && q !== cur) {
                if (nodes[q].k === 6 && nodes[q].nx !== cur) { hasWrap = true; break; }
                q = nodes[q].nx;
              }
              if (hasWrap) { o = oNode.pd; continue; }
            }
            found = o; break;
          }
        }
        o = oNode.pd;
      }
      if (found !== -1) {
        const oNode = nodes[found];
        const use = cNode.ch === '~' ? cNode.n : (oNode.n >= 2 && cNode.n >= 2 ? 2 : 1);
        const tag = cNode.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
        const kidsHead = oNode.nx;
        const kidsTail = cNode.pv;
        // An outer emphasis is blocked when it contains an inner
        // emphasis of the OPPOSITE type (em inside strong, or strong
        // inside em) whose closer was attached (could both open and
        // close) and whose opener was open-only — but only when the
        // outer closer run has length <= 2. With a longer closer
        // (*** or ****) the outer emphasis forms and the leftover
        // lands inside it (see the leftover placement below).
        // The block lifts when EVERY such inner emphasis is
        // separated from the outer closer: either the text right
        // after it starts with whitespace, or a close-only
        // delimiter sits between it and the outer closer. A space
        // further along does not count (**a *b*c d** stays blocked),
        // and a delimiter that can both open and close does not
        // count either (**a *b*c*d** stays blocked).
        if (cNode.ch !== '~' && cNode.n <= 2) {
          let blocked = false;
          let q = kidsHead;
          while (q !== -1) {
            const qn = nodes[q];
            if (qn.k === 6 && qn.ch === cNode.ch && qn.closeN !== use && qn.closeBoth && qn.openOnly && qn.openIdx !== found) {
              let separated = false;
              const afterInner = qn.nx;
              // The outer closer is the leftover of this very
              // wrapper's closer run (the same delimiter node, its
              // count decremented when the wrapper formed): the two
              // closers share one run, so the inner wrapper cannot
              // block the outer emphasis.
              if (afterInner === cur) separated = true;
              if (afterInner !== -1 && !separated) {
                const an = nodes[afterInner];
                if (an.k === 0 && an.s.length > 0 && isWhitespace(an.s[0])) separated = true;
              }
              if (!separated) {
                let r = afterInner;
                while (r !== -1 && r !== cur) {
                  const rn = nodes[r];
                  if (rn.k === 2 && rn.close && !rn.open) { separated = true; break; }
                  // A wrapper whose closer was close-only counts the
                  // same way: its closer run was close-only even
                  // though it has since been consumed into the wrapper
                  // (closeBoth false means the closer could close but
                  // not open, since it did close this wrapper).
                  if (rn.k === 6 && rn.ch === cNode.ch && !rn.closeBoth) { separated = true; break; }
                  r = rn.nx;
                }
              }
              if (!separated) { blocked = true; break; }
            }
            if (q === kidsTail) break;
            q = qn.nx;
          }
          if (blocked) {
            // The opener is dead too: no later closer may use it.
            unlinkDelim(st, found);
            cur = cNode.nd;
            continue;
          }
        }
        // Remove delimiter runs strictly inside the wrapped region.
        let d = oNode.nd;
        while (d !== -1 && d !== cur) {
          const nx = nodes[d].nd;
          unlinkDelim(st, d);
          d = nx;
        }
        const before = oNode.pv;
        const after = cNode.nx;
        oNode.n -= use;
        cNode.n -= use;
        const w = mkNode(st, { k: 6, tag, kidsHead, kidsTail, ch: cNode.ch, closeN: use, closeBoth: cNode.open && cNode.close, openOnly: oNode.open && !oNode.close, openIdx: found });
        if (oNode.n > 0) {
          if (before !== -1) nodes[before].nx = found; else st.head = found;
          nodes[found].pv = before;
          nodes[found].nx = w;
          nodes[w].pv = found;
        } else {
          if (before !== -1) nodes[before].nx = w; else st.head = w;
          nodes[w].pv = before;
          unlinkDelim(st, found);
        }
        if (cNode.n > 0) {
          // A leftover closer normally renders after the wrapper
          // (**a*** -> <strong>a</strong>*). But when the wrapper
          // contains an inner emphasis whose closer was attached and
          // whose opener was open-only (the blocking-condition shape),
          // marked renders the leftover INSIDE the wrapper, as its
          // last child (**a *b*c*** -> <strong>a <em>b</em>c*</strong>).
          // The leftover then becomes plain text: unlink it from the
          // delimiter chain so it is not re-processed.
          let innerAttached = false;
          if (cNode.ch !== '~') {
            let q = kidsHead;
            while (q !== -1) {
              const qn = nodes[q];
              // Only when the inner wrapper opened from a DIFFERENT
              // delimiter run than this wrapper's opener: when the
              // inner wrapper shares this wrapper's opener run
              // (***foo*bar***), the leftover closer stays outside
              // and can open a later emphasis (*baz*).
              if (qn.k === 6 && qn.ch === cNode.ch && qn.closeN !== use && qn.closeBoth && qn.openOnly && qn.openIdx !== found) { innerAttached = true; break; }
              if (q === kidsTail) break;
              q = qn.nx;
            }
          }
          if (innerAttached) {
            // Move the leftover delimiter node inside as the last kid.
            nodes[kidsTail].nx = cur;
            nodes[cur].pv = kidsTail;
            nodes[cur].nx = -1;
            nodes[w].kidsTail = cur;
            nodes[w].nx = after;
            if (after !== -1) nodes[after].pv = w; else st.tail = w;
            const nextDelim = cNode.nd;
            unlinkDelim(st, cur);
            cur = nextDelim;
          } else {
            nodes[w].nx = cur;
            nodes[cur].pv = w;
            nodes[cur].nx = after;
            if (after !== -1) nodes[after].pv = cur; else st.tail = cur;
            // Non-exhausted closer: re-process it against an earlier opener.
          }
        } else {
          const nextDelim = cNode.nd;
          nodes[w].nx = after;
          if (after !== -1) nodes[after].pv = w; else st.tail = w;
          unlinkDelim(st, cur);
          cur = nextDelim;
        }
        continue;
      }
    }
    cur = cNode.nd;
  }
}

// Find the ')' matching the '(' at s[pos], the way the reference's
// blockSkip link destination does: escapes and non-paren characters,
// plus one level of nested '(...)'. Returns the index just past the
// matching ')' or -1.
function scanBalancedParen(s, pos) {
  const n = s.length;
  let depth = 1;
  let j = pos + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 40) {
      depth += 1;
      if (depth > 2) return -1;
    } else if (c === 41) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return -1;
}

// Label end in the Ot-masked text, mirroring the reference's
// blockSkip link label `(?:[^\[\]`]|code-span)*?` exactly: the label
// may hold ordinary characters (a backslash is ordinary, so '\]'
// still closes it) or code spans, but no nested '[' — a '[' inside
// the label makes the whole link alternative fail, so the label is
// not masked and emphasis inside it can still form. A backtick run
// must pair with an equal-length run inside the label (the code-span
// alternative requires the closing run to match the opening run's
// length), and the pair search runs over any non-backtick
// characters, so a ']' inside a code span's content does not end
// the label. Returns the index just past the closing ']' or -1.
function scanLabelEndMasked(s, start) {
  const n = s.length;
  let j = start + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 96) {
      let run = 1;
      while (j + run < n && s.charCodeAt(j + run) === 96) run += 1;
      let k = j + run;
      while (k < n && s.charCodeAt(k) !== 96) k += 1;
      if (k >= n) return -1;
      let run2 = 1;
      while (k + run2 < n && s.charCodeAt(k + run2) === 96) run2 += 1;
      if (run2 !== run) return -1;
      j = k + run2;
      continue;
    }
    if (c === 91) return -1;
    if (c === 93) return j + 1;
    j += 1;
  }
  return -1;
}

// Ranges of a paragraph's text where emphasis/strikethrough delimiters
// cannot form, computed the way the reference masks its source for
// the closer search. Stage 1: a backtick run pairs with the next run
// of its length (the content between them may hold other runs), and
// the runs strictly inside a pair are hidden. Stage 2: in what is
// left, adjacent same-length runs pair up, and the text between each
// pair is masked — a dangling run inside a link label pairs with the
// next run of its length outside the label, hiding '_' between them.
// Stage 3 (blockSkip link): a '[label](...)' region in the masked
// text (the destination allows spaces and one level of nested parens,
// unlike a real link) has its label interior masked, so delimiters
// inside a would-be label cannot form emphasis when the link itself
// does not form. A label is consumable only when its backtick runs
// pair up inside the label (equal lengths) or sit directly before
// ']' in a run of two or more.
// Returns a sorted array of [start, end] pairs, or null.
function computeMaskRanges(text) {
  const runs = [];
  let p = text.indexOf('`');
  while (p !== -1) {
    let q = p + 1;
    while (text[q] === '`') q += 1;
    // A backtick preceded by an odd run of backslashes is escaped.
    // A lone escaped backtick can still close a code-span-like pair
    // opened earlier, but it can never open one; the rest of an
    // escaped run, if any, still counts as a run, one shorter.
    let s = p;
    let bs = 0;
    while (s - 1 - bs >= 0 && text[s - 1 - bs] === '\\') bs += 1;
    if (bs % 2 === 1) {
      if (q - p === 1) runs.push([p, q, 1, true]);
      else runs.push([p + 1, q, q - p - 1, false]);
    } else {
      runs.push([p, q, q - p, false]);
    }
    p = text.indexOf('`', q);
  }
  const hidden = new Uint8Array(runs.length);
  const pend = new Map();
  for (let k = 0; k < runs.length; k += 1) {
    const len = runs[k][2];
    const prev = pend.get(len);
    if (prev !== undefined) {
      for (let j = prev + 1; j < k; j += 1) {
        hidden[j] = 1;
        if (pend.get(runs[j][2]) === j) pend.delete(runs[j][2]);
      }
      pend.delete(len);
    } else if (runs[k][3]) {
      // An escaped run that pairs with nothing is consumed as an
      // escape and is gone from the masked text.
      hidden[k] = 1;
    } else {
      pend.set(len, k);
    }
  }
  const ranges = [];
  let last = -1;
  for (let k = 0; k < runs.length; k += 1) {
    if (hidden[k]) continue;
    if (last !== -1 && runs[k][2] === runs[last][2]) {
      ranges.push([runs[last][1], runs[k][0]]);
      last = -1;
    } else {
      last = k;
    }
  }
  // Stage 3 needs the Ot-masked text (hidden runs become '+',
  // length-preserving, so positions line up with the original).
  // Only build it when a '[' could start a link region.
  if (text.indexOf('[') !== -1) {
    let src = text;
    let hasHidden = false;
    for (let k = 0; k < runs.length; k += 1) {
      if (hidden[k]) { hasHidden = true; break; }
    }
    if (hasHidden) {
      const chars = text.split('');
      for (let k = 0; k < runs.length; k += 1) {
        if (hidden[k]) {
          for (let j = runs[k][0]; j < runs[k][1]; j += 1) chars[j] = '+';
        }
      }
      src = chars.join('');
    }
    const n = src.length;
    let bi = src.indexOf('[', 0);
    while (bi !== -1) {
      // Skip a '[' that sits inside an already-masked code region.
      let inside = false;
      for (let r = 0; r < ranges.length; r += 1) {
        if (ranges[r][0] <= bi && bi < ranges[r][1]) { inside = true; break; }
      }
      if (!inside) {
        const close = scanLabelEndMasked(src, bi);
        if (close !== -1 && close < n && src[close] === '(' && scanBalancedParen(src, close) !== -1) {
          ranges.push([bi + 1, close - 1]);
        }
      }
      bi = src.indexOf('[', bi + 1);
    }
  }
  if (ranges.length === 0) return null;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const top = merged[merged.length - 1];
    if (ranges[i][0] <= top[1]) {
      if (ranges[i][1] > top[1]) top[1] = ranges[i][1];
    } else {
      merged.push(ranges[i]);
    }
  }
  return merged;
}

// Strip a fenced code block's content indent the way the reference's
// indentCodeCompensation does: remove up to the opener's leading
// whitespace length in CHARACTERS from each content line (a tab
// counts as one character and is removed whole when the cap covers
// it). This applies only to backtick fences; a tilde fence keeps its
// content untouched.
function stripFenceIndent(line, cap) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t') && i < cap) i += 1;
  return line.slice(i);
}

function parseInlineNodes(text, refs, inLink) {
  const st = { nodes: [], head: -1, tail: -1, delimHead: -1, delimTail: -1 };
  const brackets = [];
  let buf = '';
  const n = text.length;
  // Delimiters whose position falls in a masked range are literal
  // text. Positions are visited in increasing order, so one pointer
  // into the sorted ranges is enough.
  const maskRanges = computeMaskRanges(text);
  let maskIdx = 0;
  function posMasked(pos) {
    if (!maskRanges) return false;
    while (maskIdx < maskRanges.length && maskRanges[maskIdx][1] <= pos) maskIdx += 1;
    return maskIdx < maskRanges.length && maskRanges[maskIdx][0] <= pos;
  }

  function flush() {
    if (buf !== '') { appendNode(st, mkNode(st, { k: 0, s: buf })); buf = ''; }
  }
  // Try to close the topmost bracket with the ']' at index i.
  // Returns the index just past the link suffix, or -1.
  function tryCloseBracket(i) {
    if (brackets.length === 0) return -1;
    const top = brackets.pop();
    const labelText = text.slice(top.pos + 1, i);
    if (labelText.length > 999 || !validLabelText(labelText)) return -1;
    if (!top.img) {
      let p = st.nodes[top.bracketIdx].nx;
      while (p !== -1) {
        // An autolink inside the label does not block the outer link.
        if (st.nodes[p].k === 3 && !st.nodes[p].img && !st.nodes[p].auto) return -1;
        p = st.nodes[p].nx;
      }
    }
    let href = null, title = null, end = -1;
    const after = i + 1;
    if (text[after] === '(') {
      const res = parseInlineLink(text, after);
      if (res) { href = res.href; title = res.title; end = res.end; }
      else {
        // A failed inline link falls back to a shortcut reference.
        if (hasUnescapedBracket(labelText)) return -1;
        const ref2 = refs.get(normalizeLabel(labelText));
        if (!ref2) return -1;
        href = ref2.dest; title = ref2.title; end = i + 1;
      }
    } else if (text[after] === '[') {
      const l2end = scanLabelEnd(text, after);
      if (l2end !== -1) {
        const l2 = text.slice(after + 1, l2end - 1);
        const key2 = normalizeLabel(l2 === '' ? labelText : l2);
        if (key2 === '' || hasUnescapedBracket(l2 === '' ? labelText : l2)) return -1;
        const ref = refs.get(key2);
        if (!ref) return -1;
        href = ref.dest; title = ref.title; end = l2end;
      } else {
        const key3 = normalizeLabel(labelText);
        if (key3 === '' || hasUnescapedBracket(labelText)) return -1;
        const ref = refs.get(key3);
        if (!ref) return -1;
        href = ref.dest; title = ref.title; end = i + 1;
      }
    } else {
      const key4 = normalizeLabel(labelText);
      if (key4 === '' || hasUnescapedBracket(labelText)) return -1;
      const ref = refs.get(key4);
      if (!ref) return -1;
      href = ref.dest; title = ref.title; end = i + 1;
    }
    const kids = parseInlineNodes(labelText, refs, !top.img);
    st.tail = top.tailBefore;
    if (st.tail !== -1) st.nodes[st.tail].nx = -1; else st.head = -1;
    st.delimTail = top.delimBefore;
    if (st.delimTail !== -1) st.nodes[st.delimTail].nd = -1; else st.delimHead = -1;
    appendNode(st, mkNode(st, { k: 3, href, title, img: top.img, kids }));
    // A real (non-image) link inside an outer label blocks that outer
    // link; record it on every still-open bracket so the autolink cap
    // check is O(1).
    if (!top.img) for (const b of brackets) b.hasLink = true;
    return end;
  }

  // Would the topmost open bracket close into a link at its ']'?
  // Mirrors tryCloseBracket's decision without mutating anything, so
  // the autolink and code-span caps only apply when the bracket really
  // will become a link: when it cannot, a bare autolink or a code span
  // may run straight past its ']' the way the reference does.
  function bracketCanForm(top) {
    const labelEnd = top.labelEnd !== undefined ? top.labelEnd : (top.labelEnd = scanLabelEnd(text, top.pos));
    if (labelEnd === -1) return false;
    const labelText = text.slice(top.pos + 1, labelEnd - 1);
    if (labelText.length > 999 || !validLabelText(labelText)) return false;
    if (!top.img) {
      let p = st.nodes[top.bracketIdx].nx;
      while (p !== -1) {
        if (st.nodes[p].k === 3 && !st.nodes[p].img && !st.nodes[p].auto) return false;
        p = st.nodes[p].nx;
      }
    }
    const after = labelEnd;
    if (text[after] === '(') {
      if (parseInlineLink(text, after)) return true;
      if (hasUnescapedBracket(labelText)) return false;
      return !!refs.get(normalizeLabel(labelText));
    }
    if (text[after] === '[') {
      const l2end = scanLabelEnd(text, after);
      if (l2end !== -1) {
        const l2 = text.slice(after + 1, l2end - 1);
        const key2 = normalizeLabel(l2 === '' ? labelText : l2);
        if (key2 === '' || hasUnescapedBracket(l2 === '' ? labelText : l2)) return false;
        return !!refs.get(key2);
      }
      const key3 = normalizeLabel(labelText);
      if (key3 === '' || hasUnescapedBracket(labelText)) return false;
      return !!refs.get(key3);
    }
    const key4 = normalizeLabel(labelText);
    if (key4 === '' || hasUnescapedBracket(labelText)) return false;
    return !!refs.get(key4);
  }

  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 < n && text[i + 1] === '\n') {
        flush();
        appendNode(st, mkNode(st, { k: 5 }));
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
      } else if (i + 1 < n && isAsciiPunct(text[i + 1])) {
        buf += text[i + 1];
        i += 2;
      } else {
        buf += '\\';
        i += 1;
      }
    } else if (c === '`') {
      let m = 1;
      while (i + m < n && text[i + m] === '`') m += 1;
      // A code span opener inside a bracket may only pair with a closer
      // before that bracket's ']' when the bracket will actually close
      // into a link; otherwise the span may run past the ']' and the
      // bracket stays open. The label end is computed once per bracket
      // and cached on it.
      let searchEnd = n;
      if (brackets.length > 0) {
        const top = brackets[brackets.length - 1];
        if (top.labelEnd === undefined) top.labelEnd = scanLabelEnd(text, top.pos);
        if (top.labelEnd !== -1 && bracketCanForm(top)) searchEnd = top.labelEnd;
      }
      let j = i + m;
      let found = -1;
      while (j < searchEnd) {
        if (text[j] === '`') {
          let r = 1;
          while (j + r < n && text[j + r] === '`') r += 1;
          if (r === m) { found = j; break; }
          j += r;
        } else j += 1;
      }
      if (found !== -1) {
        let content = text.slice(i + m, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flush();
        appendNode(st, mkNode(st, { k: 1, s: content }));
        i = found + m;
      } else {
        buf += '`'.repeat(m);
        i += m;
      }
    } else if (c === '*' || c === '_') {
      let m = 1;
      while (i + m < n && text[i + m] === c) m += 1;
      const [left, right, bPunct, aPunct] = flanking(text, i, m);
      let open, close;
      if (c === '*') { open = left; close = right; }
      else { open = left && (!right || bPunct); close = right && (!left || aPunct); }
      if ((open || close) && !posMasked(i)) {
        flush();
        const dIdx = mkNode(st, { k: 2, ch: c, n: m, tot: m, open, close, masked: false, pos: i, cov: 0, spentFor: -1 });
        appendNode(st, dIdx);
        appendDelim(st, dIdx);
      } else buf += c.repeat(m);
      i += m;
    } else if (c === '~') {
      let m = 1;
      while (i + m < n && text[i + m] === '~') m += 1;
      if (m <= 2) {
        const [left, right] = flanking(text, i, m);
        if ((left || right) && !posMasked(i)) {
          flush();
          const dIdx = mkNode(st, { k: 2, ch: '~', n: m, tot: m, open: left, close: right, masked: false, pos: i });
          appendNode(st, dIdx);
          appendDelim(st, dIdx);
          i += m;
          continue;
        }
      }
      buf += '~'.repeat(m);
      i += m;
    } else if (c === '[') {
      if (inLink) { buf += '['; i += 1; continue; }
      flush();
      const tailBefore = st.tail;
      const delimBefore = st.delimTail;
      const bIdx = mkNode(st, { k: 0, s: '[' });
      appendNode(st, bIdx);
      brackets.push({ pos: i, img: false, bracketIdx: bIdx, tailBefore, delimBefore, hasLink: false });
      i += 1;
    } else if (c === '!') {
      if (i + 1 < n && text[i + 1] === '[') {
        flush();
        const tailBefore = st.tail;
        const delimBefore = st.delimTail;
        const eIdx = mkNode(st, { k: 0, s: '!' });
        appendNode(st, eIdx);
        const bIdx = mkNode(st, { k: 0, s: '[' });
        appendNode(st, bIdx);
        brackets.push({ pos: i + 1, img: true, bracketIdx: bIdx, tailBefore, delimBefore, hasLink: false });
        i += 2;
      } else { buf += '!'; i += 1; }
    } else if (c === ']') {
      flush();
      const end = tryCloseBracket(i);
      if (end !== -1) { i = end; continue; }
      buf += ']';
      i += 1;
    } else if (c === '<') {
      const gt = text.indexOf('>', i + 1);
      let done = false;
      if (gt !== -1) {
        const inner = text.slice(i + 1, gt);
        if (inner.length > 0 && inner.indexOf(' ') === -1 && inner.indexOf('\n') === -1 && inner.indexOf('<') === -1) {
          let ctrl = false;
          for (let k = 0; k < inner.length; k++) {
            const cc = inner.charCodeAt(k);
            if (cc < 32 || cc === 127) { ctrl = true; break; }
          }
          if (!ctrl && SCHEME_RE.test(inner)) {
            flush();
            const tIdx = mkNode(st, { k: 0, s: inner });
            appendNode(st, mkNode(st, { k: 3, href: inner, title: null, img: false, auto: true, kids: { nodes: st.nodes, head: tIdx, tail: tIdx } }));
            i = gt + 1; done = true;
          } else if (!ctrl && EMAIL_FULL_RE.test(inner)) {
            flush();
            const tIdx = mkNode(st, { k: 0, s: inner });
            appendNode(st, mkNode(st, { k: 3, href: 'mailto:' + inner, title: null, img: false, auto: true, kids: { nodes: st.nodes, head: tIdx, tail: tIdx } }));
            i = gt + 1; done = true;
          }
        }
      }
      if (!done) {
        const tagEnd = parseHtmlTag(text, i);
        if (tagEnd !== -1) {
          flush();
          const tagText = text.slice(i, tagEnd);
          if (A_HREF_RE.test(tagText)) autolinkSuppressed = true;
          else if (/^<\/a\s*>$/i.test(tagText)) autolinkSuppressed = false;
          appendNode(st, mkNode(st, { k: 4, s: tagText }));
          i = tagEnd;
        } else { buf += '<'; i += 1; }
      }
    } else if (c === '&') {
      const ent = parseEntity(text, i);
      if (ent) {
        if (ent[0] === 0) buf += ent[1];
        else { flush(); appendNode(st, mkNode(st, { k: 7, s: ent[1] })); }
        i += ent[2];
      } else { buf += '&'; i += 1; }
    } else if (c === '\n') {
      let spaces = 0;
      let k = buf.length - 1;
      while (k >= 0 && buf[k] === ' ') { spaces += 1; k -= 1; }
      if (spaces >= 2) {
        buf = buf.slice(0, buf.length - spaces);
        flush();
        appendNode(st, mkNode(st, { k: 5 }));
        i += 1;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i += 1;
      } else {
        buf += '\n';
        i += 1;
      }
    } else {
      SPECIAL_RE.lastIndex = i;
      const m = SPECIAL_RE.exec(text);
      const end = m ? m.index : n;
      // A bare autolink must not swallow the ']' that closes the bracket
      // it sits in — but only when that bracket can actually form a link.
      // When the bracket cannot close into a link (bad label, a link
      // already inside it, no matching reference, a broken suffix),
      // the autolink runs straight past the ']' as the reference does.
      let endLimit = -1;
      if (brackets.length > 0) {
        const top = brackets[brackets.length - 1];
        const labelEnd = top.labelEnd !== undefined ? top.labelEnd : (top.labelEnd = scanLabelEnd(text, top.pos));
        if (labelEnd !== -1 && labelEnd - 1 >= i && bracketCanForm(top)) endLimit = labelEnd - 1;
      }
      const link = inLink ? null : findAutolink(text, i, end, endLimit);
      if (link) {
        if (link.start > i) buf += text.slice(i, link.start);
        flush();
        const tIdx = mkNode(st, { k: 0, s: link.text });
        appendNode(st, mkNode(st, { k: 3, href: link.href, title: null, img: false, auto: true, kids: { nodes: st.nodes, head: tIdx, tail: tIdx } }));
        i = link.end;
      } else {
        buf += text.slice(i, end);
        i = end;
      }
    }
  }
  flush();
  processEmphasis(st, text);
  return st;
}

// ---------------------------------------------------------------- rendering
function renderInlineList(nodes, head, tail) {
  let out = '';
  let p = head;
  while (p !== -1) {
    const nd = nodes[p];
    switch (nd.k) {
      case 0: out += escText(nd.s); break;
      case 7: out += nd.s; break;
      case 1: out += '<code>' + escCode(nd.s) + '</code>'; break;
      case 2: out += nd.ch.repeat(nd.n); break;
      case 4: out += nd.s; break;
      case 5: out += '<br>'; break;
      case 6: out += '<' + nd.tag + '>' + renderInlineList(nodes, nd.kidsHead, nd.kidsTail) + '</' + nd.tag + '>'; break;
      case 3: {
        if (nd.img) {
          const src = cleanUrl(nd.href);
          if (src === null) { out += renderInlineList(nd.kids.nodes, nd.kids.head, nd.kids.tail); break; }
          const alt = escAttr(plainText(nd.kids));
          out += '<img src="' + escAttr(src) + '" alt="' + alt + '"';
          if (nd.title != null) out += ' title="' + escAttr(nd.title) + '"';
          out += '>';
        } else {
          const href = cleanUrl(nd.href);
          if (href === null) { out += renderInlineList(nd.kids.nodes, nd.kids.head, nd.kids.tail); break; }
          out += '<a href="' + (nd.auto ? escAttrAll(href) : escAttr(href)) + '"';
          if (nd.title != null) out += ' title="' + escAttr(nd.title) + '"';
          out += '>' + renderInlineList(nd.kids.nodes, nd.kids.head, nd.kids.tail) + '</a>';
        }
        break;
      }
    }
    if (p === tail) break;
    p = nd.nx;
  }
  return out;
}

function plainText(kids) {
  const nodes = kids.nodes;
  let out = '';
  let p = kids.head;
  while (p !== -1) {
    const nd = nodes[p];
    switch (nd.k) {
      case 0: case 7: case 1: out += nd.s; break;
      case 2: out += nd.ch.repeat(nd.n); break;
      case 4: out += escText(nd.s); break;
      case 5: out += '\n'; break;
      case 6: out += plainText({ nodes, head: nd.kidsHead, tail: nd.kidsTail }); break;
      case 3: out += plainText(nd.kids); break;
    }
    if (p === kids.tail) break;
    p = nd.nx;
  }
  return out;
}

const PLAIN_SPECIAL_RE = /[\\`*_[\]!<>~&\n]/;
function parseInline(text, refs) {
  if (text === '') return '';
  // Fast path: no inline constructs at all, and no autolink trigger
  // (www. / :// / @) anywhere in the text. Only " and ' need escaping
  // (there is no <, >, or & by construction, and no \n to break on).
  if (!PLAIN_SPECIAL_RE.test(text) && text.indexOf('@') === -1 && text.indexOf('www.') === -1 && text.indexOf('://') === -1) {
    if (text.indexOf('"') === -1 && text.indexOf("'") === -1) return text;
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const st = parseInlineNodes(text, refs, false);
  return renderInlineList(st.nodes, st.head, st.tail);
}

// Remove the first `n` columns of a list item's first line (indent +
// marker + following whitespace), expanding tabs by original position.
function stripFirstCols(s, n) {
  let col = 0, i = 0;
  let out = '';
  while (i < s.length && s[i] === ' ') { out += ' '; col += 1; i += 1; }
  while (i < s.length && s[i] !== ' ' && s[i] !== '\t') { out += s[i]; col += 1; i += 1; }
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col += 1; i += 1; }
    else { const m = 4 - (col % 4); out += ' '.repeat(m); col += m; i += 1; }
  }
  return out.slice(n) + s.slice(i);
}

// ---------------------------------------------------------------- block helpers
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HR_RE = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const HTML_TYPE1_RE = /^ {0,3}<(script|pre|style|textarea)([\s>]|$)/i;
const HTML_TYPE6_RE = /^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)([\s>\/]|$)/i;
const HTML_TYPE7_RE = /^ {0,3}(?:<\/[A-Za-z][A-Za-z0-9-]*[ \t]*|<[A-Za-z][A-Za-z0-9-]*([ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*([ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?)>[ \t]*$/;
const TYPE1_TAGS = new Set(['script', 'pre', 'style', 'textarea']);
const TYPE6_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));

// Does this line start an HTML block that interrupts a paragraph?
// Types 1-6 always interrupt; type 7 (complete tag alone) interrupts
// only for a type-6 tag name, or an opening type-1 tag.
function htmlInterrupts(s) {
  if (HTML_TYPE1_RE.test(s)) return true;
  if (/^ {0,3}<!--/.test(s)) return true;
  if (/^ {0,3}<\?/.test(s)) return true;
  if (/^ {0,3}<!\[CDATA\[/.test(s)) return true;
  if (/^ {0,3}<![A-Za-z]/.test(s)) return true;
  if (HTML_TYPE6_RE.test(s)) return true;
  const m = /^ {0,3}<(\/?)([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m && HTML_TYPE7_RE.test(s)) {
    const name = m[2].toLowerCase();
    if (TYPE6_TAGS.has(name)) return true;
    if (m[1] !== '/' && TYPE1_TAGS.has(name)) return true;
  }
  return false;
}

function setextLevelOf(s) {
  const m = SETEXT_RE.exec(s);
  if (!m) return 0;
  return m[1][0] === '=' ? 1 : 2;
}

function fenceInfo(s) {
  const m = FENCE_RE.exec(s);
  if (!m) return null;
  const fence = m[1];
  const info = m[2].trim();
  if (fence[0] === '`' && info.indexOf('`') !== -1) return null;
  return { ch: fence[0], len: fence.length, info };
}

// Index just past the closing fence, or lines.length when unterminated.
function fenceEnd(lines, i, ch, len) {
  const re = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}[ \\t]*$');
  let j = i + 1;
  while (j < lines.length) {
    if (re.test(lines[j].s)) return j + 1;
    j += 1;
  }
  return lines.length;
}

// End index (exclusive) of the HTML block starting at lines[i], or -1.
// Returns { end, kind }: kind 1 blocks end at a terminator line (script /
// pre / style / textarea close, comment close, processing instruction,
// CDATA, declaration) and their text keeps one trailing newline unless
// the next line is exactly empty; kind 6 blocks run to a blank line and
// their text never keeps a trailing newline mid-document.
function htmlBlockEnd(lines, i) {
  const s = lines[i].s;
  const total = lines.length;
  const scanTo = (pred) => {
    for (let j = i; j < total; j++) if (pred(lines[j].s)) return j + 1;
    return total;
  };
  let m = HTML_TYPE1_RE.exec(s);
  if (m) {
    const re = new RegExp('<\\/' + m[1].toLowerCase() + '>', 'i');
    return { end: scanTo((t) => re.test(t)), kind: 1 };
  }
  if (/^ {0,3}<!--/.test(s)) return { end: scanTo((t) => t.indexOf('-->') !== -1), kind: 1 };
  if (/^ {0,3}<\?/.test(s)) return { end: scanTo((t) => t.indexOf('?>') !== -1), kind: 1 };
  if (/^ {0,3}<!\[CDATA\[/.test(s)) return { end: scanTo((t) => t.indexOf(']]>') !== -1), kind: 1 };
  if (/^ {0,3}<![A-Za-z]/.test(s)) return { end: scanTo((t) => t.indexOf('>') !== -1), kind: 1 };
  if (HTML_TYPE6_RE.test(s) || HTML_TYPE7_RE.test(s)) {
    let j = i;
    while (j < total) {
      if (lines[j].s.trim() === '') return { end: j, kind: 6 };
      j += 1;
    }
    return { end: total, kind: 6 };
  }
  return -1;
}

function isBlockquoteStart(s) {
  return /^ {0,3}>/.test(s);
}

// Does this line start a block that interrupts a paragraph?
function isInterrupt(s, inItem) {
  if (ATX_RE.test(s) || FENCE_RE.test(s) && fenceInfo(s)) return true;
  if (HR_RE.test(s)) return true;
  if (htmlInterrupts(s)) return true;
  if (isBlockquoteStart(s)) return true;
  const lm = parseListMarker(s);
  // Inside a list item an ordered list interrupts a paragraph whatever
  // its start number is; at the top level (and in blockquotes) it must
  // start with 1.
  if (lm && !lm.empty && (lm.bullet || lm.start === 1 || inItem)) return true;
  return false;
}

// For lazy-continuation purposes: a line that starts a block (and so ends
// a blockquote / list item) rather than continuing its paragraph.
function isBlockStart(s) {
  if (ATX_RE.test(s)) return true;
  if (fenceInfo(s)) return true;
  if (HR_RE.test(s)) return true;
  if (htmlInterrupts(s)) return true;
  if (isBlockquoteStart(s)) return true;
  const lm = parseListMarker(s);
  if (lm) return true;
  return false;
}

// Strip all leading blockquote markers to find the innermost content
// of a (possibly nested) quote line, for context tracking only.
function quoteCore(s) {
  let cur = s;
  while (true) {
    const m = stripBlockquoteMarker(cur);
    if (m === null) return cur;
    cur = m;
  }
}

// Collect the lines of the blockquote starting at lines[i].
// Returns { content, lazy, end } where lazy holds original line indexes
// of lazy continuation lines. A lazy line is only accepted while the
// quote's content ends in a paragraph (or a list item holding one); a
// line after a code block, fence, heading or blank line ends the quote.
function blockquoteLines(lines, i) {
  const content = [];
  const lazy = new Set();
  let j = i;
  // Context of the content so far: 'para', 'list', 'code', 'other', 'blank'.
  let ctx = 'blank';
  let listIndent = 0;
  let fenceCh = null;
  let fenceLen = 0;
  // Whether the last content line pushed was a quote line (had a
  // '>' marker). A lazy line that follows a quote line starts a new
  // chunk in the reference's blockquote loop, so a setext-looking
  // lazy line there is paragraph text verbatim; a lazy setext line
  // that follows another lazy line is inside its chunk, and the
  // reference indents it by four spaces so it cannot become a
  // setext heading when the content is lexed.
  let prevWasQuote = false;
  while (j < lines.length) {
    const L = lines[j];
    const stripped = stripBlockquoteMarker(L.s);
    if (stripped !== null) {
      content.push({ s: stripped, o: L.o });
      prevWasQuote = true;
      j += 1;
      const core = quoteCore(stripped);
      if (fenceCh !== null) {
        // The close is tested against the once-stripped line: a
        // fence at this level closes on a line that is a fence after
        // one marker is removed. A line that still starts with '>'
        // is a fence in a nested quote, not a close for this one.
        const closeRe = new RegExp('^ {0,3}' + (fenceCh === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
        if (closeRe.test(stripped)) { fenceCh = null; ctx = 'other'; }
        continue;
      }
      if (core.trim() === '') {
        // A whitespace-only quote line is content (it may end a
        // paragraph's text) but it ends lazy-continuation eligibility.
        ctx = 'blank';
        continue;
      }
      // A fence is only tracked when it opens at this level. A line
      // that still starts with '>' after one marker is removed is a
      // fence inside a nested quote: it must not set fenceCh here,
      // or the outer quote would stay in 'code' context and refuse
      // lazy continuations that belong to the nested quote's
      // paragraph (its core is still classified below, so a nested
      // paragraph keeps ctx 'para').
      const fi = fenceInfo(stripped);
      if (fi) { fenceCh = fi.ch; fenceLen = fi.len; ctx = 'code'; continue; }
      if (ATX_RE.test(core) || HR_RE.test(core) || htmlInterrupts(core) || isBlockquoteStart(core)) { ctx = 'other'; continue; }
      const lm = parseListMarker(core);
      if (lm) { ctx = 'list'; listIndent = lm.contentIndent; continue; }
      if (ctx === 'list' && leadingIndent(core)[0] >= listIndent) continue;
      if (leadingIndent(core)[0] >= 4) { ctx = 'code'; continue; }
      ctx = 'para';
      continue;
    }
    if (L.s.trim() === '') break;
    if (isBlockStart(L.s)) break;
    // Lazy continuation: only inside a paragraph or a list item.
    if (ctx !== 'para' && ctx !== 'list') break;
    let s = L.s;
    // A lazy setext-looking line is paragraph text, not a heading:
    // the paragraph loop's setext check already refuses lazy lines.
    // Inside its chunk (after another lazy line) the reference
    // indents it by four spaces; at a chunk start (right after a
    // quote line) it stays verbatim.
    if (/^ {0,3}(=+|-+)[ \t]*$/.test(s) && !prevWasQuote) s = '    ' + s;
    else if (ctx === 'para' && leadingIndent(s)[0] >= 4) s = stripColsExpand(s, 4);
    content.push({ s, o: L.o });
    prevWasQuote = false;
    lazy.add(L.o);
    j += 1;
  }
  return { content, lazy, end: j };
}

// Parse a list marker at the start of s (0-3 leading spaces).
// Returns null or { bullet, ordered, marker, indent, width, contentIndent,
// empty, start }.
function parseListMarker(s) {
  const m = /^ {0,3}([-*+]|\d{1,9}[.)])/.exec(s);
  if (!m) return null;
  const marker = m[1];
  // The marker must be followed by whitespace or end of line.
  const afterMarker = m[0].length;
  if (afterMarker < s.length && s[afterMarker] !== ' ' && s[afterMarker] !== '\t') return null;
  const indent = m[0].length - marker.length;
  const width = marker.length;
  const startCol = indent + width;
  let col = startCol;
  let pos = m[0].length;
  while (pos < s.length && (s[pos] === ' ' || s[pos] === '\t')) {
    if (s[pos] === ' ') col += 1;
    else col += 4 - (col % 4);
    pos += 1;
    if (col - startCol >= 5) break;
  }
  const rest = s.slice(pos);
  const empty = rest.trim() === '';
  let contentIndent;
  if (empty) contentIndent = startCol + 1;
  else if (col - startCol >= 5) contentIndent = startCol + 1;
  else contentIndent = col;
  const bullet = marker === '-' || marker === '*' || marker === '+';
  return {
    bullet,
    ordered: !bullet,
    marker,
    indent,
    width,
    contentIndent,
    empty,
    start: bullet ? 0 : parseInt(marker.slice(0, -1), 10),
  };
}

// Does this list item contain two top-level blocks separated by a blank
// line? Nested list content, fenced code and indented code lines do not
// count as new top-level blocks. A marker that is a sibling (or deeper
// item) of an already-open nested list is not a top-level block.
function itemIsLoose(itemLines) {
  const stack = []; // open nested lists: {markerInd, contentIndent}
  let fenceCh = null;
  let fenceLen = 0;
  let inCode = false;
  let seenBlock = false;
  let pendingBlank = false;
  for (let k = 0; k < itemLines.length; k++) {
    const s = itemLines[k].s;
    if (fenceCh !== null) {
      if (s.trim() === '') {
        // A blank line inside an unterminated fence is fence content
        // only while the lines after it stay inside the fence's
        // context (the open nested list). If the fence never closes
        // and the next content is at the outer level, the fence ends
        // here and the blank line separates blocks.
        let closes = false;
        let nextInd = -1;
        const closeRe2 = new RegExp('^ {0,3}' + (fenceCh === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
        for (let q = k + 1; q < itemLines.length; q++) {
          const sq = itemLines[q].s;
          if (sq.trim() === '') continue;
          if (closeRe2.test(sq)) { closes = true; break; }
          nextInd = leadingIndent(sq)[0];
          break;
        }
        const ctx = stack.length > 0 ? stack[stack.length - 1].contentIndent : 0;
        if (!closes && nextInd !== -1 && nextInd < ctx) fenceCh = null;
        else continue;
      } else {
        const closeRe = new RegExp('^ {0,3}' + (fenceCh === '`' ? '`' : '~') + '{' + fenceLen + ',}[ \\t]*$');
        if (closeRe.test(s)) fenceCh = null;
        continue;
      }
    }
    if (s.trim() === '') { if (seenBlock) pendingBlank = true; continue; }
    const ind = leadingIndent(s)[0];
    const fi = fenceInfo(s);
    if (fi) {
      // A fence at a higher level than the open nested list is a
      // sibling block, not content of that list: pop the stack to
      // its level first, so a blank line before it makes the item
      // loose when it separates two outer-level blocks.
      while (stack.length > 0 && ind < stack[stack.length - 1].contentIndent) stack.pop();
      if (pendingBlank && seenBlock && stack.length === 0) return true;
      fenceCh = fi.ch; fenceLen = fi.len;
      seenBlock = true; pendingBlank = false; inCode = false;
      continue;
    }
    if (inCode) {
      if (ind >= 4) continue;
      inCode = false;
    }
    const lm = parseListMarker(s);
    if (lm) {
      while (stack.length > 0 && ind < stack[stack.length - 1].markerInd) stack.pop();
      if (stack.length === 0 && pendingBlank && seenBlock) return true;
      // A blank line followed by a marker that cannot continue the open
      // nested list (different bullet, or ordered where a bullet list is
      // open, or a different ordered delimiter) starts a new block
      // inside this item, so the item is loose — unless the marker is
      // indented at least to the open list's content indent, in which
      // case it is a sub-list inside that list's last item, not a new
      // block of this item. A marker that continues the open list is
      // just its next item.
      if (pendingBlank && seenBlock && stack.length > 0) {
        const top = stack[stack.length - 1];
        const mark = lm.bullet ? lm.marker : lm.marker[lm.marker.length - 1];
        if (ind < top.contentIndent && (lm.bullet !== top.bullet || mark !== top.mark)) return true;
      }
      stack.push({ markerInd: ind, contentIndent: lm.contentIndent, bullet: lm.bullet, mark: lm.bullet ? lm.marker : lm.marker[lm.marker.length - 1] });
      seenBlock = true; pendingBlank = false;
      continue;
    }
    if (stack.length > 0) {
      let top = stack[stack.length - 1];
      if (ind >= top.contentIndent) { pendingBlank = false; continue; }
      while (stack.length > 0 && ind < stack[stack.length - 1].contentIndent) stack.pop();
      if (stack.length > 0) { pendingBlank = false; continue; }
    }
    if (pendingBlank && seenBlock) return true;
    seenBlock = true;
    pendingBlank = false;
    if (ind >= 4) inCode = true;
  }
  return false;
}

// Parse the list starting at lines[i]. Returns { items, end, loose,
// bullet, delim } where each item is { lines, lazy, marker }.
function parseList(lines, i) {
  const first = parseListMarker(lines[i].s);
  const bullet = first.bullet;
  const markerCh = bullet ? first.marker : null;
  const delim = bullet ? null : first.marker[first.marker.length - 1];
  const items = [];
  let loose = false;
  let prevEndsBlank = false;
  let j = i;
  while (j < lines.length) {
    const L = lines[j];
    if (L.s.trim() === '') {
      let m = j;
      while (m < lines.length && lines[m].s.trim() === '') m += 1;
      if (m < lines.length) {
        const next = parseListMarker(lines[m].s);
        if (next && next.bullet === bullet && (bullet ? next.marker === markerCh : next.marker[next.marker.length - 1] === delim)) {
          prevEndsBlank = true;
          j = m;
          continue;
        }
      }
      break;
    }
    const mk = parseListMarker(L.s);
    if (HR_RE.test(L.s)) break;
    if (!mk || mk.bullet !== bullet || (bullet ? mk.marker !== markerCh : mk.marker[mk.marker.length - 1] !== delim)) break;
    const itemLines = [];
    const itemLazy = new Set();
    itemLines.push({ s: stripFirstCols(L.s, mk.contentIndent), o: L.o });
    j += 1;
    let hasContent = itemLines[0].s.trim() !== '';
    while (j < lines.length) {
      const L2 = lines[j];
      if (L2.s.trim() === '') {
        let m2 = j;
        while (m2 < lines.length && lines[m2].s.trim() === '') m2 += 1;
        if (m2 < lines.length && hasContent) {
          const next2 = lines[m2];
          const indented = leadingIndent(next2.s)[0] >= mk.contentIndent;
          // Only indented content belongs to this item; a following list
          // item is handled by the outer loop (and marks the list loose).
          if (indented) {
            while (j < m2) { itemLines.push({ s: '', o: lines[j].o }); j += 1; }
            continue;
          }
        }
        break;
      }
      const ind = leadingIndent(L2.s)[0];
      if (ind >= mk.contentIndent) {
        itemLines.push({ s: stripColsExpand(L2.s, mk.contentIndent), o: L2.o });
        hasContent = true;
        j += 1;
      } else if (HR_RE.test(L2.s) || parseListMarker(L2.s)) {
        break;
      } else {
        if (isBlockStart(L2.s)) break;
        // A fence-like line (``` or ~~~, even one whose info string
        // holds backticks and so is not a valid fence) ends the item
        // too: the reference's list scan stops at any fence start.
        {
          const li = leadingIndent(L2.s);
          const rest = L2.s.slice(li[1]);
          if (rest.startsWith('```') || rest.startsWith('~~~')) break;
        }
        // A lazy line is refused when the previous item line opened a
        // block that swallows lazy continuations: a fence, a heading,
        // an HTML block or a thematic break, a blank line, or an
        // indented-code line. Then the item ends and the fence (if any)
        // is left unterminated inside it, hence empty.
        const prevLine = itemLines.length > 0 ? itemLines[itemLines.length - 1].s : '';
        if (prevLine.trim() === '') break;
        const prevExpanded = prevLine.replace(/\t/g, '    ');
        let prevIndent = 0;
        while (prevIndent < prevExpanded.length && prevExpanded[prevIndent] === ' ') prevIndent += 1;
        if (prevIndent >= 4 || fenceInfo(prevLine) || ATX_RE.test(prevLine) || HR_RE.test(prevLine) || htmlInterrupts(prevLine)) break;
        // Lazy paragraph continuation: a 4+ indent loses 4 columns.
        let s = L2.s;
        if (ind >= 4) s = stripColsExpand(s, 4);
        itemLines.push({ s, o: L2.o });
        itemLazy.add(L2.o);
        hasContent = true;
        j += 1;
      }
    }
    if (prevEndsBlank) loose = true;
    if (itemIsLoose(itemLines)) loose = true;
    items.push({ lines: itemLines, lazy: itemLazy, marker: mk });
    prevEndsBlank = false;
  }
  // The final item's text is trailing-trimmed: a last line that ends in
  // spaces or tabs loses them, even inside a code block or a paragraph
  // (the list's raw text is trimmed before its items are lexed). Only
  // the last item is affected; earlier items keep their trailing space.
  if (items.length > 0) {
    const lastLines = items[items.length - 1].lines;
    for (let k = lastLines.length - 1; k >= 0; k--) {
      const s = lastLines[k].s;
      if (s !== '') {
        const trimmed = s.replace(/[ \t]+$/, '');
        if (trimmed !== s) lastLines[k] = { s: trimmed, o: lastLines[k].o };
        break;
      }
    }
  }
  return { items, end: j, loose, bullet, delim, first };
}

// Split a table row on unescaped pipes; leading/trailing pipes optional.
function splitTableRow(s) {
  s = s.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '|') {
      let bs = 0;
      let m = k - 1;
      while (m >= 0 && s[m] === '\\') { bs += 1; m -= 1; }
      if (bs % 2 === 0) { cells.push(cur); cur = ''; continue; }
    }
    cur += s[k];
  }
  cells.push(cur);
  // An escaped pipe in a cell is a literal pipe (unescaped before the
  // cell is inline-parsed, so `\|` inside a code span or emphasis is '|').
  return cells.map(c => c.trim().replace(/\\\|/g, '|'));
}

// Parse a table delimiter row; returns the alignment array or null.
function parseTableDelimiter(s) {
  if (leadingIndent(s)[0] >= 4) return null;
  const cells = splitTableRow(s);
  const aligns = [];
  for (const c of cells) {
    const m = /^(:?)-+(:?)$/.exec(c);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : null);
  }
  return aligns;
}

// Try to parse a link reference definition starting at lines[i].
// On success adds it to refs (first definition wins) and returns the
// number of lines consumed; otherwise returns 0.
// Scan a link label for a reference definition, possibly spanning
// lines. Returns { label, endLine, endCol } or null.
function scanRefLabel(lines, i) {
  for (let span = 1; span <= 4 && i + span - 1 < lines.length; span++) {
    if (span > 1 && lines[i + span - 1].s.trim() === '') break;
    let text = '';
    for (let k = 0; k < span; k++) {
      if (k > 0) text += '\n';
      text += lines[i + k].s;
    }
    let pos = 0;
    while (pos < text.length && text[pos] === ' ') pos += 1;
    if (pos > 3 || text[pos] !== '[') return null;
    const end = scanLabelEnd(text, pos);
    if (end !== -1) {
      let line = i, col = end, idx = 0;
      for (let k = 0; k < span; k++) {
        const len = lines[i + k].s.length;
        if (end <= idx + len) { line = i + k; col = end - idx; break; }
        idx += len + 1;
      }
      return { label: text.slice(pos + 1, end - 1), endLine: line, endCol: col };
    }
  }
  return null;
}

// Scan a link title for a reference definition, possibly spanning lines.
// Returns { title, endLine, endCol } or null.
function scanRefTitle(lines, line, col) {
  const q = lines[line].s[col];
  const closer = q === '(' ? ')' : q;
  let content = '';
  let l = line;
  let p = col + 1;
  while (l < lines.length) {
    if (l > line && lines[l].s.trim() === '') return null;
    const s = lines[l].s;
    while (p < s.length) {
      if (s[p] === '\\' && p + 1 < s.length) { content += s[p] + s[p + 1]; p += 2; continue; }
      if (s[p] === closer) return { title: unescapeInline(content), endLine: l, endCol: p + 1 };
      content += s[p];
      p += 1;
    }
    l += 1;
    content += '\n';
    p = 0;
  }
  return null;
}

function parseRefDef(lines, i, refs) {
  const lab = scanRefLabel(lines, i);
  if (!lab) return 0;
  const { label, endLine, endCol } = lab;
  if (label.length === 0 || label.length > 999 || !validLabelText(label)) return 0;
  let s = lines[endLine].s;
  let p = endCol;
  if (s[p] !== ':') return 0;
  p += 1;
  let line = endLine;
  let cur = s;
  // Skip whitespace; the destination may be on the next line.
  while (true) {
    while (p < cur.length && (cur[p] === ' ' || cur[p] === '\t')) p += 1;
    if (p < cur.length) break;
    line += 1;
    if (line >= lines.length || lines[line].s.trim() === '') return 0;
    cur = lines[line].s;
    p = 0;
  }
  return parseRefDefRest(lines, i, line, refs, label, cur, p);
}

function parseRefDefRest(lines, i, line, refs, label, s, p) {
  let dest = null;
  let title = null;
  let endLine = line;
  let endPos = p;
  if (s[p] === '<') {
    const gt = s.indexOf('>', p + 1);
    if (gt === -1) return 0;
    const inner = s.slice(p + 1, gt);
    if (/[\n\x00-\x1f\x7f]/.test(inner)) return 0;
    dest = inner;
    endPos = gt + 1;
  } else {
    // Bare destination: no spaces, balanced parens.
    let depth = 0;
    let q = p;
    while (q < s.length) {
      const ch = s[q];
      if (ch === ' ' || ch === '\t') break;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === '\\' && q + 1 < s.length && isAsciiPunct(s[q + 1])) q += 1;
      q += 1;
    }
    if (q === p || depth !== 0) return 0;
    dest = unescapeInline(s.slice(p, q));
    endPos = q;
  }
  // Optional title, on this line or the next (and it may span lines).
  // A title on the same line must be preceded by whitespace.
  let tp = endPos;
  let ts = s;
  let tline = line;
  let hadSpace = false;
  while (tp < ts.length && (ts[tp] === ' ' || ts[tp] === '\t')) { tp += 1; hadSpace = true; }
  if (tp >= ts.length) {
    if (line + 1 < lines.length) {
      const ns = lines[line + 1].s;
      let nq = 0;
      while (nq < ns.length && (ns[nq] === ' ' || ns[nq] === '\t')) nq += 1;
      if (nq < ns.length && (ns[nq] === '"' || ns[nq] === "'" || ns[nq] === '(')) {
        ts = ns; tp = nq; tline = line + 1; hadSpace = true;
      }
    }
  }
  if (tp < ts.length && (ts[tp] === '"' || ts[tp] === "'" || ts[tp] === '(')) {
    if (!hadSpace) return 0;
    const t = scanRefTitle(lines, tline, tp);
    if (!t) {
      // A malformed title on the next line just means no title; the
      // definition is still valid. On the same line it invalidates it.
      if (tline > line) { endLine = line; }
      else return 0;
    } else {
      title = t.title;
      endLine = t.endLine;
      let rp = t.endCol;
      const rs = lines[endLine].s;
      while (rp < rs.length && (rs[rp] === ' ' || rs[rp] === '\t')) rp += 1;
      if (rp < rs.length) {
        if (tline > line) { title = null; endLine = line; }
        else return 0;
      }
    }
  } else if (tp < ts.length) {
    return 0;
  } else {
    endLine = line;
  }
  const key = normalizeLabel(label);
  if (key === '' || hasUnescapedBracket(label)) return 0;
  if (!refs.has(key)) refs.set(key, { dest, title });
  return endLine - i + 1;
}

// ---------------------------------------------------------------- renderer
function renderBlocks(lines, refs, opts) {
  const lazy = opts.lazy || new Set();
  const allowLazyTable = opts.allowLazyTable !== false;
  const tight = !!opts.tight;
  const total = lines.length;
  const endsNL = !!opts.endsNL;
  const totalLines = opts.total || total;
  // A whitespace-only last line that is unterminated in the source is
  // content, not a blank line — but only as a trailing paragraph line.
  const contentEndsNL = opts.sub ? false : endsNL;
  function isBlankIdx(k) {
    return lines[k].s.trim() === '';
  }
  let out = '';
  let i = 0;
  while (i < total) {
    const L = lines[i];
    const s = L.s;
    if (isBlankIdx(i)) { i += 1; continue; }

    // ATX heading
    const atx = ATX_RE.exec(s);
    if (atx) {
      const level = atx[1].length;
      let t = atx[2] === undefined ? '' : atx[2];
      t = t.replace(/[ \t]+$/, '');
      if (/^#+$/.test(t)) t = '';
      else {
        const cm = /[ \t]+#+$/.exec(t);
        if (cm) t = t.slice(0, cm.index);
      }
      out += '<h' + level + '>' + parseInline(t, refs) + '</h' + level + '>\n';
      i += 1;
      continue;
    }

    // Fenced code
    const fi = fenceInfo(s);
    if (fi) {
      const closeRe = new RegExp('^ {0,3}' + (fi.ch === '`' ? '`' : '~') + '{' + fi.len + ',}[ \\t]*$');
      let j = i + 1;
      let closed = false;
      while (j < total) {
        if (closeRe.test(lines[j].s)) { closed = true; break; }
        j += 1;
      }
      const contentEnd = closed ? j : total;
      const cap = leadingIndent(s)[1];
      const stripFenceLine = fi.ch === '`' ? (l) => stripFenceIndent(l, cap) : (l) => l;
      let content = '';
      for (let k = i + 1; k < contentEnd; k++) content += stripFenceLine(lines[k].s) + '\n';
      // A trailing truly-empty content line has no terminator.
      if (contentEnd > i + 1 && stripFenceLine(lines[contentEnd - 1].s) === '' && content.endsWith('\n')) {
        content = content.slice(0, -1);
      }
      let lang = '';
      if (fi.info !== '') {
        lang = ' class="language-' + escAttr(unescapeInline(fi.info.split(/[ \t]+/)[0])) + '"';
      }
      out += '<pre><code' + lang + '>' + escCode(content) + '</code></pre>\n';
      i = closed ? j + 1 : total;
      continue;
    }

    // Thematic break
    if (HR_RE.test(s)) {
      out += '<hr>\n';
      i += 1;
      continue;
    }

    // HTML block
    const hb = htmlBlockEnd(lines, i);
    if (hb !== -1) {
      const hEnd = hb.end;
      let html = '';
      for (let k = i; k < hEnd; k++) {
        if (k > i) html += '\n';
        html += lines[k].s;
      }
      if (hEnd < total) {
        // A terminator block (kind 1) keeps its trailing newline unless
        // the next line is exactly empty (an empty line after the
        // terminator is swallowed into the match and then dropped);
        // a whitespace-only next line still keeps it. A blank-line
        // block (kind 6) never keeps one mid-document.
        if (hb.kind === 1 && lines[hEnd].s !== '') html += '\n';
      } else if (contentEndsNL) {
        html += '\n';
      }
      out += html;
      i = hEnd;
      continue;
    }

    // Blockquote
    if (isBlockquoteStart(s)) {
      const q = blockquoteLines(lines, i);
      const inner = renderBlocks(q.content, refs, { lazy: q.lazy, allowLazyTable: false, endsNL, total: totalLines, tight: false, sub: true });
      out += '<blockquote>\n' + inner + '</blockquote>\n';
      i = q.end;
      continue;
    }

    // List
    const lm = parseListMarker(s);
    if (lm) {
      const lst = parseList(lines, i);
      out += '<' + (lst.bullet ? 'ul' : 'ol') + (lst.bullet || lst.first.start === 1 ? '' : ' start="' + lst.first.start + '"') + '>\n';
      for (const item of lst.items) {
        // Task list: [ ] / [x] at the start of the first line.
        let box = null;
        if (item.lines.length > 0) {
          const tm = /^\[( |x|X)\][ \t]+/.exec(item.lines[0].s);
          if (tm) {
            const checked = tm[1] === 'x' || tm[1] === 'X';
            box = checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
            item.lines[0] = { s: item.lines[0].s.slice(tm[0].length), o: item.lines[0].o };
          }
        }
        let inner = renderBlocks(item.lines, refs, { lazy: item.lazy, allowLazyTable: true, endsNL, total: totalLines, tight: !lst.loose, sub: true, inItem: true });
        if (box) {
          if (inner.startsWith('<p>')) inner = '<p>' + box + ' ' + inner.slice(3);
          else inner = box + ' ' + inner;
        }
        out += '<li>' + inner + '</li>\n';
      }
      out += '</' + (lst.bullet ? 'ul' : 'ol') + '>\n';
      i = lst.end;
      continue;
    }

    // Indented code
    if (leadingIndent(s)[0] >= 4) {
      let j = i;
      let content = '';
      while (j < total) {
        const s2 = lines[j].s;
        if (s2.trim() === '') {
          // Include blank lines only if a code line follows; a blank line
          // indented 4+ contributes its indent beyond 4 as spaces.
          let m = j;
          while (m < total && lines[m].s.trim() === '') m += 1;
          if (m < total && leadingIndent(lines[m].s)[0] >= 4) {
            while (j < m) { content += stripCols(lines[j].s, 4) + '\n'; j += 1; }
            continue;
          }
          break;
        }
        if (leadingIndent(s2)[0] < 4) break;
        content += stripCols(s2, 4) + '\n';
        j += 1;
      }
      out += '<pre><code>' + escCode(content) + '</code></pre>\n';
      i = j;
      continue;
    }

    // Paragraph / setext heading / table: strip leading ref defs first.
    let p = i;
    while (p < total) {
      const consumed = parseRefDef(lines, p, refs);
      if (consumed > 0) { p += consumed; continue; }
      break;
    }
    if (p >= total || isBlankIdx(p)) { i = p + 1; continue; }
    // After stripping defs the next line may start a different block.
    if (isBlockStart(lines[p].s) || leadingIndent(lines[p].s)[0] >= 4) { i = p; continue; }

    // Collect paragraph lines; watch for a setext underline or a table.
    const para = [];
    let j = p;
    let setext = 0;
    let table = null;
    while (j < total) {
      const L2 = lines[j];
      if (isBlankIdx(j)) {
        // A non-empty whitespace-only line trailing a paragraph, at the
        // end of unterminated content, is part of the paragraph's text.
        if (para.length > 0 && L2.s !== '' && j === total - 1 && !contentEndsNL) {
          para.push(L2);
          j += 1;
        }
        break;
      }
      if (j > p) {
        const su = setextLevelOf(L2.s);
        if (su && !lazy.has(L2.o)) { setext = su; j += 1; break; }
        if (j === p + 1) {
          const aligns = parseTableDelimiter(L2.s);
          if (aligns) {
            const headerCells = splitTableRow(lines[p].s);
            if (headerCells.length === aligns.length && (allowLazyTable || !lazy.has(L2.o))) {
              table = { aligns, headerCells };
              j += 1;
              break;
            }
          }
        }
        // A table starting on a later paragraph line interrupts the
        // paragraph too, on the table shape alone (a header line
        // followed by a delimiter row). The cell-count check only
        // decides whether the following block renders as a table or
        // as a paragraph, so it is not applied here: the paragraph
        // ends at this line either way, and the next block iteration
        // sorts out the table. A pure-dashes delimiter is a setext
        // underline, not a table delimiter (the reference renders
        // `foo` + `---` as a heading even when the header has pipes),
        // so it must not interrupt here — the setext check on the
        // next line handles it.
        if (j + 1 < total && !setextLevelOf(lines[j + 1].s) && (allowLazyTable || (!lazy.has(L2.o) && !lazy.has(lines[j + 1].o)))) {
          if (parseTableDelimiter(lines[j + 1].s)) break;
        }
        // A lazy line is a paragraph continuation by definition.
        if (!lazy.has(L2.o) && isInterrupt(L2.s, opts.inItem)) break;
      }
      // Inside a list item, a paragraph continuation line indented 4+
      // columns is lexed as indented code and merged back into the
      // paragraph with those 4 columns removed (a top-level paragraph
      // keeps the indent, but item content is lexed with the code
      // rule active). The merged code text keeps its trailing newline
      // when another line follows it in the item, so the next line
      // joins after a blank line (or the next block starts after a
      // newline); as the item's last line it has no trailing newline.
      // Lazy lines were already stripped where they needed it, so only
      // non-lazy lines are adjusted here.
      let lineText = L2.s;
      if (opts.inItem && j > p && !lazy.has(L2.o) && leadingIndent(lineText)[0] >= 4) {
        lineText = stripColsExpand(lineText, 4) + (j + 1 < total ? '\n' : '');
      }
      para.push(lineText === L2.s ? L2 : { s: lineText, o: L2.o });
      j += 1;
    }

    if (setext) {
      const text = para.map(l => l.s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')).join('\n');
      out += '<h' + setext + '>' + parseInline(text, refs) + '</h' + setext + '>\n';
      i = j;
      continue;
    }
    if (table) {
      const aligns = table.aligns;
      const headerCells = table.headerCells;
      let th = '';
      for (let c = 0; c < headerCells.length; c++) {
        const a = aligns[c];
        th += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(headerCells[c], refs) + '</th>\n';
      }
      // Body rows: non-blank lines that are not block starts.
      const rows = [];
      while (j < total) {
        const L2 = lines[j];
        // A line of only tabs is a body row (empty cells), not a blank
        // line; any other whitespace-only line ends the table.
        if (L2.s.trim() === '' && !/^\t+$/.test(L2.s)) break;
        if (isInterrupt(L2.s, opts.inItem)) break;
        const cells = splitTableRow(L2.s);
        while (cells.length < headerCells.length) cells.push('');
        rows.push(cells.slice(0, headerCells.length));
        j += 1;
      }
      let html = '<table>\n<thead>\n<tr>\n' + th + '</tr>\n</thead>\n';
      if (rows.length > 0) {
        html += '<tbody>';
        for (const row of rows) {
          html += '<tr>\n';
          for (let c = 0; c < row.length; c++) {
            const a = aligns[c];
            html += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(row[c], refs) + '</td>\n';
          }
          html += '</tr>\n';
        }
        html += '</tbody>';
      }
      html += '</table>\n';
      out += html;
      i = j;
      continue;
    }

    const text = para.map(l => l.s).join('\n');
    if (tight) out += parseInline(text, refs);
    else out += '<p>' + parseInline(text, refs) + '</p>\n';
    i = j;
  }
  return out;
}

// Def pre-pass: walk the block structure and collect link reference
// definitions (so a definition used before its position still applies).
function scanBlocks(lines, refs, opts) {
  const total = lines.length;
  let i = 0;
  while (i < total) {
    const L = lines[i];
    const s = L.s;
    if (s.trim() === '') { i += 1; continue; }
    if (ATX_RE.test(s)) { i += 1; continue; }
    const fi = fenceInfo(s);
    if (fi) {
      let j = i + 1;
      const closeRe = new RegExp('^ {0,3}' + (fi.ch === '`' ? '`' : '~') + '{' + fi.len + ',}[ \\t]*$');
      while (j < total && !closeRe.test(lines[j].s)) j += 1;
      i = j < total ? j + 1 : total;
      continue;
    }
    if (HR_RE.test(s)) { i += 1; continue; }
    const hb = htmlBlockEnd(lines, i);
    if (hb !== -1) { i = hb.end; continue; }
    if (isBlockquoteStart(s)) {
      const q = blockquoteLines(lines, i);
      scanBlocks(q.content, refs, opts);
      i = q.end;
      continue;
    }
    if (parseListMarker(s)) {
      const lst = parseList(lines, i);
      for (const item of lst.items) scanBlocks(item.lines, refs, opts);
      i = lst.end;
      continue;
    }
    if (leadingIndent(s)[0] >= 4) {
      let j = i;
      while (j < total && lines[j].s.trim() !== '' && leadingIndent(lines[j].s)[0] >= 4) j += 1;
      i = j;
      continue;
    }
    // Paragraph: strip leading defs, then skip to its end.
    let j = i;
    while (j < total) {
      const consumed = parseRefDef(lines, j, refs);
      if (consumed > 0) { j += consumed; continue; }
      break;
    }
    while (j < total && lines[j].s.trim() !== '' && !isInterrupt(lines[j].s, opts.inItem)) j += 1;
    i = j;
  }
}

export function parse(src) {
  if (src === '') return '';
  autolinkSuppressed = false;
  const normalized = src.replace(/\r\n?/g, '\n');
  const endsNL = normalized.endsWith('\n');
  const raw = normalized.split('\n');
  if (endsNL) raw.pop();
  const lines = raw.map((s, idx) => ({ s, o: idx }));
  const refs = new Map();
  scanBlocks(lines, refs, {});
  return renderBlocks(lines, refs, { lazy: new Set(), allowLazyTable: true, endsNL, total: lines.length, tight: false });
}
