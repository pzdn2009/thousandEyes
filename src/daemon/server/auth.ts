import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { TOKEN_PATH } from '../config.js';

/**
 * 本地令牌。spec.md §8。
 *
 * daemon 只监听 127.0.0.1，令牌用于挡住同机其它进程与浏览器里的恶意页面
 * （后者靠 Host 白名单挡 DNS rebinding）。文件权限 0600。
 */

const COOKIE = 'te_token';

export function ensureToken(): string {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // 不存在则生成
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(TOKEN_PATH, 0o600);
  return token;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** 拒绝非本机 Host，防 DNS rebinding。 */
export function hostAllowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

export interface AuthResult {
  ok: boolean;
  /** 需要通过 Set-Cookie 落地令牌（首次带 ?token= 访问）。 */
  setCookie?: string;
}

export function authenticate(req: IncomingMessage, url: URL, token: string): AuthResult {
  const fromQuery = url.searchParams.get('token');
  if (fromQuery && timingSafeEqual(fromQuery, token)) {
    return {
      ok: true,
      setCookie: `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    };
  }
  const fromCookie = readCookie(req, COOKIE);
  if (fromCookie && timingSafeEqual(fromCookie, token)) return { ok: true };

  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ') && timingSafeEqual(header.slice(7).trim(), token)) {
    return { ok: true };
  }
  return { ok: false };
}
