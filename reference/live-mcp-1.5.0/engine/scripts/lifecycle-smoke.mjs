import * as lifecycle from '../../installer/lifecycle.js';

const calls = [];
let saved = { port: 3939, autoStart: false, publicStorageRoot: 'X:/Test/Public Workspace' };
const record = (name, value = null) => { calls.push({ name, value }); return true; };
const context = {
  addonRoot: 'X:/new install/standalone-addons/MCP',
  storageRoot: 'X:/Test/Public Workspace',
  config: {}, manifest: { id: 'mcp' }, addons: {},
  mysql: { detect: async()=>({installed:true}), install:async(v)=>record('mysql.install',v), start:async()=>record('mysql.start') },
  db: {
    getConnectionConfig: async()=>({host:'127.0.0.1',port:3306,user:'root',password:'secret',database:'orbitfs_test'}),
    ensureDatabase: async(v)=>record('db.ensureDatabase',v),
    execute: async(sql,args)=>record('db.execute',{sql,args}),
    ping: async()=>true
  },
  migrations: {
    applyDirectory: async(v)=>record('migrations.applyDirectory',v),
    purgePrefix: async(v)=>record('migrations.purgePrefix',v)
  },
  configStore: {
    get: async()=>({...saved}),
    merge: async(_id,value)=>{ saved={...saved,...value}; record('config.merge',value); return {...saved}; },
    delete: async(v)=>record('config.delete',v)
  },
  storage: { ensure: async(v)=>record('storage.ensure',v) },
  service: {
    install: async(v)=>record('service.install',v), start:async(v)=>record('service.start',v),
    stop: async(v)=>record('service.stop',v), remove: async(v)=>record('service.remove',v),
    status: async()=>({installed:true,online:true})
  },
  connector: { register:async(v)=>record('connector.register',v), unregister:async(v)=>record('connector.unregister',v) },
  registry: {
    get:()=>null, install:async(...v)=>record('registry.install',v), attach:async(v)=>record('registry.attach',v),
    detach:async(v)=>record('registry.detach',v), uninstall:async(v)=>record('registry.uninstall',v)
  },
  router: { register:async(...v)=>record('router.register',v), unregister:async(v)=>record('router.unregister',v) },
  frontend: { register:async(...v)=>record('frontend.register',v), unregister:async(v)=>record('frontend.unregister',v) },
  license: { require:async(v)=>record('license.require',v), check:async()=>true }
};
const installResult = await lifecycle.install(context);
await lifecycle.repair(context);
await lifecycle.upgrade(context);
await lifecycle.attach(context);
const detached = await lifecycle.detach(context);
const preserved = await lifecycle.uninstall(context, { purge: false });
const purged = await lifecycle.uninstall(context, { purge: true });

const names = calls.map((item) => item.name);
const required = [
  'migrations.applyDirectory','service.install','connector.register','registry.install',
  'router.register','frontend.register','registry.attach','service.stop','registry.detach',
  'service.remove','connector.unregister','frontend.unregister','router.unregister',
  'registry.uninstall','migrations.purgePrefix','config.delete'
];
for (const name of required) if (!names.includes(name)) throw new Error(`Missing lifecycle call: ${name}`);
const installCall = calls.find((item) => item.name === 'service.install');
if (installCall?.value?.env?.MYSQL_DATABASE !== 'orbitfs_test') throw new Error('Core database was not inherited');
if (!installCall?.value?.env?.ORBITFS_CONTROL_TOKEN) throw new Error('Control token was not generated');
if (installCall?.value?.autoStart !== false) throw new Error('MCP service must install with autoStart disabled by default');
const connectorCall = calls.find((item) => item.name === 'connector.register');
if (connectorCall?.value?.authMode !== 'oauth') throw new Error('MCP connector must use OAuth');
if (detached.preserved !== true || preserved.preserved !== true || purged.preserved !== false) throw new Error('Preservation states are incorrect');
const migrationCall = calls.find((item) => item.name === 'migrations.applyDirectory');
if (migrationCall?.value?.files?.length !== 7) throw new Error(`Expected 7 migrations, got ${migrationCall?.value?.files?.length ?? 0}`);
if (calls.filter((item) => item.name === 'license.require').length < 5) throw new Error('Install/configure/repair/upgrade/attach license gates are incomplete');
console.log(JSON.stringify({
  ok: true,
  installed: installResult.installed,
  inheritedDatabase: installCall.value.env.MYSQL_DATABASE,
  migrations: migrationCall?.value?.files?.length || 0,
  detachPreserved: detached.preserved,
  uninstallPreserved: preserved.preserved,
  purgePreserved: purged.preserved,
  callCount: calls.length
}, null, 2));