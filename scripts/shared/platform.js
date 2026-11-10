// scripts/shared/platform.js
// Cross-platform helpers shared by the new-source wizard and the setup
// wizard: clipboard read/write, URL opening, OS detection.

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isWSL = process.platform === 'linux' && fs.existsSync('/mnt/c/Windows');
const isLinux = process.platform === 'linux' && !isWSL;

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

module.exports = { isWin, isMac, isWSL, isLinux, copyToClipboard, readFromClipboard, openUrl };
