const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'cesi');
const outDir = path.join(__dirname, '..', 'public');

function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function walk(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(walk(fp));
    else out.push(fp);
  }
  return out;
}

console.log(`Building: ${srcDir} -> ${outDir}`);
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
copyDir(srcDir, outDir);

// H8 / UI2 修复：用 esbuild 压缩产物中的 JS 与 CSS（生产环境不再直接加载未压缩源码）。
// 说明：
//   - 就地压缩（同名覆盖），HTML 引用无需改写，避免二次引入 404 风险。
//   - JS 只做「空白 + 语法」压缩，关闭标识符重命名（minifyIdentifiers:false），
//     避免破坏 HTML 内联 onclick 引用的全局函数名。
//   - esbuild 不可用时降级为纯拷贝，构建不失败。
(async function minify() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    // 回落：复用 cesi-worker 里已安装的 esbuild，避免根目录重复安装
    try {
      esbuild = require(path.join(__dirname, '..', 'cesi-worker', 'node_modules', 'esbuild'));
    } catch (e2) {
      console.warn('[minify] esbuild 未安装，跳过压缩（纯拷贝已完成）');
      return;
    }
  }

  const files = walk(outDir);
  let jsCount = 0, cssCount = 0, saved = 0;
  for (const fp of files) {
    const ext = path.extname(fp).toLowerCase();
    if (ext !== '.js' && ext !== '.css') continue;
    const src = fs.readFileSync(fp, 'utf8');
    try {
      let out;
      if (ext === '.css') {
        out = (await esbuild.transform(src, { loader: 'css', minify: true })).code;
        cssCount++;
      } else {
        out = (await esbuild.transform(src, {
          loader: 'js',
          minifyWhitespace: true,
          minifySyntax: true,
          minifyIdentifiers: false,
          legalComments: 'none',
        })).code;
        jsCount++;
      }
      saved += Math.max(0, src.length - out.length);
      fs.writeFileSync(fp, out, 'utf8');
    } catch (err) {
      console.warn('[minify] 跳过', path.relative(outDir, fp), '-', err.message);
    }
  }
  console.log(`[minify] 完成：JS ${jsCount} 个，CSS ${cssCount} 个，共节省约 ${Math.round(saved / 1024)} KB`);
  console.log('Build complete.');
})();
