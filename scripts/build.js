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

console.log(`Building: ${srcDir} -> ${outDir}`);
if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
copyDir(srcDir, outDir);
console.log('Build complete.');
