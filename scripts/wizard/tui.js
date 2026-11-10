// scripts/wizard/tui.js
// Minimal terminal UI primitives — arrow-key menus, spinners, confirms.
// Plain Node core, no dependencies. Falls back to plain prompts on non-TTY.

const readline = require('readline');

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (code) => (supportsColor ? `\x1b[${code}m` : '');
const R = esc('0'), B = esc('1'), D = esc('2');
const RED = esc('31'), GREEN = esc('32'), YELLOW = esc('33');
const MAGENTA = esc('35'), CYAN = esc('36');
const HIDE_CURSOR = '\x1b[?25l', SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K', MOVE_UP = (n) => `\x1b[${n}A`;

const DIAMOND = '◆', CHECK = '✓', CROSS = '✗', ARROW = '❯';

function banner({ name, type, url }) {
    const width = 66;
    const line = `${CYAN}╭${'─'.repeat(width - 2)}╮${R}`;
    const empty = `${CYAN}│${' '.repeat(width - 2)}│${R}`;
    const row = (content) => {
        const visible = content.replace(/\x1b\[[0-9;]*m/g, '');
        const pad = width - 2 - visible.length;
        return `${CYAN}│ ${R}${content}${' '.repeat(Math.max(0, pad - 1))}${CYAN}│${R}`;
    };
    console.log('');
    console.log(line);
    console.log(row(`${B}Pulchowk Events — New Source Wizard${R}`));
    console.log(empty);
    console.log(row(`${D}name  ${R}${B}${name}${R}  ${D}type  ${R}${B}${type}${R}`));
    console.log(row(`${D}url   ${R}${url}`));
    console.log(empty);
    console.log(`${CYAN}╰${'─'.repeat(width - 2)}╯${R}`);
    console.log('');
}

function step(n, total, title) {
    console.log('');
    console.log(`${MAGENTA}${DIAMOND}${R} ${B}Step ${n} of ${total}${R}  ${D}${title}${R}`);
    console.log('');
}

const info = (m) => console.log(`  ${D}${m}${R}`);
const success = (m) => console.log(`  ${GREEN}${CHECK}${R} ${m}`);
const fail = (m) => console.log(`  ${RED}${CROSS}${R} ${m}`);
const warn = (m) => console.log(`  ${YELLOW}!${R} ${m}`);
const plain = (m) => console.log(`  ${m}`);

function spinner(initialText) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let i = 0, interval = null, text = initialText;
    return {
        start() {
            if (!process.stdout.isTTY) return;
            process.stdout.write(HIDE_CURSOR);
            interval = setInterval(() => {
                process.stdout.write(`\r${CLEAR_LINE}  ${CYAN}${frames[i++ % frames.length]}${R} ${text}`);
            }, 80);
        },
        update(t) { text = t; },
        stop(finalText, ok = true) {
            if (interval) clearInterval(interval);
            interval = null;
            if (process.stdout.isTTY) {
                process.stdout.write(`\r${CLEAR_LINE}`);
                if (finalText) process.stdout.write(`  ${ok ? `${GREEN}${CHECK}${R}` : `${RED}${CROSS}${R}`} ${finalText}\n`);
                process.stdout.write(SHOW_CURSOR);
            } else if (finalText) console.log(`  ${ok ? CHECK : CROSS} ${finalText}`);
        },
        fail(finalText) { this.stop(finalText, false); }
    };
}

function selectMenu(options, { defaultValue = 0, header = null } = {}) {
    if (!process.stdin.isTTY) return Promise.resolve(options[defaultValue].value);
    return new Promise((resolve) => {
        let selected = defaultValue;
        const stdin = process.stdin, stdout = process.stdout;

        const render = () => {
            stdout.write(MOVE_UP(options.length));
            for (let i = 0; i < options.length; i++) {
                const opt = options[i];
                const active = i === selected;
                const prefix = active ? `${CYAN}${ARROW}${R}` : ' ';
                const label = active ? `${B}${opt.label}${R}` : opt.label;
                const hint = opt.hint ? `  ${D}${opt.hint}${R}` : '';
                stdout.write(`\r${CLEAR_LINE}  ${prefix} ${label}${hint}\n`);
            }
        };

        if (header) console.log(`  ${D}${header}${R}`);
        for (let i = 0; i < options.length; i++) {
            const opt = options[i], active = i === selected;
            const prefix = active ? `${CYAN}${ARROW}${R}` : ' ';
            const label = active ? `${B}${opt.label}${R}` : opt.label;
            const hint = opt.hint ? `  ${D}${opt.hint}${R}` : '';
            stdout.write(`  ${prefix} ${label}${hint}\n`);
        }
        stdout.write(HIDE_CURSOR);

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        readline.emitKeypressEvents(stdin);

        const onKey = (str, key) => {
            if (key.name === 'up' || key.name === 'k') {
                selected = (selected - 1 + options.length) % options.length;
                render();
            } else if (key.name === 'down' || key.name === 'j') {
                selected = (selected + 1) % options.length;
                render();
            } else if (key.name === 'return') {
                stdout.write(SHOW_CURSOR + '\n');
                stdin.setRawMode(false);
                stdin.removeListener('keypress', onKey);
                resolve(options[selected].value);
            } else if (key.ctrl && key.name === 'c') {
                stdout.write(SHOW_CURSOR + R + '\n');
                stdin.setRawMode(false);
                process.exit(0);
            }
        };
        stdin.on('keypress', onKey);
    });
}

function confirm(question, { defaultYes = true } = {}) {
    if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = defaultYes ? `${D}[Y/n]${R}` : `${D}[y/N]${R}`;
    return new Promise((resolve) => {
        rl.question(`  ${CYAN}?${R} ${question} ${suffix} `, (answer) => {
            rl.close();
            const a = (answer || '').trim().toLowerCase();
            if (!a) return resolve(defaultYes);
            resolve(a === 'y' || a === 'yes');
        });
    });
}

function input(question, { defaultValue = '' } = {}) {
    if (!process.stdin.isTTY) return Promise.resolve(defaultValue);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const hint = defaultValue ? ` ${D}(${defaultValue})${R}` : '';
    return new Promise((resolve) => {
        rl.question(`  ${CYAN}?${R} ${question}${hint} `, (answer) => {
            rl.close();
            resolve((answer || '').trim() || defaultValue);
        });
    });
}

function waitForEnter(message) {
    if (!process.stdin.isTTY) return Promise.resolve();
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`  ${CYAN}›${R} ${message} `, () => { rl.close(); resolve(); });
    });
}

module.exports = {
    banner, step, info, success, fail, warn, plain,
    spinner, selectMenu, confirm, input, waitForEnter,
    colors: { R, B, D, RED, GREEN, YELLOW, MAGENTA, CYAN }
};
