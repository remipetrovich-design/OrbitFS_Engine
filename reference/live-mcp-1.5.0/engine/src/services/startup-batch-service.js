import crypto from 'node:crypto';

export function createStartupJob({ workspaceId, presetId = null, projectId = null, strength = 'medium', items = [], budget = {}, clientId = 'chatgpt' } = {}) {
  if (!workspaceId) throw Object.assign(new Error('workspaceId is required'), { status: 400, code: 'WORKSPACE_ID_REQUIRED' });
  const jobId = `startup-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  return {
    jobId,
    workspaceId,
    presetId,
    projectId,
    strength,
    clientId,
    status: 'preflight',
    createdAt: now,
    updatedAt: now,
    budget,
    batches: buildStartupBatches(items, budget),
    completedItems: [],
    skippedItems: [],
    errors: []
  };
}

export function buildStartupBatches(items = [], budget = {}) {
  const maxBatchFiles = Number(budget?.effective?.maxBatchFiles || budget.maxBatchFiles || 25);
  const maxBatchCharacters = Number(budget?.effective?.maxBatchCharacters || budget.maxBatchCharacters || 300000);
  const sorted = [...items].sort((a, b) => Number(a.priority ?? 50) - Number(b.priority ?? 50));
  const batches = [];
  let current = { index: 1, status: 'pending', items: [], estimatedCharacters: 0 };
  for (const item of sorted) {
    const estimated = Math.max(0, Number(item.estimatedCharacters || 0));
    const wouldOverflowFiles = current.items.length >= maxBatchFiles;
    const wouldOverflowChars = current.items.length > 0 && current.estimatedCharacters + estimated > maxBatchCharacters;
    if (wouldOverflowFiles || wouldOverflowChars) {
      batches.push(current);
      current = { index: batches.length + 1, status: 'pending', items: [], estimatedCharacters: 0 };
    }
    current.items.push(item);
    current.estimatedCharacters += estimated;
  }
  if (current.items.length) batches.push(current);
  return batches.map((batch, index) => ({ ...batch, index: index + 1, totalBatches: batches.length }));
}

export function summarizeStartupJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    workspaceId: job.workspaceId,
    presetId: job.presetId,
    batchCount: job.batches.length,
    itemCount: job.batches.reduce((total, batch) => total + batch.items.length, 0)
  };
}
