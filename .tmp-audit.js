const fs = require('fs');
const path = require('path');
const root = '/workspace/cesi';
const files = fs.readdirSync(root).filter(f => f.endsWith('.html'));
const problems = [];

// global i18n.js keys
const i18nSrc = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
const globalKeys = new Set();
for (const m of i18nSrc.matchAll(/(?<![A-Za-z0-9_$])["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*:/g)) globalKeys.add(m[1]);

const assetRefs = [];
const internalLinks = [];

for (const f of files) {
  const p = path.join(root, f);
  const html = fs.readFileSync(p, 'utf8');
  const pageKeys = new Set(globalKeys);
  for (const m of html.matchAll(/(?<![A-Za-z0-9_$.])["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*:/g)) pageKeys.add(m[1]);

  const ids = [];
  for (const m of html.matchAll(/\sid\s*=\s*"([^"]+)"/g)) ids.push(m[1]);
  const seen = {}; const dup = new Set();
  for (const id of ids) { if (seen[id]) dup.add(id); seen[id] = true; }
  if (dup.size) problems.push(`[dup-id] ${f}: ${[...dup].join(', ')}`);

  for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|tel:|data:|#|javascript:)/.test(u)) continue;
    if (u.includes("'") || u.includes('${') || u.includes('+')) continue; // template/JS-injected
    const clean = u.split('?')[0].split('#')[0];
    if (!clean) continue;
    if (clean.endsWith('.html')) internalLinks.push({ file: f, link: clean });
    else assetRefs.push({ file: f, ref: clean });
  }
  for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?\s*=\s*"([^"]+)"/g)) {
    const k = m[1];
    if (!pageKeys.has(k)) problems.push(`[i18n-missing] ${f}: key "${k}"`);
  }
}

for (const a of assetRefs) {
  const t = path.join(root, a.ref);
  if (!fs.existsSync(t)) problems.push(`[asset-404] ${a.file} -> ${a.ref}`);
}
for (const l of internalLinks) {
  const t = path.join(root, l.link);
  if (!fs.existsSync(t)) problems.push(`[link-404] ${l.file} -> ${l.link}`);
}

// duplicate function declarations in shared JS
function dupFns(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = {};
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names[m[1]] = (names[m[1]] || 0) + 1;
  }
  const dup = Object.entries(names).filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  if (dup.length) problems.push(`[dup-fn] ${path.relative(root, file)}: ${dup.join(', ')}`);
}
['js/common.js', 'js/i18n.js', 'js/share.js', 'js/achievements.js', 'js/music.js', 'js/search.js'].forEach(f => {
  const fp = path.join(root, f);
  if (fs.existsSync(fp)) dupFns(fp);
});

console.log('=== PROBLEMS (' + new Set(problems).size + ') ===');
console.log([...new Set(problems)].join('\n') || '(none)');
console.log('\n=== summary ===  html:', files.length, '| assets:', assetRefs.length, '| links:', internalLinks.length);
