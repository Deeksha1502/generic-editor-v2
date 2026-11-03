/** Mirrors knowlg-publish DynamicAssessHelper.isFeasible / allocate / uncoveredLevels, so the editor only lets through settings the job can actually generate. */

export const PLAN_LEVELS = ['E', 'M', 'D'] as const;
export type PlanLevel = typeof PLAN_LEVELS[number];

export interface PoolPlan {
  /** minCriteria x skills exceeds the E+M+D total (the job's feasibility check). */
  infeasible: boolean;
  /** Levels the allocation can't fill: covered is in learner questions (each needs multiplier x in the pool). */
  uncovered: Array<{ level: PlanLevel; covered: number; target: number }>;
  /** Skills that can't get their own minCriteria; the job would generate a pool without them. */
  shortSkills: string[];
}

export function planPool(
  skills: string[],
  target: Partial<Record<PlanLevel, number>>,
  liveCount: (skill: string, level: PlanLevel) => number,
  minCriteria: number,
  multiplier: number,
): PoolPlan {
  const want = (l: PlanLevel) => Math.max(0, Number(target[l]) || 0);
  const total = PLAN_LEVELS.reduce((sum, l) => sum + want(l), 0);
  if (total <= 0 || skills.length === 0 || minCriteria * skills.length > total) {
    return { infeasible: true, uncovered: [], shortSkills: [] };
  }
  // A bucket can only supply count / multiplier, so every selection has multiplier x its size to draw from.
  const avail = (s: string, l: PlanLevel) => (multiplier > 0 ? Math.floor(Math.max(0, liveCount(s, l)) / multiplier) : liveCount(s, l));
  const remaining: Record<PlanLevel, number> = { E: want('E'), M: want('M'), D: want('D') };
  const allocated = new Map<string, number>();
  const key = (s: string, l: PlanLevel) => `${s}\u0000${l}`;
  const got = (s: string, l: PlanLevel) => allocated.get(key(s, l)) ?? 0;
  const add = (s: string, l: PlanLevel, n: number) => allocated.set(key(s, l), got(s, l) + n);
  const shortSkills: string[] = [];

  // Step 1: reserve minCriteria per skill, most-constrained first (stable, like Scala's sortBy).
  const ordered = skills
    .map((s, i) => ({ s, i, feasible: PLAN_LEVELS.filter((l) => avail(s, l) > 0).length }))
    .sort((a, b) => a.feasible - b.feasible || a.i - b.i)
    .map((x) => x.s);
  for (const s of ordered) {
    let toReserve = minCriteria;
    for (const l of PLAN_LEVELS) {
      if (toReserve > 0 && remaining[l] > 0) {
        const take = Math.min(toReserve, remaining[l], Math.max(0, avail(s, l) - got(s, l)));
        if (take > 0) { add(s, l, take); remaining[l] -= take; toReserve -= take; }
      }
    }
    if (toReserve > 0) shortSkills.push(s);
  }

  // Step 2: share the remainder by availability, then give rounding leftovers to any skill with spare.
  for (const l of PLAN_LEVELS) {
    let remainder = remaining[l];
    if (remainder <= 0) continue;
    const spare = (s: string) => Math.max(0, avail(s, l) - got(s, l));
    const totalAvailable = skills.reduce((sum, s) => sum + spare(s), 0);
    if (totalAvailable <= 0) continue;
    const startingRemainder = remainder;
    const spareAtStart = new Map(skills.map((s) => [s, spare(s)]));
    for (const s of skills) {
      if (remainder <= 0) break;
      const share = Math.min(remainder, Math.max(0, Math.round((startingRemainder * (spareAtStart.get(s) ?? 0)) / totalAvailable)));
      const capped = Math.min(share, spareAtStart.get(s) ?? 0);
      if (capped > 0) { add(s, l, capped); remainder -= capped; }
    }
    for (const s of skills) {
      if (remainder <= 0) break;
      const take = Math.min(remainder, spare(s));
      if (take > 0) { add(s, l, take); remainder -= take; }
    }
  }

  const uncovered = PLAN_LEVELS
    .map((l) => ({ level: l, covered: skills.reduce((sum, s) => sum + got(s, l), 0), target: want(l) }))
    .filter((x) => x.covered < x.target);
  return { infeasible: false, uncovered, shortSkills };
}
