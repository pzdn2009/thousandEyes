/**
 * L2 采集：从 PTY 字节流里解析 shell 集成标记。spec.md §3.1。
 *
 * 为什么必须有这一层：光看 PTY 输出是抠不出「执行了哪条命令、退出码是多少」的——
 * 流里只有字符回显、光标移动和屏幕重绘。业界解法是让 shell 主动打语义标记：
 *
 *   OSC 133 ; A   ST      提示符开始
 *   OSC 133 ; B   ST      命令输入开始
 *   OSC 133 ; C   ST      命令输出开始
 *   OSC 133 ; D ; <code>  命令结束，带退出码
 *   OSC 633 ; E ; <cmd>   命令原文（VS Code 定下的约定，比从流里猜命令可靠得多）
 *   OSC 7  ; file://host/path   当前目录
 *
 * 终结符可以是 BEL(\x07) 也可以是 ST(\x1b\\)，两种都要认。
 */

export type ShellMarker =
  | { type: 'prompt-start' }
  | { type: 'command-start' }
  | { type: 'output-start' }
  | { type: 'command-done'; exitCode: number }
  | { type: 'command-line'; command: string }
  | { type: 'cwd'; cwd: string };

/** 单条 OSC 序列的长度上限，超过就丢弃，避免脏流把缓冲撑爆。 */
const MAX_SEQ = 8192;

export class ShellMarkerParser {
  private pending = '';

  /**
   * 从 PTY 流中取出 thousandEyes 的语义标记，并返回可以安全交给 xterm 的可见流。
   * OSC 133 / 633 / 7 是采集协议，不是用户输出；部分终端会把未知 633 显示成乱码，
   * 所以必须在进入 xterm 和录像前剥离。其它 OSC 序列则完整保留。
   */
  consume(chunk: string): { markers: ShellMarker[]; output: string } {
    let buf = this.pending + chunk;
    const markers: ShellMarker[] = [];
    let output = '';

    for (;;) {
      const start = buf.indexOf('\x1b]');
      if (start < 0) {
        // 末尾刚好是 ESC 时不能立即输出，下一块可能接 ] 组成 OSC。
        if (buf.endsWith('\x1b')) {
          output += buf.slice(0, -1);
          this.pending = '\x1b';
        } else {
          output += buf;
          this.pending = '';
        }
        return { markers, output };
      }

      output += buf.slice(0, start);
      buf = buf.slice(start);

      const bel = buf.indexOf('\x07');
      const st = buf.indexOf('\x1b\\');
      let end = -1;
      let termLen = 0;
      if (bel >= 0 && (st < 0 || bel < st)) {
        end = bel;
        termLen = 1;
      } else if (st >= 0) {
        end = st;
        termLen = 2;
      }

      if (end < 0) {
        // 只有我们的已知前缀才跨块缓存；其它 OSC 原样输出，避免截断用户程序的流。
        if (isOurPrefix(buf)) {
          if (buf.length > MAX_SEQ) {
            output += buf;
            this.pending = '';
          } else {
            this.pending = buf;
          }
        } else {
          output += buf;
          this.pending = '';
        }
        return { markers, output };
      }

      const body = buf.slice(start + 2, end);
      const marker = parseBody(body);
      if (marker) markers.push(marker);
      else output += buf.slice(0, end + termLen);
      buf = buf.slice(end + termLen);
    }
  }

  /** 兼容旧调用方；新代码应使用 consume()，以免把协议字节送到画面。 */
  push(chunk: string): ShellMarker[] {
    return this.consume(chunk).markers;
  }

  reset(): void {
    this.pending = '';
  }
}

function isOurPrefix(value: string): boolean {
  return ['\x1b]133;', '\x1b]633;E;', '\x1b]7;'].some(
    (prefix) => prefix.startsWith(value) || value.startsWith(prefix),
  );
}

function parseBody(body: string): ShellMarker | undefined {
  if (body.startsWith('133;')) {
    const rest = body.slice(4);
    const kind = rest[0];
    if (kind === 'A') return { type: 'prompt-start' };
    if (kind === 'B') return { type: 'command-start' };
    if (kind === 'C') return { type: 'output-start' };
    if (kind === 'D') {
      // D 可能不带退出码（如被中断），此时按 0 处理
      const parts = rest.split(';');
      const code = Number(parts[1]);
      return { type: 'command-done', exitCode: Number.isFinite(code) ? code : 0 };
    }
    return undefined;
  }

  if (body.startsWith('633;E;')) {
    return { type: 'command-line', command: decodeCommand(body.slice(6)) };
  }

  if (body.startsWith('7;')) {
    const url = body.slice(2);
    const cwd = fileUrlToPath(url);
    return cwd ? { type: 'cwd', cwd } : undefined;
  }

  return undefined;
}

/**
 * 命令原文里可能含分号、换行、ESC，直接放进 OSC 会破坏序列结构，
 * 所以 shell 侧把它们转义成 \xNN，这里还原。
 */
function decodeCommand(raw: string): string {
  // 只取第一个分号前的部分：VS Code 约定后面可能跟 nonce
  const semi = raw.indexOf(';');
  const payload = semi >= 0 ? raw.slice(0, semi) : raw;
  return payload.replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function fileUrlToPath(url: string): string | undefined {
  if (!url.startsWith('file://')) return undefined;
  const withoutScheme = url.slice(7);
  const slash = withoutScheme.indexOf('/');
  if (slash < 0) return undefined;
  try {
    return decodeURIComponent(withoutScheme.slice(slash));
  } catch {
    return withoutScheme.slice(slash);
  }
}
