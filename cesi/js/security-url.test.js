// Security URL sanitizer tests for the static frontend.
// Run with: node cesi/js/security-url.test.js

const assert = require('assert');

function safeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  const dangerousProtocol = /^(javascript|data|vbscript|file|about|blob):/i;
  if (dangerousProtocol.test(trimmed)) return '';
  return trimmed;
}

function escapeAttr(str) {
  if (str == null) return '';
  const url = String(str).trim();
  if (/^(javascript|data|vbscript|file|about|blob):/i.test(url)) return '';
  return url.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

const tests = [
  // safeUrl
  { fn: safeUrl, input: 'assets/avatars/avatar_01.jpg?v=2', expected: 'assets/avatars/avatar_01.jpg?v=2', desc: 'safeUrl keeps normal relative URL' },
  { fn: safeUrl, input: 'https://example.com/img.png', expected: 'https://example.com/img.png', desc: 'safeUrl keeps HTTPS URL' },
  { fn: safeUrl, input: 'javascript:alert(document.cookie)', expected: '', desc: 'safeUrl blocks javascript: protocol' },
  { fn: safeUrl, input: '  javascript:alert(1)  ', expected: '', desc: 'safeUrl blocks javascript: with whitespace' },
  { fn: safeUrl, input: 'JaVaScRiPt:alert(1)', expected: '', desc: 'safeUrl blocks javascript: case-insensitively' },
  { fn: safeUrl, input: 'data:text/html,<script>alert(1)</script>', expected: '', desc: 'safeUrl blocks data: protocol' },
  { fn: safeUrl, input: 'vbscript:msgbox(1)', expected: '', desc: 'safeUrl blocks vbscript: protocol' },
  { fn: safeUrl, input: '', expected: '', desc: 'safeUrl returns empty for empty string' },
  { fn: safeUrl, input: null, expected: '', desc: 'safeUrl returns empty for null' },

  // escapeAttr
  { fn: escapeAttr, input: 'assets/cover.jpg', expected: 'assets/cover.jpg', desc: 'escapeAttr keeps normal URL' },
  { fn: escapeAttr, input: 'javascript:alert(1)', expected: '', desc: 'escapeAttr blocks javascript: protocol' },
  { fn: escapeAttr, input: '  data:text/html,<script>alert(1)</script>  ', expected: '', desc: 'escapeAttr blocks data: protocol with whitespace' },
  { fn: escapeAttr, input: 'url"with\'quotes', expected: 'url&quot;with&#039;quotes', desc: 'escapeAttr still escapes quotes for safe URLs' },
  { fn: escapeAttr, input: null, expected: '', desc: 'escapeAttr returns empty for null' },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  try {
    const actual = t.fn(t.input);
    assert.strictEqual(actual, t.expected);
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${t.desc}`);
    console.error(`  input:    ${JSON.stringify(t.input)}`);
    console.error(`  expected: ${JSON.stringify(t.expected)}`);
    console.error(`  actual:   ${JSON.stringify(t.fn(t.input))}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
