#!/usr/bin/env node
/**
 * Claude Code hook 客户端。
 *
 * 由 Claude Code 在 hook 触发时执行：从 stdin 收到事件 JSON，转发给 daemon 的 unix socket。
 *
 * 铁律：绝不阻塞、绝不失败。
 *  - daemon 没起、socket 不在、写失败 —— 一律静默退出 0
 *  - 硬超时兜底，任何情况下都不会拖住 Claude 的主流程
 *  - stdout 保持空（Claude 会把 hook 的 stdout 当控制指令解析）
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SOCKET =
  process.env.THOUSANDEYES_SOCKET ??
  path.join(process.env.THOUSANDEYES_HOME ?? path.join(os.homedir(), '.thousandEyes'), 'hook.sock');

const HARD_TIMEOUT_MS = 700;
const eventName = process.argv[2];

const bail = () => process.exit(0);
const killer = setTimeout(bail, HARD_TIMEOUT_MS);
killer.unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
  if (raw.length > 1_000_000) raw = raw.slice(0, 1_000_000);
});
process.stdin.on('error', bail);
process.stdin.on('end', () => {
  let payload;
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }
  if (eventName && !payload.hook_event_name) payload.hook_event_name = eventName;

  let sock;
  try {
    sock = net.createConnection(SOCKET);
  } catch {
    bail();
    return;
  }
  sock.on('error', bail);
  sock.on('connect', () => {
    sock.end(`${JSON.stringify(payload)}\n`, () => bail());
  });
  sock.on('close', bail);
});
