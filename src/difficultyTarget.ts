/** Dynamic Assess's difficultyTarget: Easy/Medium/Difficult question counts. */
export interface DifficultyTarget { E?: number; M?: number; D?: number }

export function toDifficultyTarget(v: unknown): DifficultyTarget {
  // The API returns difficultyTarget JSON-stringified (the OCD declares it a string), so parse strings first.
  let obj: unknown = v;
  if (typeof v === 'string' && v.trim()) {
    try { obj = JSON.parse(v); } catch { obj = undefined; }
  }
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    return { E: Number(o.E) || 0, M: Number(o.M) || 0, D: Number(o.D) || 0 };
  }
  return { E: 0, M: 0, D: 0 };
}

/** Writes the string type the OCD declares rather than relying on the backend accepting either shape. */
export function serializeDifficultyTarget(v: DifficultyTarget): string {
  return JSON.stringify({ E: v.E ?? 0, M: v.M ?? 0, D: v.D ?? 0 });
}

export function difficultyTargetTotal(v: unknown): number {
  const t = toDifficultyTarget(v);
  return (t.E ?? 0) + (t.M ?? 0) + (t.D ?? 0);
}
