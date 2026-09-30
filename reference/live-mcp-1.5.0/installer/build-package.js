import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const version = String(manifest.version);
const dist = path.join(root, 'dist');
const stage = path.join(os.tmpdir(), `orbitfs-mcp-package-${process.pid}`);
const output = path.join(dist, `orbitfs-mcp-${version}.ofsaddon`);
const excludedTopLevelDirectories = new Set(['dist', '_backups', 'data', 'logs']);
const canonicalTimestamp = new Date('2020-01-01T00:00:00.000Z');
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
function canonicalizeStage(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { canonicalizeStage(full); fs.utimesSync(full, canonicalTimestamp, canonicalTimestamp); continue; }
    if (!entry.isFile()) continue;
    const bytes = fs.readFileSync(full);
    if (!bytes.includes(0)) {
      try {
        const text = utf8Decoder.decode(bytes);
        const normalized = text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(13)).join(String.fromCharCode(10));
        fs.writeFileSync(full, normalized, 'utf8');
      } catch {}
    }
    fs.utimesSync(full, canonicalTimestamp, canonicalTimestamp);
  }
}


fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(root, stage, {
  recursive: true,
  filter(source) {
    const relative = path.relative(root, source);
    if (!relative) return true;
    const parts = relative.split(path.sep);
    if (parts.length === 1 && ['.orbitfs-config.json', '.orbitfs-install.json', 'README.tmp'].includes(parts[0])) return false;
    if (parts.length && excludedTopLevelDirectories.has(parts[0])) return false;
    const normalized = relative.replace(/\\/g, '/');
    if (normalized === 'engine/data' || normalized.startsWith('engine/data/') || normalized === 'engine/logs' || normalized.startsWith('engine/logs/') || normalized === 'engine/src/data' || normalized.startsWith('engine/src/data/')) return false;
    if (parts.includes('.git')) return false;
    if (parts.includes('node_modules') && parts.includes('.cache')) return false;
    if (/\.bak(?:-|$)/i.test(path.basename(source)) || path.basename(source) === 'ui-tools-snippet.txt') return false;
    return !/\.(tmp|log|orig|patch|patchtmp)$/i.test(source);
  }
 });
canonicalizeStage(stage);
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(output, { force: true });
const escapedStage = stage.replace(/'/g, "''");
const escapedOutput = output.replace(/'/g, "''");
const ps = [
  "Add-Type -AssemblyName System.IO.Compression.FileSystem",
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${escapedStage}','${escapedOutput}',[System.IO.Compression.CompressionLevel]::Optimal,$false)`
].join('; ');
execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });

const bytes = fs.readFileSync(output);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const checksumPath = path.join(dist, 'SHA256SUMS.txt');
fs.writeFileSync(checksumPath, `${sha256}  ${path.basename(output)}\r\n`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  addon: manifest.id,
  version,
  output,
  bytes: bytes.length,
  sha256,
  checksumPath
}, null, 2));
