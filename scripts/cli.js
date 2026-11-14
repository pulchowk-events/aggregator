#!/usr/bin/env node
//
// pulchowk-events — CLI for the Pulchowk Events Aggregator bot.
//
// This file is only a dispatcher. Every subcommand is a thin subprocess
// wrapper around an existing script so the interactive TUI, clipboard
// integration, and signal handling work identically to running the script
// directly. There is no shared state between subcommands and no daemon
// mode — one command, one process, one task.
//
// Installed via `npm link` (dev) or `npm install -g .` (prod). Also
// callable without installing: `node scripts/cli.js <cmd>`.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PACKAGE = require(path.join(REPO, 'package.json'));
const VERSION = PACKAGE.version || '0.0.0';

// ---------- ANSI ----------
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (c) => (supportsColor ? `\x1b[${c}m` : '');
const R = esc('0'), B = esc('1'), D = esc('2');
const RED = esc('31'), GREEN = esc('32'), YELLOW = esc('33'), CYAN = esc('36');

// ---------- help ----------
function printHelp() {
    const w = 16;
    const pad = (s) => s.padEnd(w);
    console.log('');
    console.log(`${B}pulchowk-events${R} ${D}v${VERSION}${R}`);
    console.log(`${D}CLI for the Pulchowk Events Aggregator bot.${R}`);
    console.log('');
    console.log(`${B}USAGE${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} <command> [options]`);
    console.log('');
    console.log(`${B}COMMANDS${R}`);
    console.log(`  ${pad(`${CYAN}add${R} <url>`)}  Scaffold a new scraper source (guided, LLM-assisted)`);
    console.log(`  ${pad(`${CYAN}fix${R} [name]`)}     Diagnose drift and auto-fix if unambiguous`);
    console.log(`  ${pad(`${CYAN}diagnose${R} <name>`)} Run selector + extractor diagnosis for one source`);
    console.log(`  ${pad(`${CYAN}verify${R} <name>`)}   Run one source's extractor against the live site`);
    console.log(`  ${pad(`${CYAN}setup${R}`)}            Bootstrap a deployment (.env, Discord channels, Supabase)`);
    console.log(`  ${pad(`${CYAN}help${R}`)}             Show this help`);
    console.log(`  ${pad(`${CYAN}version${R}`)}          Print the version and exit`);
    console.log('');
    console.log(`${B}EXAMPLES${R}`);
    console.log(`  ${D}# Scaffold a new events source from a listing URL${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} add https://example.com/events --type events`);
    console.log('');
    console.log(`  ${D}# Sweep every source, auto-fix what's unambiguously broken${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} fix`);
    console.log('');
    console.log(`  ${D}# Diagnose one source, showing which selectors broke${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} diagnose sathijob --full`);
    console.log('');
    console.log(`  ${D}# Run one source's extractor in isolation${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} verify sathijob`);
    console.log('');
    console.log(`${B}ENVIRONMENT${R}`);
    console.log(`  ${D}NO_COLOR${R}    any non-empty value disables ANSI colors`);
    console.log('');
    console.log(`${B}SEE ALSO${R}`);
    console.log(`  ${D}CONTRIBUTING.md${R}, ${D}docs/architecture.md${R}, ${D}docs/scrapers.md${R}`);
    console.log('');
}

// ---------- version ----------
function printVersion() {
    console.log(VERSION);
}

// ---------- subprocess wrappers ----------
// `scriptPath` is relative to scripts/. `stdio: 'inherit'` passes the
// terminal's stdin/stdout/stderr through so interactive TUI, spinners,
// and prompts all work exactly as they do when running the script
// directly. Extra args are forwarded unchanged.
function runScript(scriptPath, args, { useSpawnSync = true } = {}) {
    const fullPath = path.join(__dirname, scriptPath);
    if (!fs.existsSync(fullPath)) {
        console.error(`${RED}✗ internal error${R}: script not found: ${scriptPath}`);
        return 1;
    }
    if (useSpawnSync) {
        const r = spawnSync('node', [fullPath, ...args], { stdio: 'inherit' });
        return r.status === null ? 1 : r.status;
    }
    const child = spawn('node', [fullPath, ...args], { stdio: 'inherit' });
    // Forward signals to the child so Ctrl-C works.
    const forward = (sig) => { try { child.kill(sig); } catch (_) {} };
    process.on('SIGINT', () => forward('SIGINT'));
    process.on('SIGTERM', () => forward('SIGTERM'));
    child.on('exit', (code) => process.exit(code === null ? 0 : code));
    return 0; // actual exit is deferred to the child's exit event
}

// ---------- subcommands ----------
function cmdAdd(args) {
    // `add` needs at minimum a URL. The wizard itself validates the rest
    // and prompts for missing values — we don't duplicate that logic here.
    if (args.length === 0 || args[0].startsWith('-')) {
        console.error(`${RED}✗ add${R}: missing <url>`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} add <url> [name] [type] [--profile] [--notes "..."]`);
        console.error(`   example: ${CYAN}pulchowk-events${R} add https://example.com/events --type events`);
        return 1;
    }
    return runScript('wizard/index.js', args);
}

function cmdFix(args) {
    // Accepts: no args (interactive picker), one name (targeted), or "all".
    // All extra flags (--full, --apply) forwarded unchanged.
    return runScript('wizard/fix.js', args);
}

function cmdDiagnose(args) {
    if (args.length === 0 || args[0].startsWith('-')) {
        console.error(`${RED}✗ diagnose${R}: missing <name>`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} diagnose <name> [--full] [--url <url>] [--json]`);
        console.error(`   example: ${CYAN}pulchowk-events${R} diagnose sathijob`);
        return 1;
    }
    return runScript('diagnose.js', args);
}

function cmdVerify(args) {
    if (args.length === 0) {
        console.error(`${RED}✗ verify${R}: missing <name>`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} verify <name>`);
        return 1;
    }
    return runScript('verify-source.js', args);
}

function cmdSetup(args) {
    return runScript('setup/index.js', args);
}

// ---------- dispatch ----------
function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        printHelp();
        return 0;
    }
    const [command, ...rest] = argv;

    // Global flags that don't need a subcommand
    if (command === '--version' || command === '-v' || command === 'version') {
        printVersion();
        return 0;
    }
    if (command === '--help' || command === '-h' || command === 'help') {
        printHelp();
        return 0;
    }

    switch (command) {
        case 'add':      return cmdAdd(rest);
        case 'fix':      return cmdFix(rest);
        case 'diagnose': return cmdDiagnose(rest);
        case 'verify':   return cmdVerify(rest);
        case 'setup':    return cmdSetup(rest);
        default:
            console.error(`${RED}✗ unknown command${R}: "${command}"`);
            console.error(`   run ${CYAN}pulchowk-events help${R} to see available commands`);
            return 1;
    }
}

process.exit(main());
