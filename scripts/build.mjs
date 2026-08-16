import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const watch = process.argv.includes('--watch');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'web'), { recursive: true });

/** Web 前端：单文件 bundle，没有外部依赖。 */
const webOpts = {
  entryPoints: [path.join(ROOT, 'src/web/app.ts')],
  outfile: path.join(OUT, 'web/app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
};

/** daemon：原生模块与 chokidar 留给 node_modules 解析。 */
const daemonOpts = {
  entryPoints: [path.join(ROOT, 'src/daemon/index.ts')],
  outfile: path.join(OUT, 'daemon/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
};

function copyStatic() {
  for (const f of ['index.html', 'styles.css']) {
    fs.copyFileSync(path.join(ROOT, 'src/web', f), path.join(OUT, 'web', f));
  }
}

copyStatic();
await build(webOpts);
await build(daemonOpts);

if (watch) {
  fs.watch(path.join(ROOT, 'src/web'), (_e, file) => {
    if (file === 'index.html' || file === 'styles.css') copyStatic();
  });
}

console.log('构建完成 →', path.relative(process.cwd(), OUT));
