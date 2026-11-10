// scripts/wizard/interactive.js
// The wizard's interactive flow — create-next-app style:
// banner → numbered steps → arrow-key menu → spinner → done.
// Linear, not a menu you return to. Re-entry via `interactive.js <name> <type>`.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const tui = require('./tui');

const REPO = path.resolve(__dirname, '..', '..');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isWSL = process.platform === 'linux' && fs.existsSync('/mnt/c/Windows');

function copyToClipboard(text) {
    try {
        if (isWin) return spawnSync('clip', [], { input: text }).status === 0;
        if (isWSL) return spawnSync('clip.exe', [], { input: text }).status === 0;
        if (isMac) return spawnSync('pbcopy', [], { input: text }).status === 0;
        if (spawnSync('xclip', ['-selection', 'clipboard'], { input: text }).status === 0) return true;
        return spawnSync('xsel', ['--clipboard', '--input'], { input: text }).status === 0;
    } catch (e) { return false; }
}

function readFromClipboard() {
    try {
        let p;
        if (isWin || isWSL) p = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' });
        else if (isMac) p = spawnSync('pbpaste', [], { encoding: 'utf8' });
        else {
            p = spawnSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' });
            if (p.status !== 0) p = spawnSync('xsel', ['--clipboard', '--output'], { encoding: 'utf8' });
        }
        return p.status === 0 ? (p.stdout || '') : null;
    } catch (e) { return null; }
}

function openUrl(url) {
    try {
        if (isWin) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        else if (isWSL) spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        else if (isMac) spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        return true;
    } catch (e) { return false; }
}

const LLM_PROVIDERS = [
    { value: 'deepseek', label: 'DeepSeek',       hint: 'recommended  ·  chat.deepseek.com', url: 'https://chat.deepseek.com/' },
    { value: 'chatgpt',  label: 'ChatGPT',        hint: 'chat.openai.com',                    url: 'https://chat.openai.com/' },
    { value: 'claude',   label: 'Claude',         hint: 'claude.ai',                          url: 'https://claude.ai/' },
    { value: 'skip',     label: 'Skip browser',   hint: 'I\'ll open it myself' }
];

function stripMarkdownFences(raw) {
    if (!raw) return raw;
    let s = raw.trim();
    s = s.replace(/^```(?:js|javascript|node|mjs|typescript|ts)?\s*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
    return s.trim() + '\n';
}

function looksLikeExtractorCode(src) {
    return Boolean(src && src.length >= 80 && /module\.exports\s*=/.test(src) && /extract\s*[:(]/.test(src));
}

function previewLines(src, n = 4) {
    return src.split('\n').slice(0, n).map((l) => '    ' + l).join('\n');
}

function runVerify(name) {
    return new Promise((resolve) => {
        let output = '';
        const child = spawn('node', [path.join(REPO, 'scripts', 'verify-source.js'), name], {
            cwd: REPO, stdio: ['inherit', 'pipe', 'pipe']
        });
        child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
        child.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
        child.on('exit', (code) => {
            // A working extractor must BOTH exit cleanly AND return at least
            // one item with verdict "ok". verify-source.js exits 0 even for
            // dom_drift_listing / blocked / empty — those are "extractor ran
            // without throwing" signals, not "extractor works" signals.
            const itemsMatch = output.match(/^items: (\d+)/m);
            const verdictMatch = output.match(/^verdict: (\w+)/m);
            const itemCount = itemsMatch ? parseInt(itemsMatch[1], 10) : 0;
            const verdict = verdictMatch ? verdictMatch[1] : null;
            const ok = code === 0 && verdict === 'ok' && itemCount > 0;
            resolve({ code, ok, itemCount, verdict });
        });
    });
}

async function flowPasteAndVerify(ctx, totalSteps, stepOffset) {
    const { name, extractorPath } = ctx;
    const relExtractor = path.relative(REPO, extractorPath);

    tui.step(stepOffset + 1, totalSteps, 'Get the code back from the LLM');
    tui.info('When the LLM finishes, copy its code block (Ctrl/Cmd + A inside the block, then Ctrl/Cmd + C).');
    tui.info('Then come back here.');
    console.log('');
    await tui.waitForEnter('Press Enter when the code is in your clipboard');

    let raw = readFromClipboard();
    let source = 'clipboard';

    if (!raw || raw.trim().length < 50) {
        tui.warn('Clipboard is empty. Paste the code below, then type EOF on its own line:');
        console.log('');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const lines = [];
        while (true) {
            const line = await new Promise((r) => rl.question('  ', r));
            if (line === 'EOF') break;
            lines.push(line);
        }
        rl.close();
        raw = lines.join('\n');
        source = 'manual paste';
    }

    const code = stripMarkdownFences(raw);

    if (!looksLikeExtractorCode(code)) {
        console.log('');
        tui.fail('That doesn\'t look like a valid extractor.');
        tui.info(`Expected a \`module.exports = { ... extract(...) {...} ... }\` shape.`);
        tui.info(`Got ${code.length} chars from ${source}.`);
        console.log('');
        tui.info('First 200 chars:');
        console.log(tui.colors.D + code.slice(0, 200) + tui.colors.R);
        console.log('');
        const retry = await tui.confirm('Try again?', { defaultYes: true });
        if (retry) return flowPasteAndVerify(ctx, totalSteps, stepOffset);
        return { ok: false, reason: 'invalid_code' };
    }

    tui.step(stepOffset + 2, totalSteps, 'Write the code to the extractor');
    console.log('');
    tui.success(`Read ${code.length} chars from ${source} (${code.split('\n').length} lines)`);
    console.log('');
    tui.info('First few lines:');
    console.log(tui.colors.D + previewLines(code) + tui.colors.R);
    console.log('');

    const write = await tui.confirm(`Write to ${relExtractor}?`, { defaultYes: true });
    if (!write) { tui.info('Skipped. Files remain untouched.'); return { ok: false, reason: 'skipped_write' }; }

    try { if (fs.existsSync(extractorPath)) fs.copyFileSync(extractorPath, extractorPath + '.bak'); } catch (e) {}
    fs.writeFileSync(extractorPath, code);
    tui.success(`Wrote ${relExtractor}`);
    tui.info(`(Previous stub backed up as ${relExtractor}.bak)`);

    tui.step(stepOffset + 3, totalSteps, 'Verify against the live site');
    console.log('');
    const sp = tui.spinner('Launching browser, scraping...');
    sp.start();
    const result = await runVerify(name);
    sp.stop(
        result.ok
            ? `Verification passed (${result.itemCount} items, verdict "${result.verdict}")`
            : `Verification failed — verdict: ${result.verdict || 'unknown'}, items: ${result.itemCount}`,
        result.ok
    );

    if (result.ok) {
        tui.step(stepOffset + 4, totalSteps, 'Done');
        console.log('');
        tui.success('Your extractor works against the live site.');
        console.log('');
        tui.info('Files ready to commit:');
        const C = tui.colors.CYAN, R = tui.colors.R;
        console.log(`    ${C}git add src/scrapers/sources/${ctx.type}/${name}.js \\${R}`);
        console.log(`    ${C}        src/scrapers/extractors/${ctx.type}/${name}.js \\${R}`);
        console.log(`    ${C}        src/scrapers/extractors/${ctx.type}/${name}.md${R}`);
        console.log(`    ${C}git commit -m 'feat(scrapers): ${name} ${ctx.type} source'${R}`);
        console.log('');
        return { ok: true };
    }

    console.log('');
    tui.warn('The extractor ran but produced a bad result (see the log above).');
    const choice = await tui.selectMenu([
        { value: 'retry_llm',  label: 'Retry with the LLM',                     hint: 'paste new code' },
        { value: 'regenerate', label: 'Regenerate the prompt with extra notes', hint: 'add hints for the LLM' },
        { value: 'exit',       label: 'Exit — I\'ll fix it manually' }
    ]);
    if (choice === 'retry_llm') return flowPasteAndVerify(ctx, totalSteps, stepOffset);
    if (choice === 'regenerate') {
        const notes = await tui.input('Extra notes for the LLM (e.g. "needs scroll to load")');
        console.log('');
        tui.info(`Re-run: node scripts/wizard/index.js ${ctx.url || '<url>'} ${name} ${ctx.type} --notes "${notes}"`);
        return { ok: false, reason: 'regenerate' };
    }
    return { ok: false, reason: 'user_exit' };
}

async function runInteractive(ctx) {
    const relPrompt = path.relative(REPO, ctx.promptPath);
    tui.banner({ name: ctx.name, type: ctx.type, url: ctx.url || '(from cache)' });

    tui.step(1, 7, 'Files written');
    console.log('');
    tui.success(path.relative(REPO, ctx.wrapperPath));
    tui.info('  source wrapper (5 lines, no editing needed)');
    tui.success(path.relative(REPO, ctx.extractorPath));
    tui.info('  extractor STUB — needs the LLM\'s code');
    tui.success(relPrompt);
    tui.info(`  the prompt for the LLM (${(fs.statSync(ctx.promptPath).size / 1024).toFixed(1)} KB)`);

    tui.step(2, 7, 'Copy the prompt to your clipboard');
    const promptBody = fs.readFileSync(ctx.promptPath, 'utf8');
    const sp1 = tui.spinner('Copying to clipboard...');
    sp1.start();
    await new Promise((r) => setTimeout(r, 200));
    const copied = copyToClipboard(promptBody);
    sp1.stop(copied ? `Copied ${(promptBody.length / 1024).toFixed(1)} KB to clipboard` : 'Clipboard copy failed', copied);
    if (!copied) { tui.warn('Copy manually from: ' + relPrompt); }

    tui.step(3, 7, 'Choose an LLM and open it');
    const provider = await tui.selectMenu(LLM_PROVIDERS, { header: 'Which one?', defaultValue: 0 });
    if (provider !== 'skip') {
        const info = LLM_PROVIDERS.find((p) => p.value === provider);
        const sp2 = tui.spinner(`Opening ${info.label}...`);
        sp2.start();
        await new Promise((r) => setTimeout(r, 300));
        openUrl(info.url);
        sp2.stop(`Opened ${info.label} in your browser`, true);
        tui.info('Paste the prompt in the chat input (Ctrl+V), send, wait for the response.');
    } else {
        tui.info('Skipping browser. Open your own LLM and paste from clipboard.');
    }

    return flowPasteAndVerify({ ...ctx }, 7, 3);
}

async function runStandalone(name, type) {
    const wrapperPath = path.join(REPO, 'src', 'scrapers', 'sources', type, `${name}.js`);
    const extractorPath = path.join(REPO, 'src', 'scrapers', 'extractors', type, `${name}.js`);
    const promptPath = path.join(REPO, 'src', 'scrapers', 'extractors', type, `${name}.md`);
    if (!fs.existsSync(extractorPath) || !fs.existsSync(promptPath)) {
        console.error(`❌ Files for "${name}" (${type}) not found.`);
        console.error(`   Run: node scripts/wizard/index.js <url> ${name} ${type}`);
        process.exit(1);
    }
    tui.banner({ name, type, url: '(re-entry)' });
    tui.info('Re-entering at the paste-code step. Prompt file already exists:');
    tui.info('  ' + path.relative(REPO, promptPath));
    console.log('');
    const copy = await tui.confirm('Copy prompt to clipboard again?', { defaultYes: true });
    if (copy) {
        const body = fs.readFileSync(promptPath, 'utf8');
        if (copyToClipboard(body)) tui.success(`Copied ${(body.length / 1024).toFixed(1)} KB to clipboard`);
        else tui.warn('Clipboard copy failed — copy manually');
    }
    return flowPasteAndVerify({ name, type, wrapperPath, extractorPath, promptPath }, 4, 0);
}

function printManualRecipe(ctx) {
    const relPrompt = path.relative(REPO, ctx.promptPath);
    const relExtractor = path.relative(REPO, ctx.extractorPath);
    console.log('');
    console.log('  MANUAL RECIPE (non-interactive shell)');
    console.log('');
    console.log('  1. Open and copy: ' + relPrompt);
    console.log('  2. Paste into DeepSeek (https://chat.deepseek.com/)');
    console.log('  3. Copy the code block from the response');
    console.log('  4. Save over: ' + relExtractor);
    console.log('  5. Verify: node scripts/verify-source.js ' + ctx.name);
    console.log(`  6. Commit: git add src/scrapers/sources/${ctx.type}/${ctx.name}.js src/scrapers/extractors/${ctx.type}/${ctx.name}.js src/scrapers/extractors/${ctx.type}/${ctx.name}.md`);
    console.log(`            git commit -m 'feat(scrapers): ${ctx.name} ${ctx.type} source'`);
    console.log('');
}

async function runOrFallback(ctx) {
    if (process.stdin.isTTY && process.stdout.isTTY) return runInteractive(ctx);
    printManualRecipe(ctx);
    return { ok: false, reason: 'non_tty' };
}

module.exports = { runInteractive, runStandalone, runOrFallback };

if (require.main === module) {
    const [name, type] = process.argv.slice(2);
    if (!name || !type) { console.error('Usage: node scripts/wizard/interactive.js <name> <type>'); process.exit(1); }
    runStandalone(name, type).catch((e) => { console.error('❌', e.message); process.exit(1); });
}
