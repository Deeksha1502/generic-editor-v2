import { describe, it, expect } from 'vitest';
import { planPool } from './poolPlan';

const counts = (table: Record<string, Partial<Record<'E' | 'M' | 'D', number>>>) => (s: string, l: 'E' | 'M' | 'D') => table[s]?.[l] ?? 0;

describe('planPool (mirrors the job allocation)', () => {
  it('accepts settings the job can fill (negative)', () => {
    expect(planPool(['Physics'], { E: 2, M: 2, D: 2 }, counts({ Physics: { E: 10, M: 10, D: 10 } }), 2, 3))
      .toEqual({ infeasible: false, uncovered: [], shortSkills: [] });
  });

  it('flags minCriteria x skills above the target total as infeasible (positive)', () => {
    expect(planPool(['A', 'B', 'C', 'D'], { E: 1, M: 1, D: 1 }, counts({}), 2, 3).infeasible).toBe(true);
  });

  it('counts each skill bucket as floor(count / multiplier), not the union of skills (positive)', () => {
    // 4 + 5 Easy items = 9 >= 3 x 3 in total, but the job can only draw 1 + 1 = 2 learners' worth.
    const plan = planPool(['A', 'B'], { E: 4, M: 0, D: 0 }, counts({ A: { E: 4 }, B: { E: 5 } }), 2, 3);
    expect(plan.uncovered).toEqual([{ level: 'E', covered: 2, target: 4 }]);
  });

  it('reports a skill that cannot reserve its own minimum at the requested levels (positive)', () => {
    const plan = planPool(['A', 'B'], { E: 4, M: 0, D: 0 }, counts({ A: { E: 30 }, B: { D: 30 } }), 2, 3);
    expect(plan.shortSkills).toEqual(['B']);
  });

  it('reserves the most constrained skill first, like the job (negative)', () => {
    // B only has Easy; A has every level. B must get its Easy reservation before A takes Easy.
    const plan = planPool(['A', 'B'], { E: 2, M: 2, D: 0 }, counts({ A: { E: 30, M: 30, D: 30 }, B: { E: 6 } }), 2, 3);
    expect(plan).toEqual({ infeasible: false, uncovered: [], shortSkills: [] });
  });
});
