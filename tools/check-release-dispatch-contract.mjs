import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const workflow=readFileSync('.github/workflows/publish-engine-release.yml','utf8');
const baseBuilder=readFileSync('tools/build-base-patch.mjs','utf8');
const updateBuilder=readFileSync('tools/build-update-bundle.mjs','utf8');
const inputsBlock=workflow.split('    inputs:\n')[1]?.split('\npermissions:')[0]||'';
const inputs=[...inputsBlock.matchAll(/^      ([a-z_]+):\s*$/gm)].map(match=>match[1]);
const expected=['database_source_commit','base_source_sha','base_source_repo','base_source_ref','base_previous_source_commit'];
for(const key of expected)assert.equal(inputs.filter(value=>value===key).length,1,'missing/duplicate dispatch input: '+key);
assert.ok(inputs.length<=25,'GitHub workflow_dispatch accepts at most 25 input properties');
assert.match(workflow,/Verify pinned Dev Panel release sources/);
assert.match(workflow,/PINNED_SOURCE_COMMIT="\$DATABASE_SOURCE_COMMIT"/);
assert.match(workflow,/\(\.source_commit \/\/ \.sourceCommit\)==\$pinned/);
for(const flag of ['--base-source-repo','--base-source-ref','--base-source-sha','--base-previous-source-commit']) {
	assert.ok(workflow.includes(flag),'missing provenance CLI input: '+flag);
	assert.ok(baseBuilder.includes(flag.slice(2)),'Base builder missing provenance input: '+flag);
}
assert.ok(baseBuilder.includes('  baseSource,'),'Base patch drops pinned Base metadata');
assert.ok(updateBuilder.includes("const baseSource=patch.baseSource||{};"),'Update bundle does not verify Base provenance');
console.log('Release dispatch contract checked: '+inputs.length+' declared inputs and 5 new provenance fields.');
