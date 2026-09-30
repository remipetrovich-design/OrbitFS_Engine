function unique(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

export function bundleIdsFor(item = {}) {
  return unique([
    ...(Array.isArray(item.bundleIds) ? item.bundleIds : []),
    item.bundleId || ''
  ]);
}

export function contextOwnersFor(item = {}) {
  if (Array.isArray(item.contextOwners) && item.contextOwners.length) {
    return unique(item.contextOwners);
  }
  const bundleIds = bundleIdsFor(item);
  if (bundleIds.length) return bundleIds.map((id) => `bundle:${id}`);
  return [`source:${String(item.source || 'manual')}`];
}

export function normalizeContextItem(item = {}) {
  const bundleIds = bundleIdsFor(item);
  return {
    ...item,
    bundleIds,
    contextOwners: contextOwnersFor(item)
  };
}

export function mergeContextItems(existing = {}, incoming = {}) {
  const left = normalizeContextItem(existing);
  const right = normalizeContextItem(incoming);
  return {
    ...left,
    ...right,
    bundleIds: unique([...left.bundleIds, ...right.bundleIds]),
    contextOwners: unique([...left.contextOwners, ...right.contextOwners])
  };
}

export function releaseBundleOwners(item = {}, removedBundleIds = [], stillNeededBundleIds = []) {
  const normalized = normalizeContextItem(item);
  const removed = new Set(unique(removedBundleIds));
  const stillNeeded = new Set(unique(stillNeededBundleIds));
  const owners = normalized.contextOwners.filter((owner) => {
    if (!owner.startsWith('bundle:')) return true;
    const id = owner.slice('bundle:'.length);
    return !removed.has(id) || stillNeeded.has(id);
  });
  const bundleIds = normalized.bundleIds.filter((id) => !removed.has(id) || stillNeeded.has(id));
  const nextBundleId = bundleIds[0] || null;
  const previousBundleId = normalized.bundleId ? String(normalized.bundleId) : null;
  return {
    keep: owners.length > 0,
    item: {
      ...normalized,
      bundleIds,
      bundleId: nextBundleId,
      bundleName: previousBundleId === nextBundleId ? normalized.bundleName : null,
      contextOwners: owners
    }
  };
}
