const fs = require('fs');
const path = require('path');
const root = '/workspace/cesi';

function extractBalanced(src, startIdx) {
  let depth = 0, i = startIdx, inStr = null, esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(startIdx, i);
}

const i18nSrc = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
const tIdx = i18nSrc.indexOf('const TRANSLATIONS = ');
const TRANSLATIONS = eval('(' + extractBalanced(i18nSrc, i18nSrc.indexOf('{', tIdx)) + ')');
const eIdx = i18nSrc.indexOf('const EXTRA_TRANSLATIONS = ');
const EXTRA = eval('(' + extractBalanced(i18nSrc, i18nSrc.indexOf('{', eIdx)) + ')');
Object.keys(EXTRA).forEach(l => { if (!TRANSLATIONS[l]) TRANSLATIONS[l] = {}; Object.assign(TRANSLATIONS[l], EXTRA[l]); });

const LANGS = Object.keys(TRANSLATIONS);
// keys that only need to exist at all (fallback provided) vs must exist everywhere
const findings = [];

function checkKey(where, key, requireAll) {
  const miss = LANGS.filter(l => !(TRANSLATIONS[l] && Object.prototype.hasOwnProperty.call(TRANSLATIONS[l], key)));
  if (requireAll ? miss.length : miss.length === LANGS.length) findings.push(`${where}: "${key}" missing in [${miss.join(',')}]`);
}

const files = fs.readdirSync(root).filter(f => f.endsWith('.html'));
for (const f of files) {
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  let pageI18n = {};
  const pIdx = html.indexOf('APEXON_PAGE_I18N');
  if (pIdx !== -1) {
    const b = html.indexOf('{', pIdx);
    if (b !== -1) { try { pageI18n = eval('(' + extractBalanced(html, b) + ')'); } catch (e) {} }
  }
  const present = (key, l) => (TRANSLATIONS[l] && Object.prototype.hasOwnProperty.call(TRANSLATIONS[l], key)) || (pageI18n[l] && Object.prototype.hasOwnProperty.call(pageI18n[l], key));
  // data-i18n: must exist in all langs
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?\s*=\s*"([^"]+)"/g)) {
    const k = m[1];
    const miss = LANGS.filter(l => !present(k, l));
    if (miss.length) findings.push(`${f} [data-i18n]: "${k}" missing in [${miss.join(',')}]`);
  }
  // inline t('key') with NO fallback
  for (const m of html.matchAll(/\bt\(\s*(['"])([A-Za-z][\w]*)\1\s*\)/g)) {
    const k = m[2];
    const miss = LANGS.filter(l => !present(k, l));
    if (miss.length) findings.push(`${f} [t()]: "${k}" missing in [${miss.join(',')}]`);
  }
}

for (const jf of ['js/common.js', 'js/music.js', 'js/search.js', 'js/share.js', 'js/achievements.js']) {
  const src = fs.readFileSync(path.join(root, jf), 'utf8');
  for (const m of src.matchAll(/\.t\(\s*(['"])([A-Za-z][\w]*)\1\s*\)/g)) {
    const k = m[2];
    const miss = LANGS.filter(l => !(TRANSLATIONS[l] && Object.prototype.hasOwnProperty.call(TRANSLATIONS[l], k)));
    if (miss.length) findings.push(`${jf} [t()]: "${k}" missing in [${miss.join(',')}]`);
  }
}

console.log('=== i18n issues (' + new Set(findings).size + ') ===');
console.log([...new Set(findings)].join('\n') || '(none)');
