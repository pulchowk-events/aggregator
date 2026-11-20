#!/usr/bin/env node
//
// pulchowk-events — CLI for the Pulchowk Events Aggregator repository.
//
// This file is only a dispatcher. Every subcommand is a thin subprocess
// wrapper around an existing script so the interactive TUI, clipboard
// integration, and signal handling work identically to running the script
// directly. There is no shared state between subcommands and no daemon
// mode — one command, one process, one task.
//
// Link this checkout with `npm link` to expose the command on PATH. The bot
// runtime remains available through `npm start` and is intentionally separate.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PACKAGE = require(path.join(REPO, 'package.json'));
const VERSION = PACKAGE.version || '0.0.0';

const MAINTENANCE_COMMANDS = {
    checkpoint: {
        script: 'maintenance/checkpoint.js',
        usage: 'checkpoint <save <name>|list|diff <id>|import <dir> <name>|restore <id> [--dry-run|--confirm <id>] [--force]',
        description: 'Save, inspect, import, or restore a protected data checkpoint'
    },
    migrate: {
        script: 'maintenance/migrate-from-legacy.js',
        usage: 'migrate --from <legacy-repo> [--dry-run|--confirm]',
        description: 'Copy legacy cache, audit, and marker files into data/'
    },
    'clean-erasmus': {
        script: 'maintenance/clean-erasmus.js',
        usage: 'clean-erasmus [--dry-run|--confirm]',
        description: 'Remove Erasmus Mundus scholarships from cache and markers'
    },
    'clean-scholarships': {
        script: 'maintenance/clean-scholorship.js',
        usage: 'clean-scholarships --confirm',
        description: 'Remove all scholarship records from the local cache (destructive)'
    },
    'cleanup-warnings': {
        script: 'maintenance/cleanup-warnings.js',
        usage: 'cleanup-warnings --confirm',
        description: 'Deduplicate pending-item quality warnings in the local cache'
    }
};

// ---------- ANSI ----------
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (c) => (supportsColor ? `\x1b[${c}m` : '');
const R = esc('0'), B = esc('1'), D = esc('2');
const RED = esc('31'), GREEN = esc('32'), YELLOW = esc('33'), CYAN = esc('36');

// ---------- help ----------
function printHelp() {
    const commands = [
        ['add <url>', 'Create a scraper source; --type is required, name defaults from URL'],
        ['fix [name|all]', 'Diagnose drift and fix unambiguous selector changes'],
        ['diagnose <name>', 'Inspect selectors; supports --full, --all, --url, --json, --fix, --apply'],
        ['verify <name>', 'Run one scraper against its live site'],
        ['setup', 'Bootstrap a deployment; supports --demo and --resume'],
        ['batch <command>', 'Run a batch workflow; use "batch help" for every phase'],
        ['placeholders [options]', 'Generate missing scraper placeholder images'],
        ['simulate [sources] [options]', 'Simulate scraping; webhook sends require --send'],
        ['test-send [options]', 'Test Discord rendering; webhook sends require --send'],
        ['maintenance <task>', 'Run a checkpoint, migration, or cache-maintenance tool'],
        ['test', 'Run the repository Node.js test suite'],
        ['help [command]', 'Show general or command-specific help'],
        ['version', 'Print the package version']
    ];
    const width = Math.max(...commands.map(([name]) => name.length));
    console.log('');
    console.log(`${B}pulchowk-events${R} ${D}v${VERSION}${R}`);
    console.log(`${D}CLI for repository utilities; the bot runtime remains a separate process.${R}`);
    console.log('');
    console.log(`${B}USAGE${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} <command> [arguments] [options]`);
    console.log('');
    console.log(`${B}COMMANDS${R}`);
    for (const [name, description] of commands) {
        console.log(`  ${CYAN}${name.padEnd(width)}${R}  ${description}`);
    }
    console.log('');
    console.log(`${B}EXAMPLES${R}`);
    console.log(`  ${D}# Create a source; the name is inferred from the URL unless supplied${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} add https://example.com/events --type events`);
    console.log('');
    console.log(`  ${D}# Sweep every source, or target one by name${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} fix`);
    console.log('');
    console.log(`  ${D}# Show command-specific options${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} diagnose --help`);
    console.log('');
    console.log(`  ${D}# Run an end-to-end batch; use --skip-deploy to prevent file deployment${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} batch run urls.txt --run mybatch --skip-deploy`);
    console.log('');
    console.log(`  ${D}# Preview a scrape without sending webhook messages${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} simulate --dry`);
    console.log('');
    console.log(`${B}ENVIRONMENT${R}`);
    console.log(`  ${D}NO_COLOR${R}  any non-empty value disables ANSI colors`);
    console.log('');
    console.log(`${B}SEE ALSO${R}`);
    console.log(`  ${D}CONTRIBUTING.md${R}, ${D}docs/scrapers.md${R}, ${D}docs/batch.md${R}, ${D}docs/operations.md${R}`);
    console.log('');
}

function printCommandHelp(command) {
    const usage = {
        add: [
            'Usage: pulchowk-events add <url> --type <events|jobs|scholarships> [name] [options]',
            '',
            'Options:',
            '  --name <name>       Source slug (defaults to a collision-free name derived from URL)',
            '  --type <type>       Required source type: events, jobs, or scholarships',
            '  --profile           Use the warm browser profile (Windows only; stop the bot first)',
            '  --notes <text>      Add site-specific hints to the LLM prompt',
            '  --no-interactive    Skip the guided LLM handoff after scaffolding',
            '',
            'The legacy positional form <url> <name> <type> is also accepted.'
        ],
        fix: [
            'Usage: pulchowk-events fix [name|all] [--full] [--apply]',
            '',
            'Without a name, opens an interactive source picker. "all" sweeps every source.',
            '--full runs the extractor during diagnosis; --apply applies unambiguous fixes.'
        ],
        diagnose: [
            'Usage: pulchowk-events diagnose <name> [--full] [--url <url>] [--json] [--fix [--apply]]',
            '       pulchowk-events diagnose --all [--full]',
            '',
            '--full runs the extractor; --fix shows selector suggestions; --apply writes fixes.'
        ],
        verify: [
            'Usage: pulchowk-events verify <name>',
            '',
            'Runs one source extractor against its live site and prints a sample.'
        ],
        setup: [
            'Usage: pulchowk-events setup [--demo] [--resume]',
            '',
            '--demo walks through setup with mock data and writes data/demo-setup.env.',
            '--resume uses values already present in .env.'
        ],
        batch: [
            'Usage: pulchowk-events batch <command> [options]',
            '',
            'Run "pulchowk-events batch help" for the list of batch commands and flags.'
        ],
        placeholders: [
            'Usage: pulchowk-events placeholders [--only <name1,name2>] [--force]',
            '',
            'Generate missing placeholder images under assets/placeholders/. Existing images are skipped unless --force is used.'
        ],
        simulate: [
            'Usage: pulchowk-events simulate [source1,source2] [--dry|--send]',
            '',
            '--dry prints samples without sending. This is the default.',
            '--send permits sample messages to be sent to data/test-webhook.txt.',
            'Without a source list, the script uses its built-in sample sources.'
        ],
        'test-send': [
            'Usage: pulchowk-events test-send [--source <name>|--image <url>] [--mode <diagnostic|live>] [--webhook <url>] [--dry|--send]',
            '',
            '--dry builds and prints the payload without sending. This is the default.',
            '--send permits one message to be sent to the configured test webhook.',
            'A --source run scrapes the source even in dry mode; --image does not scrape.'
        ],
        maintenance: [
            'Usage: pulchowk-events maintenance <task> [options]',
            '',
            ...Object.entries(MAINTENANCE_COMMANDS).map(([task, { description }]) => `  ${task.padEnd(22)} ${description}`),
            '',
            'Run "pulchowk-events maintenance <task> --help" for task-specific usage.',
            'Cache-changing tasks require --confirm. Stop the bot and make a backup before maintenance.'
        ],
        test: [
            'Usage: pulchowk-events test [test-file ...]',
            '',
            'Runs all *.test.js files under scripts/, or only the supplied test files.',
            'Focused paths must name existing *.test.js files under scripts/.'
        ]
    };
    const lines = usage[command];
    if (!lines) return false;
    console.log(lines.join('\n'));
    console.log('');
    return true;
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
function runScript(scriptPath, args) {
    const fullPath = path.join(__dirname, scriptPath);
    if (!fs.existsSync(fullPath)) {
        console.error(`${RED}✗ internal error${R}: script not found: ${scriptPath}`);
        return 1;
    }
    const r = spawnSync(process.execPath, [fullPath, ...args], { stdio: 'inherit', cwd: REPO });
    if (r.error) {
        console.error(`${RED}✗ failed to start${R} ${scriptPath}: ${r.error.message}`);
        return 1;
    }
    return r.status === null ? 1 : r.status;
}

function printMaintenanceHelp(task) {
    const command = MAINTENANCE_COMMANDS[task];
    if (!command) return false;
    console.log(`Usage: pulchowk-events maintenance ${command.usage}`);
    console.log('');
    console.log(command.description);
    if (task === 'checkpoint') {
        console.log('Restore is a dry run unless --confirm <full-checkpoint-id> is supplied.');
        console.log('The restore tool refuses to run while the bot is active unless --force is supplied.');
    } else if (task === 'migrate') {
        console.log('Stop the bot first. --dry-run previews; --confirm is required to copy files.');
    } else if (task === 'clean-erasmus') {
        console.log('Stop the bot first. --dry-run previews; --confirm is required to modify data.');
    } else if (task === 'clean-scholarships') {
        console.log('Stop the bot and back up data/cache.json first. This legacy script has no dry-run mode.');
    } else if (task === 'cleanup-warnings') {
        console.log('Stop the bot and back up data/cache.json first. This script writes the cache directly.');
    }
    console.log('');
    return true;
}

function cmdPlaceholders(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('placeholders');
        return 0;
    }
    return runScript('generate-placeholders.js', args);
}

function cmdWebhookUtility(script, args, helpCommand, commandName) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp(helpCommand);
        return 0;
    }
    const send = args.includes('--send');
    const dry = args.includes('--dry');
    if (send && dry) {
        console.error(`${RED}✗ ${commandName}${R}: choose either --dry or --send, not both`);
        return 1;
    }
    const forwarded = args.filter((arg) => arg !== '--send');
    if (!send && !dry) forwarded.push('--dry');
    return runScript(script, forwarded);
}

function cmdMaintenance(args) {
    const [task, ...rest] = args;
    if (!task || task === 'help' || task === '-h' || task === '--help') {
        printCommandHelp('maintenance');
        return 0;
    }
    const command = MAINTENANCE_COMMANDS[task];
    if (!command) {
        console.error(`${RED}✗ maintenance${R}: unknown task "${task}"`);
        console.error(`   run ${CYAN}pulchowk-events maintenance --help${R} for available tasks`);
        return 1;
    }
    if (rest.includes('-h') || rest.includes('--help')) {
        printMaintenanceHelp(task);
        return 0;
    }

    if (task === 'checkpoint') return runScript(command.script, rest);

    const dryRunSupported = task === 'migrate' || task === 'clean-erasmus';
    const dryRun = rest.includes('--dry-run');
    const confirmed = rest.includes('--confirm');
    if (dryRun && !dryRunSupported) {
        console.error(`${RED}✗ maintenance ${task}${R}: --dry-run is not supported by this task`);
        return 1;
    }
    if (dryRun && confirmed) {
        console.error(`${RED}✗ maintenance ${task}${R}: choose either --dry-run or --confirm, not both`);
        return 1;
    }
    if (!dryRun && !confirmed) {
        console.error(`${RED}✗ maintenance ${task}${R}: this task can change local data; stop the bot, back up data/, then pass --confirm`);
        return 1;
    }
    const forwarded = rest.filter((arg) => arg !== '--confirm');
    return runScript(command.script, forwarded);
}

function collectTestFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) collectTestFiles(fullPath, out);
        else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(fullPath);
    }
    return out;
}

function cmdTest(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('test');
        return 0;
    }
    const available = collectTestFiles(path.join(REPO, 'scripts')).sort();
    if (!available.length) {
        console.error(`${RED}✗ test${R}: no *.test.js files found under scripts/`);
        return 1;
    }
    const availableSet = new Set(available.map((file) => path.resolve(file)));
    let files = available;
    if (args.length) {
        files = [];
        for (const arg of args) {
            const candidate = path.resolve(REPO, arg);
            if (!availableSet.has(candidate)) {
                console.error(`${RED}✗ test${R}: not a repository test file: "${arg}"`);
                console.error(`   pass an existing *.test.js path under scripts/`);
                return 1;
            }
            files.push(candidate);
        }
    }
    const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: REPO });
    if (result.error) {
        console.error(`${RED}✗ failed to start test runner${R}: ${result.error.message}`);
        return 1;
    }
    return result.status === null ? 1 : result.status;
}

// ---------- subcommands ----------
function cmdAdd(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('add');
        return 0;
    }

    const positional = [];
    const wizardArgs = [];
    let name = null;
    let type = null;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--name' || arg === '--type' || arg === '--notes') {
            const value = args[++i];
            if (!value || value.startsWith('--')) {
                console.error(`${RED}✗ add${R}: ${arg} requires a value`);
                return 1;
            }
            if (arg === '--name') name = value;
            else if (arg === '--type') type = value;
            else wizardArgs.push(arg, value);
        } else if (arg === '--profile' || arg === '--no-interactive') {
            wizardArgs.push(arg);
        } else if (arg.startsWith('-')) {
            console.error(`${RED}✗ add${R}: unknown option "${arg}"`);
            console.error(`   run ${CYAN}pulchowk-events add --help${R} for usage`);
            return 1;
        } else {
            positional.push(arg);
        }
    }

    const url = positional[0];
    name = name || positional[1] || null;
    type = type || positional[2] || null;
    if (positional.length > 3) {
        console.error(`${RED}✗ add${R}: unexpected positional argument "${positional[3]}"`);
        console.error(`   run ${CYAN}pulchowk-events add --help${R} for usage`);
        return 1;
    }
    if (!url || !type) {
        console.error(`${RED}✗ add${R}: URL and --type are required`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} add <url> --type <events|jobs|scholarships> [name]`);
        console.error(`   run ${CYAN}pulchowk-events add --help${R} for options`);
        return 1;
    }
    if (!['events', 'jobs', 'scholarships'].includes(type)) {
        console.error(`${RED}✗ add${R}: invalid type "${type}" (use events, jobs, or scholarships)`);
        return 1;
    }
    if (!name) {
        const { deriveName } = require('./batch/lib/naming');
        const derived = deriveName(url, type);
        if (!derived.name) {
            console.error(`${RED}✗ add${R}: could not derive a source name from URL; pass --name <name>`);
            return 1;
        }
        name = derived.name;
        if (derived.collided) console.log(`Using collision-free source name "${name}".`);
    }
    return runScript('wizard/index.js', [url, name, type, ...wizardArgs]);
}

function cmdFix(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('fix');
        return 0;
    }
    // Accepts: no args (interactive picker), one name (targeted), or "all".
    // All extra flags (--full, --apply) forwarded unchanged.
    return runScript('wizard/fix.js', args);
}

function cmdDiagnose(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('diagnose');
        return 0;
    }
    if (args.length === 0 || (args[0].startsWith('-') && args[0] !== '--all')) {
        console.error(`${RED}✗ diagnose${R}: missing <name>`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} diagnose <name> [--full] [--url <url>] [--json] [--fix [--apply]]`);
        console.error(`          ${CYAN}pulchowk-events${R} diagnose --all [--full]`);
        console.error(`   example: ${CYAN}pulchowk-events${R} diagnose sathijob`);
        return 1;
    }
    return runScript('diagnose.js', args);
}

function cmdVerify(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('verify');
        return 0;
    }
    if (args.length === 0) {
        console.error(`${RED}✗ verify${R}: missing <name>`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} verify <name>`);
        return 1;
    }
    return runScript('verify-source.js', args);
}

function cmdBatch(args) {
    // `batch` is a sub-CLI: init/discover/generate/verify/report/status.
    // Args are forwarded unchanged; the sub-CLI parses them itself.
    return runScript('batch/index.js', args);
}

function cmdSetup(args) {
    if (args.includes('-h') || args.includes('--help')) {
        printCommandHelp('setup');
        return 0;
    }
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
        if (rest.length === 1 && printCommandHelp(rest[0])) return 0;
        printHelp();
        return 0;
    }

    switch (command) {
        case 'add':      return cmdAdd(rest);
        case 'fix':      return cmdFix(rest);
        case 'diagnose': return cmdDiagnose(rest);
        case 'verify':   return cmdVerify(rest);
        case 'batch':    return cmdBatch(rest);
        case 'setup':    return cmdSetup(rest);
        case 'placeholders': return cmdPlaceholders(rest);
        case 'simulate': return cmdWebhookUtility('simulate-scrape.js', rest, 'simulate', 'simulate');
        case 'test-send': return cmdWebhookUtility('test-discord-send.js', rest, 'test-send', 'test-send');
        case 'maintenance': return cmdMaintenance(rest);
        case 'test': return cmdTest(rest);
        default:
            console.error(`${RED}✗ unknown command${R}: "${command}"`);
            console.error(`   run ${CYAN}pulchowk-events help${R} to see available commands`);
            return 1;
    }
}

process.exitCode = main();
