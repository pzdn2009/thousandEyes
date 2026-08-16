import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

/**
 * L2 shell 集成：让 shell 主动上报语义标记。spec.md §7 Phase 2。
 *
 * 核心约束：**绝不改写用户的 rc 文件**。
 * 我们只在启动 PTY 时通过参数/环境变量注入一段脚本，脚本第一件事就是加载用户原本的配置。
 * 用户在别处开的 shell 完全不受影响，卸载 thousandEyes 也不留残渣。
 *
 *   zsh   → ZDOTDIR 指向我们的目录，目录里每个 rc 文件都先 source 用户的同名文件
 *   bash  → --init-file 指向我们的脚本，脚本先 source 用户的 rc
 *   fish  → -C 'source 我们的脚本'
 */

const SHELL_DIR = path.join(DATA_DIR, 'shell');

export interface ShellLaunch {
  args: string[];
  env: Record<string, string>;
}

/**
 * 命令原文要塞进 OSC 序列，先把会破坏序列结构的字符转义成 \xNN。
 *
 * 注意：不能用 String.raw —— 它照样会做 ${} 插值，而 shell 的 ${s//...} 会被 JS
 * 当成插值表达式（里面的 // 还会被当成注释），把模板字面量提前截断。
 * 所以这里逐行拼，shell 的 $ 一律显式转义。
 */
const ZSH_BASH_ENCODE = [
  '__te_encode() {',
  '  local s=$1',
  "  s=${s//'\\'/'\\x5c'}",
  "  s=${s//';'/'\\x3b'}",
  "  s=${s//$'\\n'/'\\x0a'}",
  "  s=${s//$'\\r'/'\\x0d'}",
  "  s=${s//$'\\a'/'\\x07'}",
  "  s=${s//$'\\e'/'\\x1b'}",
  '  printf \'%s\' "$s"',
  '}',
  '',
].join('\n');

const ZSH_SCRIPT = `# thousandEyes shell integration (zsh) —— 自动生成，勿手工编辑
# 先加载用户自己的配置，我们的钩子永远挂在最后
if [[ -n "\$TE_USER_ZDOTDIR" && -f "\$TE_USER_ZDOTDIR/.zshrc" ]]; then
  ZDOTDIR="\$TE_USER_ZDOTDIR" source "\$TE_USER_ZDOTDIR/.zshrc"
fi
# 恢复 ZDOTDIR，避免子 shell 继续走我们的目录
[[ -n "\$TE_USER_ZDOTDIR" ]] && export ZDOTDIR="\$TE_USER_ZDOTDIR" || unset ZDOTDIR

if [[ -z "\$TE_INTEGRATION_LOADED" ]]; then
  export TE_INTEGRATION_LOADED=1
${ZSH_BASH_ENCODE}
  __te_preexec() {
    printf '\\033]633;E;%s\\007' "\$(__te_encode "\$1")"
    printf '\\033]133;C\\007'
  }

  __te_precmd() {
    local __te_status=\$?
    printf '\\033]133;D;%s\\007' "\$__te_status"
    printf '\\033]7;file://%s%s\\007' "\${HOST:-localhost}" "\$PWD"
    printf '\\033]133;A\\007'
  }

  autoload -Uz add-zsh-hook 2>/dev/null && {
    add-zsh-hook preexec __te_preexec
    add-zsh-hook precmd __te_precmd
  }
fi
`;

/** zsh 登录流程会依次读 .zshenv/.zprofile/.zshrc/.zlogin，每个都要转发给用户的同名文件。 */
const ZSH_FORWARD = (name: string) => `# thousandEyes —— 转发到用户的 ${name}
if [[ -n "\$TE_USER_ZDOTDIR" && -f "\$TE_USER_ZDOTDIR/${name}" ]]; then
  source "\$TE_USER_ZDOTDIR/${name}"
fi
`;

const BASH_SCRIPT = `# thousandEyes shell integration (bash) —— 自动生成，勿手工编辑
# --init-file 会顶掉默认的 rc 加载，所以这里先手动补回用户的配置
if [ -f ~/.bash_profile ]; then
  . ~/.bash_profile
elif [ -f ~/.bash_login ]; then
  . ~/.bash_login
elif [ -f ~/.profile ]; then
  . ~/.profile
fi
[ -f ~/.bashrc ] && . ~/.bashrc

if [ -z "\$TE_INTEGRATION_LOADED" ]; then
  export TE_INTEGRATION_LOADED=1
${ZSH_BASH_ENCODE}
  __te_at_prompt=1

  # bash 没有 preexec，用 DEBUG trap 模拟：每条命令执行前触发一次
  __te_preexec() {
    [ -n "\$COMP_LINE" ] && return                 # 补全时不算命令
    [ -z "\$__te_at_prompt" ] && return            # 一个提示符只报一次
    __te_at_prompt=
    printf '\\033]633;E;%s\\007' "\$(__te_encode "\$BASH_COMMAND")"
    printf '\\033]133;C\\007'
  }

  __te_precmd() {
    local __te_status=\$?
    printf '\\033]133;D;%s\\007' "\$__te_status"
    printf '\\033]7;file://%s%s\\007' "\${HOSTNAME:-localhost}" "\$PWD"
    printf '\\033]133;A\\007'
    __te_at_prompt=1
    return \$__te_status
  }

  trap '__te_preexec' DEBUG
  PROMPT_COMMAND="__te_precmd\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
fi
`;

const FISH_SCRIPT = `# thousandEyes shell integration (fish) —— 自动生成，勿手工编辑
if not set -q TE_INTEGRATION_LOADED
  set -gx TE_INTEGRATION_LOADED 1

  function __te_encode
    string replace -a '\\\\' '\\\\x5c' -- $argv[1] \\
      | string replace -a ';' '\\\\x3b' \\
      | string replace -a \\n '\\\\x0a'
  end

  function __te_preexec --on-event fish_preexec
    printf '\\033]633;E;%s\\007' (__te_encode "$argv[1]")
    printf '\\033]133;C\\007'
  end

  function __te_postexec --on-event fish_postexec
    printf '\\033]133;D;%s\\007' $status
    printf '\\033]7;file://%s%s\\007' (hostname) $PWD
    printf '\\033]133;A\\007'
  end
end
`;

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return;
    fs.writeFileSync(file, content, { mode: 0o644 });
  } catch {
    // 写不了就退化成无集成的普通终端
  }
}

/** 生成（或刷新）集成脚本，返回所在目录。 */
export function ensureScripts(): string {
  const zshDir = path.join(SHELL_DIR, 'zsh');
  fs.mkdirSync(zshDir, { recursive: true });

  writeIfChanged(path.join(zshDir, '.zshrc'), ZSH_SCRIPT);
  for (const name of ['.zshenv', '.zprofile', '.zlogin']) {
    writeIfChanged(path.join(zshDir, name), ZSH_FORWARD(name));
  }
  writeIfChanged(path.join(SHELL_DIR, 'bash.sh'), BASH_SCRIPT);
  writeIfChanged(path.join(SHELL_DIR, 'fish.fish'), FISH_SCRIPT);
  return SHELL_DIR;
}

/**
 * 按 shell 类型给出启动参数与环境变量。
 * 认不出的 shell 就退化成普通登录 shell——没有命令记录，但终端照常可用。
 */
export function shellLaunch(shell: string, terminalId: string): ShellLaunch {
  ensureScripts();
  const base = path.basename(shell);
  const env: Record<string, string> = {
    THOUSANDEYES_TERM_ID: terminalId,
    TERM_PROGRAM: 'thousandEyes',
  };

  if (base === 'zsh') {
    return {
      args: ['-l'],
      env: {
        ...env,
        // 保存用户原本的 ZDOTDIR，脚本靠它找回用户配置
        TE_USER_ZDOTDIR: process.env.ZDOTDIR ?? process.env.HOME ?? '',
        ZDOTDIR: path.join(SHELL_DIR, 'zsh'),
      },
    };
  }

  if (base === 'bash') {
    return { args: ['--init-file', path.join(SHELL_DIR, 'bash.sh'), '-i'], env };
  }

  if (base === 'fish') {
    return { args: ['-l', '-C', `source ${JSON.stringify(path.join(SHELL_DIR, 'fish.fish'))}`], env };
  }

  return { args: ['-l'], env };
}

/** 仅取环境变量部分（manager 里 spawn 时用）。 */
export function integrationEnv(shell: string, terminalId: string): Record<string, string> {
  return shellLaunch(shell, terminalId).env;
}
