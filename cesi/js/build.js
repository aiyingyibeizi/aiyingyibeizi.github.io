// scripts/build.js
// Build script for cesi site: bundles JS (esbuild), copies static files into public/ and rewrites HTML to use the bundle.
const fs = require('fs');
const path = require('path');

const esbuild = require('esbuild');

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'public');

function rimrafSync(p) {
  if (!fs.existsSync(p)) return;
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    for (const f of fs.readdirSync(p)) rimrafSync(path.join(p, f));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function mkdirpSync(p) {
  if (fs.existsSync(p)) return;
  mkdirpSync(path.dirname(p));
  fs.mkdirSync(p);
}

function copyRecursive(src, dest, opts = {}) {
  const ignore = opts.ignore || (() => false);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    mkdirpSync(dest);
    for (const name of fs.readdirSync(src)) {
      const sp = path.join(src, name);
      const dp = path.join(dest, name);
      if (ignore(sp)) continue;
      copyRecursive(sp, dp, opts);
    }
  } else {
    mkdirpSync(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function rewriteHtmlFile(srcPath, destPath, replacements) {
  let s = fs.readFileSync(srcPath, 'utf8');
  for (const [pattern, repl] of replacements) {
    s = s.replace(pattern, repl);
  }
  mkdirpSync(path.dirname(destPath));
  fs.writeFileSync(destPath, s, 'utf8');
}

(async function main() {
  console.log('Build started');
  // clean out
  rimrafSync(OUT);

  // 1) bundle JS into public/cesi/js/common.bundle.js
  const bundleOut = path.join(OUT, 'cesi', 'js', 'common.bundle.js');
  mkdirpSync(path.dirname(bundleOut));

  try {
    await esbuild.build({
      entryPoints: [path.join('cesi','js','common.js'), path.join('cesi','js','common.optimizer.js')],
      bundle: true,
      minify: true,
      sourcemap: false,
      target: ['es2017'],
      outfile: bundleOut,
      legalComments: 'none'
    });
    console.log('Bundled JS =>', bundleOut);
  } catch (e) {
    console.error('esbuild failed', e);
    process.exit(1);
  }

  // 2) copy HTML and other assets into public, rewriting HTML to use the bundle
  // include root files (index.html if exists) and cesi/ directory
  const pathsToCopy = ['CNAME','CODE_WIKI.md','SECURITY.md'];
  for (const p of pathsToCopy) {
    const src = path.join(ROOT, p);
    if (fs.existsSync(src)) {
      copyRecursive(src, path.join(OUT, p));
    }
  }

  // copy entire cesi tree, but rewrite .html to reference bundle
  const CESI = path.join(ROOT, 'cesi');
  if (!fs.existsSync(CESI)) {
    console.error('No cesi directory found — aborting');
    process.exit(1);
  }

  const all = (function listDir(dir) {
    let res = [];
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      const stat = fs.statSync(fp);
      if (stat.isDirectory()) res = res.concat(listDir(fp));
      else res.push(fp);
    }
    return res;
  })(CESI);

  const htmlReplacements = [
    // replace common.js references (various relative styles)
    [ /(<script[^>]*src=["'])(?:\.\/)?(?:cesi\/js\/)?common(?:\.optimizer)?\.js(["'][^>]*><\/script>)/g, '$1cesi/js/common.bundle.js$2' ],
    [ /cesi\/js\/common\.js/g, 'cesi/js/common.bundle.js' ],
    [ /cesi\/js\/common\.optimizer\.js/g, 'cesi/js/common.bundle.js' ]
  ];

  for (const src of all) {
    const rel = path.relative(ROOT, src);
    const dest = path.join(OUT, rel);
    const ext = path.extname(src).toLowerCase();
    if (ext === '.html') {
      rewriteHtmlFile(src, dest, htmlReplacements);
    } else if (ext === '.js' && rel === path.join('cesi','js','common.optimizer.js')) {
      // optimizer is bundled — skip copying
      continue;
    } else if (ext === '.js' && rel === path.join('cesi','js','common.js')) {
      // already bundled
      continue;
    } else {
      copyRecursive(src, dest);
    }
  }

  // 3) ensure public has cesi/js/common.bundle.js (already done)

  // 4) fallback: if some HTML files reference other js paths, leave them as-is

  console.log('Copy complete. Public dir ready at', OUT);
})();
