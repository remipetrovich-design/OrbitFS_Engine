const DEFAULT_SYSTEM_LIMITS = Object.freeze({
  maxFiles: 250,
  maxCharacters: 5_000_000,
  maxBatchFiles: 50,
  maxBatchCharacters: 750_000,
  reserveRatio: 0.2,
  maxBatchMillis: 60_000
});

export function resolveStartupBudget({ systemLimits = {}, workspaceLimits = {}, presetLimits = {}, requestLimits = {}, activeCharacters = 0 } = {}) {
  const system = { ...DEFAULT_SYSTEM_LIMITS, ...systemLimits };
  const effective = {};
  for (const key of Object.keys(DEFAULT_SYSTEM_LIMITS)) {
    const candidates = [system[key], workspaceLimits[key], presetLimits[key], requestLimits[key]]
      .filter((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      .map(Number);
    effective[key] = Math.min(...candidates);
  }
  const reservedCharacters = Math.ceil(effective.maxCharacters * effective.reserveRatio);
  const usableCharacters = Math.max(0, effective.maxCharacters - reservedCharacters - Number(activeCharacters || 0));
  return { system, effective, reservedCharacters, activeCharacters: Number(activeCharacters || 0), usableCharacters };
}
