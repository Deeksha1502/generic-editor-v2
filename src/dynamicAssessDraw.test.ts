import { describe, it, expect } from 'vitest';
import { ecmlBodyForUser, pickForLearner, isGenerationStale } from './dynamicAssessDraw';

const levels: Record<string, string> = { a1: 'EASY', a2: 'EASY', a3: 'EASY', b1: 'MEDIUM', b2: 'MEDIUM', b3: 'MEDIUM' };
const body = (dynamic: boolean) => ({
  theme: { stage: [{ 'org.ekstep.questionset': [{
    config: { __cdata: JSON.stringify({ total_items: 6, ...(dynamic ? { dynamic_assess: { target: { E: 1, M: 1, D: 0 }, levels } } : {}) }) },
    data: { __cdata: JSON.stringify(Object.keys(levels).map((id) => ({ identifier: id, max_score: 1 }))) },
    'org.ekstep.question': Object.keys(levels).map((id) => ({ id })),
  }] }] },
});
const quizOf = (b: any) => b.theme.stage[0]['org.ekstep.questionset'][0];

describe('ecmlBodyForUser', () => {
  it("previews only the user's draw per level, matching the portal's seed (positive)", () => {
    const out = ecmlBodyForUser(body(true), 'do_c', 'u1') as any;
    const kept = quizOf(out)['org.ekstep.question'].map((q: any) => q.id);
    expect(kept).toHaveLength(2);
    expect(kept.filter((id: string) => levels[id] === 'MEDIUM')).toEqual(pickForLearner(['b1', 'b2', 'b3'], 1, 'u1:do_c:MEDIUM'));
    expect(JSON.parse(quizOf(out).config.__cdata).total_items).toBe(2);
  });

  it('does not mutate the original body', () => {
    const original = body(true);
    ecmlBodyForUser(original, 'do_c', 'u1');
    expect(quizOf(original)['org.ekstep.question']).toHaveLength(6);
  });

  it('returns bodies without the dynamic block, and non-objects, unchanged (negative)', () => {
    const plain = body(false);
    expect(ecmlBodyForUser(plain, 'do_c', 'u1')).toBe(plain);
    expect(ecmlBodyForUser({}, 'do_c', 'u1')).toEqual({});
  });
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
});

describe('ecmlBodyForUser — fail closed and parity', () => {
  const withTarget = (target: unknown) => ({
    theme: { stage: [{ 'org.ekstep.questionset': [{
      config: { __cdata: JSON.stringify({ dynamic_assess: { target, levels } }) },
      data: { __cdata: JSON.stringify(Object.keys(levels).map((id) => ({ identifier: id, max_score: 1 }))) },
      'org.ekstep.question': Object.keys(levels).map((id) => ({ id })),
    }] }] },
  });

  it('draws nothing, never the pool, for a zero or unparseable target (positive)', () => {
    expect(quizOf(ecmlBodyForUser(withTarget({ E: 0, M: 0, D: 0 }), 'do_c', 'u1'))['org.ekstep.question']).toEqual([]);
    expect(quizOf(ecmlBodyForUser(withTarget('nope'), 'do_c', 'u1'))['org.ekstep.question']).toEqual([]);
  });

  it('accepts a JSON-string target like the portal does (positive)', () => {
    expect(quizOf(ecmlBodyForUser(withTarget('{"E":1,"M":1,"D":0}'), 'do_c', 'u1'))['org.ekstep.question']).toHaveLength(2);
  });

  it('matches the golden vector shared with the portal and the QuestionSet editor', () => {
    expect(pickForLearner(['q1', 'q2', 'q3', 'q4', 'q5', 'q6'], 2, 'user-1:do_123:EASY')).toEqual(['q6', 'q3']);
  });
});
