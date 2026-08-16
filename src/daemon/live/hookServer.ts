import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SOCKET_PATH } from '../config.js';
import type { HookPayload, LiveTracker } from './tracker.js';

/**
 * Claude Code hook 接收端。
 *
 * 用 unix socket 而不是 HTTP：不占端口、天然限制在本机、不需要在 hook 客户端里带令牌。
 * socket 文件权限 0600。
 */
export class HookServer {
  private server?: net.Server;

  constructor(private tracker: LiveTracker) {}

  start(socketPath: string = SOCKET_PATH): void {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    // 上次异常退出会留下陈旧的 socket 文件，先清掉
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* 不存在即可 */
    }

    this.server = net.createServer((conn) => {
      let buf = '';
      conn.setEncoding('utf8');
      conn.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 2_000_000) conn.destroy();
      });
      conn.on('error', () => conn.destroy());
      conn.on('end', () => {
        for (const line of buf.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            this.tracker.onHook(JSON.parse(trimmed) as HookPayload);
          } catch {
            // 坏行忽略，hook 通道绝不能因为一条脏数据而中断
          }
        }
      });
    });

    this.server.on('error', () => {
      /* 监听失败不影响 daemon 其余部分 */
    });
    this.server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        /* 权限设置失败不致命 */
      }
    });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* 已被清理 */
    }
  }
}
