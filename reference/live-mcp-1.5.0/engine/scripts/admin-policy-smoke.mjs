import assert from 'node:assert/strict';
import { normalizePolicy, effectivePolicy } from '../../backend/policy.js';

const defaults=normalizePolicy({});
assert.equal(defaults.ccs.maxDocumentFileBytes,20971520);
assert.equal(defaults.ccs.maxMediaFileBytes,262144000);
assert.equal(defaults.ccs.maxMediaOutputBytes,12582912);
const legacy=normalizePolicy({ccs:{maxFileBytes:7340032}});
assert.equal(legacy.ccs.maxDocumentFileBytes,7340032);
assert.equal(legacy.ccs.maxFileBytes,7340032);
const policy=normalizePolicy({workspaceOverrides:{ws1:{ccs:{maxFileBytes:5242880},registry:{sessionIdleMinutes:15}}}});
const ws=effectivePolicy(policy,'ws1');
assert.equal(ws.ccs.maxDocumentFileBytes,5242880);
assert.equal(ws.registry.sessionIdleMinutes,15);
console.log(JSON.stringify({ok:true,checks:7,coverage:['new-defaults','legacy-file-limit','workspace-override']}));
