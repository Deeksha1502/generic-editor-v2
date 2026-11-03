import { describe, it, expect } from 'vitest';
import { isGenerationStale, needsGeneration, selectedSkills, dynamicAssessSettings } from './dynamicAssessDraw';
import { DYNAMIC_ASSESS_MIN_CRITERIA, DYNAMIC_ASSESS_POOL_MULTIPLIER } from './constants';

const levels: Record<string, string> = { a1: 'EASY', a2: 'EASY', a3: 'EASY', b1: 'MEDIUM', b2: 'MEDIUM', b3: 'MEDIUM' };
const body = (dynamic: boolean) => ({
  theme: { stage: [{ 'org.ekstep.questionset': [{
    config: { __cdata: JSON.stringify({ total_items: 6, ...(dynamic ? { dynamic_assess: { target: { E: 1, M: 1, D: 0 }, levels } } : {}) }) },
    data: { __cdata: JSON.stringify(Object.keys(levels).map((id) => ({ identifier: id, max_score: 1 }))) },
    'org.ekstep.question': Object.keys(levels).map((id) => ({ id })),
  }] }] },
});

describe('isGenerationStale', () => {
  const generated = (block: Record<string, unknown>) => JSON.stringify({
    theme: { stage: [{ 'org.ekstep.questionset': { config: { __cdata: JSON.stringify({ dynamic_assess: block }) } } }] },
  });

  it('flags a difficulty target changed after generation (positive)', () => {
    expect(isGenerationStale(generated({ target: { E: 3, M: 3, D: 3 } }), { E: 3, M: 2, D: 3 }, ['Physics'])).toBe(true);
  });

  it('flags added, removed or swapped skills when the job recorded them (positive)', () => {
    const body = generated({ skills: ['Physics'], target: { E: 1, M: 1, D: 1 } });
    expect(isGenerationStale(body, { E: 1, M: 1, D: 1 }, ['Chemistry'])).toBe(true);
    expect(isGenerationStale(body, { E: 1, M: 1, D: 1 }, ['Physics', 'Chemistry'])).toBe(true);
    expect(isGenerationStale(body, { E: 1, M: 1, D: 1 }, [])).toBe(true);
  });

  it('is not stale when settings match, ignoring skill order (negative)', () => {
    const body = generated({ skills: ['Physics', 'Chemistry'], target: { E: 1, M: 1, D: 0 } });
    expect(isGenerationStale(body, { E: 1, M: 1, D: 0 }, ['Chemistry', 'Physics'])).toBe(false);
  });

  it('skips the skill check for questions generated before the job recorded skills (negative)', () => {
    expect(isGenerationStale(generated({ target: { E: 1, M: 1, D: 1 } }), { E: 1, M: 1, D: 1 }, ['Anything'])).toBe(false);
  });

  it('is never stale without a generated quiz (negative)', () => {
    expect(isGenerationStale(undefined, { E: 1 }, ['Physics'])).toBe(false);
    expect(isGenerationStale(JSON.stringify(body(false)), { E: 9 }, ['Physics'])).toBe(false);
  });

  it('reads a JSON-string generated target, so matching settings are not stale (negative)', () => {
    const stringTarget = generated({ skills: ['Physics'], target: '{"E":1,"M":1,"D":0}' });
    expect(isGenerationStale(stringTarget, { E: 1, M: 1, D: 0 }, ['Physics'])).toBe(false);
    expect(isGenerationStale(stringTarget, { E: 1, M: 2, D: 0 }, ['Physics'])).toBe(true);
  });
});

describe('selectedSkills and needsGeneration (the selection lives in the framework\'s deepest category field)', () => {
  it('reads the selection from the named field, deduped (positive)', () => {
    expect(selectedSkills({ topic: ['Algebra', 'Algebra', 'Geometry'], skill: ['Ignored'] }, 'topic')).toEqual(['Algebra', 'Geometry']);
    expect(selectedSkills({ topic: 'Algebra' }, 'topic')).toEqual(['Algebra']);
  });

  it('is empty when that field is missing (negative)', () => {
    expect(selectedSkills({ skill: ['Physics'] }, 'topic')).toEqual([]);
  });

  it('generates from the in-memory selection, never from a field named skill (positive/negative)', () => {
    const base = { primaryCategory: 'Dynamic Course Assessment', difficultyTarget: '{"E":1,"M":0,"D":0}', totalQuestions: 0 };
    expect(needsGeneration({ ...base, dynamicSkills: ['Algebra'] })).toBe(true);
    expect(needsGeneration({ ...base, skill: ['Algebra'] } as never)).toBe(false);
    expect(needsGeneration({ ...base, primaryCategory: 'Learning Resource', dynamicSkills: ['Algebra'] })).toBe(false);
  });

  it('regenerates when only the framework changed, since its pool can differ (positive/negative)', () => {
    const generatedBody = JSON.stringify({
      theme: { stage: [{ 'org.ekstep.questionset': { config: { __cdata: JSON.stringify({ dynamic_assess: { skills: ['Algebra'], target: { E: 1, M: 0, D: 0 } } }) } } }] },
    });
    const c = { primaryCategory: 'Dynamic Course Assessment', difficultyTarget: '{"E":1,"M":0,"D":0}', totalQuestions: 1, body: generatedBody, dynamicSkills: ['Algebra'] };
    expect(needsGeneration({ ...c, framework: 'USF' }, 'BMGS')).toBe(true);
    expect(needsGeneration({ ...c, framework: 'BMGS' }, 'BMGS')).toBe(false);
    expect(needsGeneration({ ...c, framework: 'USF' })).toBe(false);
    expect(needsGeneration({ ...c, primaryCategory: 'Learning Resource', framework: 'USF' }, 'BMGS')).toBe(false);
    expect(needsGeneration({ ...c, framework: 'USF' }, '')).toBe(false); // content saved without a framework, editor default filled in
  });
});

describe('dynamicAssessSettings', () => {
  it("reads the content's own minCriteria and multiplier, as numbers or numeric strings (positive)", () => {
    expect(dynamicAssessSettings({ minCriteria: 4, multiplier: '5' })).toEqual({ minCriteria: 4, multiplier: 5 });
    expect(dynamicAssessSettings({ minCriteria: '0', multiplier: 2.0 })).toEqual({ minCriteria: 0, multiplier: 2 });
  });

  it('falls back to the defaults for older content or unusable values (negative)', () => {
    expect(dynamicAssessSettings(null)).toEqual({ minCriteria: DYNAMIC_ASSESS_MIN_CRITERIA, multiplier: DYNAMIC_ASSESS_POOL_MULTIPLIER });
    expect(dynamicAssessSettings({})).toEqual({ minCriteria: DYNAMIC_ASSESS_MIN_CRITERIA, multiplier: DYNAMIC_ASSESS_POOL_MULTIPLIER });
    expect(dynamicAssessSettings({ minCriteria: -1, multiplier: 0 })).toEqual({ minCriteria: DYNAMIC_ASSESS_MIN_CRITERIA, multiplier: DYNAMIC_ASSESS_POOL_MULTIPLIER });
    expect(dynamicAssessSettings({ minCriteria: 'abc', multiplier: '' })).toEqual({ minCriteria: DYNAMIC_ASSESS_MIN_CRITERIA, multiplier: DYNAMIC_ASSESS_POOL_MULTIPLIER });
  });
});
