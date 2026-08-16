import fs from 'node:fs';
import path from 'node:path';
import { CAST_DIR } from '../config.js';
import { enforceCastRetention } from './retention.js';

/**
 * L1 采集：把 PTY 字节流录成 asciicast v2。spec.md §5.3。
 *
 * 选 asciicast 而不是自定义格式，是为了能直接被 asciinema / asciinema-player 打开——
 * 录像的价值在于随时能拿出去看，不该锁死在本项目里。
 *
 * 格式：首行是 header JSON，之后每行 `[相对秒数, "o", "数据"]`。
 */

export interface RecorderOptions {
  id: string;
  cols: number;
  rows: number;
  shell?: string;
  term?: string;
  title?: string;
  /** 单个录像的体积上限，超过后停止写入并标记截断（§8）。 */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class CastRecorder {
  private stream?: fs.WriteStream;
  private started = 0;
  private bytes = 0;
  private truncated = false;
  readonly file: string;

  constructor(private opts: RecorderOptions) {
    fs.mkdirSync(CAST_DIR, { recursive: true });
    this.file = path.join(CAST_DIR, `${opts.id}.cast`);
  }

  start(): void {
    if (this.stream) return;
    this.started = Date.now();
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.on('error', () => {
      // 录像写失败不能影响终端本身
      this.stream = undefined;
    });
    const header = {
      version: 2,
      width: this.opts.cols,
      height: this.opts.rows,
      timestamp: Math.floor(this.started / 1000),
      title: this.opts.title,
      env: { SHELL: this.opts.shell, TERM: this.opts.term ?? 'xterm-256color' },
    };
    this.write(`${JSON.stringify(header)}\n`);
  }

  /** 当前写入位置对应的相对毫秒数，用于把事件锚到录像上。 */
  offsetMs(): number {
    return this.started ? Date.now() - this.started : 0;
  }

  data(chunk: string): void {
    if (!this.stream || this.truncated) return;
    const elapsed = (Date.now() - this.started) / 1000;
    this.write(`${JSON.stringify([Number(elapsed.toFixed(6)), 'o', chunk])}\n`);
  }

  resize(cols: number, rows: number): void {
    if (!this.stream || this.truncated) return;
    const elapsed = (Date.now() - this.started) / 1000;
    this.write(`${JSON.stringify([Number(elapsed.toFixed(6)), 'r', `${cols}x${rows}`])}\n`);
  }

  private write(line: string): void {
    const size = Buffer.byteLength(line);
    const max = this.opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (this.bytes + size > max) {
      this.truncated = true;
      this.stream?.write(
        `${JSON.stringify([(Date.now() - this.started) / 1000, 'o', '\r\n[thousandEyes] 录像已达大小上限，停止记录\r\n'])}\n`,
      );
      this.stream?.end();
      this.stream = undefined;
      return;
    }
    this.bytes += size;
    this.stream?.write(line);
  }

  stop(): void {
    this.stream?.end();
    this.stream = undefined;
    // 会话结束是最自然的清理时机；失败也绝不影响 PTY 退出。
    enforceCastRetention();
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }
}
