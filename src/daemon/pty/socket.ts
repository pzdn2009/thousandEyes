import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, hostAllowed } from '../server/auth.js';
import type { PtyManager, TerminalMeta } from './manager.js';

/**
 * PTY 的双向流。HTTP API 适合创建/关闭终端；只有输入和输出走 WebSocket，
 * 避免把终端这种高频字节流塞进 SSE 或轮询里。
 */
export function attachTerminalSocket(server: http.Server, terminals: PtyManager, token: string): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const listeners = new Map<WebSocket, Set<string>>();

  const send = (ws: WebSocket, type: string, data: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
  };
  const broadcast = (type: string, data: unknown, id?: string) => {
    for (const [ws, subscribed] of listeners) {
      if (!id || subscribed.has(id)) send(ws, type, data);
    }
  };

  const onData = (id: string, data: string) => broadcast('data', { id, data }, id);
  const onSpawn = (meta: TerminalMeta) => broadcast('terminal', { action: 'spawn', meta });
  const onMeta = (meta: TerminalMeta) => broadcast('terminal', { action: 'meta', meta });
  const onExit = (data: unknown) => broadcast('terminal', { action: 'exit', ...((data as object) ?? {}) });
  const onRemove = (id: string) => broadcast('terminal', { action: 'remove', id });
  terminals.on('data', onData);
  terminals.on('spawn', onSpawn);
  terminals.on('meta', onMeta);
  terminals.on('exit', onExit);
  terminals.on('remove', onRemove);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/api/terminal/ws' || !hostAllowed(req) || !authenticate(req, url, token).ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    const subscribed = new Set<string>();
    listeners.set(ws, subscribed);
    send(ws, 'snapshot', terminals.list());
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; id?: string; data?: string; cols?: number; rows?: number };
        if (!msg.type || !msg.id) return;
        if (msg.type === 'subscribe') {
          subscribed.add(msg.id);
          send(ws, 'backlog', { id: msg.id, data: terminals.scrollback(msg.id) });
        } else if (msg.type === 'unsubscribe') {
          subscribed.delete(msg.id);
        } else if (msg.type === 'input' && typeof msg.data === 'string') {
          terminals.write(msg.id, msg.data);
        } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
          const cols = msg.cols!;
          const rows = msg.rows!;
          terminals.resize(msg.id, Math.min(500, Math.max(1, cols)), Math.min(300, Math.max(1, rows)));
        }
      } catch {
        // 错误消息直接丢弃；一个坏浏览器页不该影响 daemon。
      }
    });
    ws.on('close', () => listeners.delete(ws));
  });

  return () => {
    terminals.off('data', onData);
    terminals.off('spawn', onSpawn);
    terminals.off('meta', onMeta);
    terminals.off('exit', onExit);
    terminals.off('remove', onRemove);
    for (const ws of listeners.keys()) ws.close();
    wss.close();
  };
}
