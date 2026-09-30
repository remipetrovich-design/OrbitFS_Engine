import path from 'node:path';
import { pathToFileURL } from 'node:url';

const backendRoot = process.env.ORBITFS_BACKEND_ROOT;
const addonRoot = process.env.ORBITFS_ADDON_ROOT;
if (!backendRoot || !addonRoot) throw new Error('OrbitFS backend/addon paths are required');
const managerUrl = pathToFileURL(path.join(backendRoot, 'addon-manager.js')).href;
const { writeInstallRecord } = await import(managerUrl);
const pluginRoot = path.dirname(addonRoot);
const record = await writeInstallRecord('mcp', pluginRoot, {
  installMethod: 'windows-exe',
  serviceName: process.env.ORBITFS_ADDON_SERVICE || 'OrbitFSMcpServer',
  setupComplete: true
});
console.log(JSON.stringify({ ok: true, id: record.id, version: record.version, sealed: !!record.seal }));
