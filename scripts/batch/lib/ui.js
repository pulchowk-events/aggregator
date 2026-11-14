// scripts/batch/lib/ui.js
// Rich, TTY-aware UI primitives for batch commands.
//
// Color rules:
//   - Respects NO_COLOR (off)
//   - Respects FORCE_COLOR (on, even when piped through tee/ccb)
//   - Default: on if stdout is a TTY
//
// Width rules:
//   - termWidth() reads COLUMNS > stdout.columns > 80
//   - boxWidth() clamps to that, capped at 74
//   - On narrow terminals (<40 cols) the box collapses to a simple header
//   - Text inside boxes is truncated with ellipsis, never wraps the frame
//
// Style:
//   - Solid box-drawing borders (╭╮╰╯│─) for banners
//   - Colored progress bars (█░) for multi-item loops
//   - Bright-black (GRAY) for secondary text
//   - Filled background tags (PASS/FAIL/WARN/INFO) for status columns
//   - Emoji-free; geometric + box-drawing only (survives every terminal)

const forceColor = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
const supportsColor = !process.env.NO_COLOR && (Boolean(process.stdout.isTTY) || forceColor);
const isTTY = Boolean(process.stdout.isTTY);

const C = (n) => (supportsColor ? `\x1b[${n}m` : '');
const R = C('0'), B = C('1'), D = C('2'), U = C('4');
const BLACK = C('30'), RED = C('31'), GREEN = C('32'), YELLOW = C('33');
const BLUE = C('34'), MAGENTA = C('35'), CYAN = C('36'), WHITE = C('37');
const GRAY = C('90');
const BG_RED = C('41'), BG_GREEN = C('42'), BG_YELLOW = C('43'), BG_CYAN = C('46');

// ---------- width ----------
function termWidth() {
    const cols = parseInt(process.env.COLUMNS || process.stdout.columns || 80, 10);
    return Math.max(30, cols - 2);
}
function boxWidth() {
    return Math.min(termWidth(), 74);
}
function displayWidth(s) {
    return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Width tiers for responsive layout. Below a threshold, callers should
// switch to multi-line per-item rendering (see resultRow) rather than
// truncate one-line output -- truncation loses info; multi-line preserves
// it and reads cleaner on narrow terminals.
function layoutTier() {
    const W = termWidth();
    if (W >= 80) return 'wide';
    if (W >= 60) return 'medium';
    if (W >= 45) return 'narrow';
    return 'tiny';
}
function truncate(s, max) {
    const plain = String(s).replace(/\x1b\[[0-9;]*m/g, '');
    if (plain.length <= max) return plain;
    if (max <= 1) return '…'.slice(0, max);
    return plain.slice(0, max - 1) + '…';
}

// Fit a list of items into the terminal width. Returns a display string
// that joins as many items as fit, then shows "+N more". Preserves color
// codes if items are colored (assumes items are pre-rendered strings).
// Used by heartbeat output where the number of in-flight sites is
// unbounded -- 10 concurrent sites breaks a 60-col terminal without this.
function fitList(items, { prefix = '', suffix = '', sep = ', ' } = {}) {
    const W = termWidth();
    const avail = W - displayWidth(prefix) - displayWidth(suffix) - 12; // 12 for "+NN more" reserve
    if (avail < 20) return `${prefix}${items.length} item(s)${suffix}`;
    const shown = [];
    let used = 0;
    for (let i = 0; i < items.length; i++) {
        const piece = String(items[i]);
        const pieceLen = displayWidth(piece) + (shown.length > 0 ? displayWidth(sep) : 0);
        if (used + pieceLen > avail) {
            const remaining = items.length - i;
            if (remaining > 0) shown.push(`+${remaining} more`);
            break;
        }
        shown.push(piece);
        used += pieceLen;
    }
    return `${prefix}${shown.join(sep)}${suffix}`;
}

// Wrap a long detail line (warn, error text, failure reason) to the
// terminal width with a continuation indent. The first line has no
// indent (caller usually supplies prefix), continuation lines get
// `indent` spaces. Never truncates -- the whole message survives, it
// just wraps.
// Compact tag for tiny terminals. The full ui.tag() (" PASS " on colored
// background) is 6 display chars; at tiny widths that's stolen budget.
// Tiny tier uses a single glyph instead.
function compactTag(tag) {
    if (!tag) return '';
    if (tag.includes('PASS')) return `${GREEN}✓${R}`;
    if (tag.includes('FAIL')) return `${RED}✗${R}`;
    if (tag.includes('WARN')) return `${YELLOW}!${R}`;
    if (tag.includes('SKIP')) return `${GRAY}·${R}`;
    return tag;
}

// Render one result row, responsive to terminal width. Returns an array
// of lines to print; caller iterates and calls line().
//
// Layouts:
//   wide:    [ts]  tag  name(22)  meta...reason         right
//   medium:  [ts]  tag  name(16)  meta...reason         right
//   narrow:  [ts]  tag  name
//                   meta · right
//                   └ reason
//   tiny:    ✓ name
//              meta · right · reason
//
// reason: omit "ok"/"pass" -- the tag already conveys pass/fail.
//         Non-trivial reasons appear inline (wide/medium) or as a tree
//         continuation (narrow/tiny).
// warn:   always a wrapped continuation line, indented under the row.
function resultRow({ ts = '', tag, name, meta = '', right = '', reason = null, warn = null }) {
    const tier = layoutTier();
    const W = termWidth();
    const lines = [];

    const trivialReason = !reason || reason === 'ok' || reason === 'pass';
    const reasonText = trivialReason ? null : reason;
    const tagDisplay = tier === 'tiny' ? compactTag(tag) : tag;
    const tsPart = ts ? ts + '  ' : '';

    if (tier === 'wide' || tier === 'medium') {
        const nameW = tier === 'wide' ? 22 : 16;
        const namePadded = name.length > nameW ? name.slice(0, nameW - 1) + '…' : name.padEnd(nameW);
        const head = `  ${tsPart}${tagDisplay}  ${namePadded}  ${meta}`;
        const headLen = displayWidth(head);
        const rightLen = displayWidth(right || '');
        const reasonW = reasonText ? displayWidth(reasonText) + 3 : 0;
        const gap = Math.max(2, W - headLen - reasonW - rightLen);
        let lineStr = head;
        if (reasonText) lineStr += ` · ${reasonText}`;
        lineStr += ' '.repeat(gap) + (right || '');
        lines.push(lineStr);
        if (warn) {
            const wrapped = wrapDetail(warn, { indent: 8 });
            for (const l of wrapped.split('\n')) {
                lines.push(`        ${GRAY}${l}${R}`);
            }
        }
    } else if (tier === 'narrow') {
        lines.push(`  ${tsPart}${tagDisplay}  ${name}`);
        const bits = [meta, right].filter(Boolean).join(' · ');
        if (bits) lines.push(`${GRAY}        ${bits}${R}`);
        if (reasonText) lines.push(`${GRAY}        └ ${reasonText}${R}`);
        if (warn) {
            const wrapped = wrapDetail(warn, { indent: 10 });
            for (const l of wrapped.split('\n')) {
                lines.push(`${GRAY}          ${l}${R}`);
            }
        }
    } else {
        lines.push(`${tagDisplay} ${name}`);
        const bits = [reasonText, meta, right].filter(Boolean).join(' · ');
        if (bits) lines.push(`${GRAY}  ${bits}${R}`);
        if (warn) {
            const wrapped = wrapDetail(warn, { indent: 4 });
            for (const l of wrapped.split('\n')) {
                lines.push(`${GRAY}    ${l}${R}`);
            }
        }
    }

    return lines;
}

function wrapDetail(text, { indent = 8, maxWidth = null } = {}) {
    const plain = String(text || '');
    const W = maxWidth || (termWidth() - indent);
    if (plain.length <= W) return plain;
    const words = plain.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
        if ((cur + ' ' + w).trim().length > W && cur.length > 0) {
            lines.push(cur);
            cur = w;
        } else {
            cur = (cur ? cur + ' ' : '') + w;
        }
    }
    if (cur) lines.push(cur);
    return lines.join('\n' + ' '.repeat(indent));
}

// ---------- primitives ----------
function line(text) { process.stdout.write(text + '\n'); }
function blank() { process.stdout.write('\n'); }

// ---------- banner ----------
function banner({ title, sub, subShort, note }) {
    const tier = layoutTier();
    const W = termWidth();
    const ruleWidth = Math.min(W, 72);
    blank();
    line(`${CYAN}▶${R} ${B}${truncate(title, W - 3)}${R}`);
    line(`${GRAY}${'─'.repeat(ruleWidth)}${R}`);
    if (sub) {
        // Narrow/tiny use subShort (caller-compressed). Wide/medium
        // show the full sub.
        const text = (tier === 'narrow' || tier === 'tiny') && subShort ? subShort : sub;
        line(`${GRAY}${truncate(text, W - 1)}${R}`);
    }
    if (note) line(`${truncate(note, W - 1)}`);
    blank();
}

// ---------- progress bar ----------
function progressBar(current, total, width) {
    width = width || Math.min(24, Math.max(12, boxWidth() - 40));
    const pct = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
    const filled = Math.round(pct * width);
    const empty = Math.max(0, width - filled);
    return `${GREEN}${'█'.repeat(filled)}${GRAY}${'░'.repeat(empty)}${R}`;
}

function stepLine(n, total, label, note) {
    const bar = progressBar(n, total);
    const counter = `${GRAY}${String(n).padStart(2)}/${String(total).padStart(2)}${R}`;
    const noteStr = note ? `  ${GRAY}${note}${R}` : '';
    line(`  ${bar} ${counter}  ${B}${label}${R}${noteStr}`);
}

// ---------- divider ----------
function divider(label) {
    const W = boxWidth();
    if (!label) { line(`${GRAY}${'─'.repeat(W)}${R}`); return; }
    const text = ` ${label} `;
    const tlen = displayWidth(text);
    if (tlen + 2 >= W) { line(`${CYAN}▸${R} ${B}${truncate(text.trim(), W - 3)}${R}`); return; }
    const left = Math.floor((W - tlen) / 2);
    const right = W - tlen - left;
    line(`${GRAY}${'─'.repeat(left)}${B}${CYAN}${text}${R}${GRAY}${'─'.repeat(right)}${R}`);
}

// ---------- waiting for ----------
function waitingFor(what, abortHint) {
    blank();
    line(`  ${MAGENTA}▸${R} ${GRAY}waiting for:${R} ${B}${what}${R}`);
    if (abortHint) line(`    ${GRAY}${abortHint}${R}`);
    blank();
}

// ---------- spinner ----------
function spinner(text) {
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let interval = null;
    let heartbeat = null;
    let i = 0;
    let current = text;
    return {
        start() {
            if (!isTTY) {
                line(`  ${GRAY}${current}${R}`);
                heartbeat = setInterval(() => {
                    process.stdout.write(`${GRAY}.${R}`);
                }, 5000);
                return;
            }
            process.stdout.write('\x1b[?25l');
            interval = setInterval(() => {
                process.stdout.write(`\r  ${CYAN}${frames[i++ % frames.length]}${R}  ${current}`);
            }, 80);
        },
        update(t) { current = t; },
        stop(finalText, ok = true) {
            if (interval) clearInterval(interval);
            if (heartbeat) { clearInterval(heartbeat); if (!isTTY) process.stdout.write('\n'); }
            interval = null;
            heartbeat = null;
            if (isTTY) {
                process.stdout.write('\r\x1b[2K');
                process.stdout.write('\x1b[?25h');
            }
            const marker = ok ? `${GREEN}✓${R}` : `${RED}✗${R}`;
            line(`  ${marker}  ${finalText || current}`);
        }
    };
}

// ---------- filled-background tags ----------
function tag(kind) {
    const map = {
        pass: `${BG_GREEN}${B} PASS ${R}`,
        fail: `${BG_RED}${B} FAIL ${R}`,
        skip: `${GRAY} SKIP ${R}`,
        warn: `${BG_YELLOW}${B} WARN ${R}`,
        info: `${BG_CYAN}${B} INFO ${R}`,
        wait: `${MAGENTA}${B} WAIT ${R}`
    };
    return map[kind] || `${GRAY} ? ${R}`;
}

// ---------- summary ----------
function summary(pairs) {
    const maxLabel = Math.max(0, ...pairs.map(([k]) => displayWidth(k)));
    for (const [label, value] of pairs) {
        const pad = maxLabel - displayWidth(label);
        line(`  ${GRAY}${label}${' '.repeat(pad)}${R}  ${value}`);
    }
}

// ---------- status helpers ----------
const ok = (msg) => line(`  ${GREEN}✓${R}  ${msg}`);
const fail = (msg) => line(`  ${RED}✗${R}  ${msg}`);
const warn = (msg) => line(`  ${YELLOW}!${R}  ${msg}`);
const info = (msg) => line(`  ${GRAY}${msg}${R}`);
const plain = (msg) => line(`  ${msg}`);
const action = (msg) => line(`  ${CYAN}▸${R}  ${msg}`);

// ---------- inline prompt ----------
function ask(question) {
    if (!isTTY) return Promise.resolve('');
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`  ${CYAN}?${R} ${question} `, (a) => {
            rl.close();
            resolve(a);
        });
    });
}

module.exports = {
    supportsColor,
    forceColor,
    colors: { R, B, D, U, BLACK, RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN, WHITE, GRAY, BG_RED, BG_GREEN, BG_YELLOW, BG_CYAN },
    isTTY,
    termWidth,
    boxWidth,
    displayWidth,
    truncate,
    line, blank,
    banner, tag, stepLine, progressBar, waitingFor, spinner, divider, summary, ask,
    ok, fail, warn, info, plain, action,
    layoutTier, resultRow, compactTag,
    fitList, wrapDetail
};
