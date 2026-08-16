/**
 * node-pty 的 prebuild 包在解包后会丢掉 spawn-helper 的执行位，
 * 结果是 pty.spawn 直接抛 `posix_spawnp failed`（实测 node-pty 1.1.0 + npm 11）。
 * 每次安装后补回执行位。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREBUILDS = path.join(ROOT, 'node_modules', 'node-pty', 'prebuilds');

if (fs.existsSync(PREBUILDS)) {
  for (const dir of fs.readdirSync(PREBUILDS)) {
    const helper = path.join(PREBUILDS, dir, 'spawn-helper');
    try {
      if (fs.existsSync(helper)) {
        fs.chmodSync(helper, 0o755);
      }
    } catch {
      // 非致命：Windows 上没有这个文件，权限设置失败也只影响 PTY
    }
  }
}
