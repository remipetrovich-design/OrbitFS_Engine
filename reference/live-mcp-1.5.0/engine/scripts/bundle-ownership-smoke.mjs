import assert from 'node:assert/strict';
import { mergeContextItems, normalizeContextItem, releaseBundleOwners } from '../src/context-ownership.js';

const manual = normalizeContextItem({ path: 'same.txt', source: 'manual' });
const bundleA = normalizeContextItem({ path: 'same.txt', source: 'bundle', bundleId: 'A' });
const bundleB = normalizeContextItem({ path: 'same.txt', source: 'bundle', bundleId: 'B' });

const manualPlusA = mergeContextItems(manual, bundleA);
assert.deepEqual(new Set(manualPlusA.contextOwners), new Set(['source:manual', 'bundle:A']));

const shared = mergeContextItems(bundleA, bundleB);
assert.deepEqual(new Set(shared.bundleIds), new Set(['A', 'B']));
assert.deepEqual(new Set(shared.contextOwners), new Set(['bundle:A', 'bundle:B']));

const releaseA = releaseBundleOwners(shared, ['A'], []);
assert.equal(releaseA.keep, true);
assert.deepEqual(releaseA.item.bundleIds, ['B']);
assert.equal(releaseA.item.bundleId, 'B');
assert.deepEqual(releaseA.item.contextOwners, ['bundle:B']);

const releaseSharedDependency = releaseBundleOwners(shared, ['A', 'B'], ['B']);
assert.equal(releaseSharedDependency.keep, true);
assert.deepEqual(releaseSharedDependency.item.bundleIds, ['B']);

const releaseOnlyA = releaseBundleOwners(bundleA, ['A'], []);
assert.equal(releaseOnlyA.keep, false);

const legacy = normalizeContextItem({ path: 'legacy.txt', source: 'bundle', bundleId: 'legacy-bundle' });
assert.deepEqual(legacy.contextOwners, ['bundle:legacy-bundle']);

console.log(JSON.stringify({
  ok: true,
  checks: 6,
  coverage: ['manual-plus-bundle', 'shared-bundles', 'release-one-owner', 'shared-dependency', 'release-last-owner', 'legacy-receipt']
}));
