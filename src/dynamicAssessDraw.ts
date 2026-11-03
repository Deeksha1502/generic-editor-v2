// Same seeded draw as the portal's dynamicAssessSubset, so the preview shows the user the exact set they'd play; the full pool is never displayed.

import { DYNAMIC_ASSESS_MIN_CRITERIA, DYNAMIC_ASSESS_POOL_MULTIPLIER } from './constants';

const LEVELS = [['E', 'EASY'], ['M', 'MEDIUM'], ['D', 'DIFFICULT']] as const;
type Rec = Record<string, unknown>;

/** The value as a plain object, or undefined; narrows parsed ECML before it is indexed. */
const asRec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
/** ECML holds a single child as an object and several as an array; null/undefined is none. */
const asList = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
/** A quiz's parsed config.__cdata, or undefined when missing or unparseable. */
function quizConfig(quiz: Rec | undefined): Rec | undefined {
  try { return asRec(JSON.parse(String(asRec(quiz?.config)?.__cdata ?? ''))); } catch { return undefined; }
}

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickForLearner(ids: string[], count: number, seed: string): string[] {
  const pool = [...new Set(ids)].sort();
  if (count >= pool.length) return pool;
  const rand = seededRandom(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = pool[i] as string;
    pool[i] = pool[j] as string;
    pool[j] = swap;
  }
  return pool.slice(0, Math.max(0, count));
}

function parseBody(body: unknown): Rec | null {
  if (body && typeof body === 'object') return body as Rec;
  if (typeof body !== 'string' || !body.trim()) return null;
  try { return asRec(JSON.parse(body)) ?? null; } catch { return null; }
}

/** The target (and, from newer job builds, skills) the job generated the current questions for; null when there is no generated quiz. */
export function generatedSettings(body: unknown): { target: Rec; skills?: string[] } | null {
  const stages = asRec(parseBody(body)?.theme)?.stage;
  for (const stage of Array.isArray(stages) ? stages : []) {
    for (const quiz of asList(asRec(stage)?.['org.ekstep.questionset'])) {
      const block = asRec(quizConfig(asRec(quiz))?.dynamic_assess);
      if (block?.target) return { target: parseTarget(block.target), skills: Array.isArray(block.skills) ? block.skills.map(String) : undefined };
    }
  }
  return null;
}

/** True when the saved skill or difficultyTarget no longer match what the questions were generated for; skills are only compared when the job recorded them. */
export function isGenerationStale(body: unknown, savedTarget: { E?: number; M?: number; D?: number }, savedSkills: string[] | undefined): boolean {
  const generated = generatedSettings(body);
  if (!generated) return false;
  if ((['E', 'M', 'D'] as const).some((k) => (Number(generated.target[k]) || 0) !== (savedTarget[k] ?? 0))) return true;
  if (!generated.skills) return false;
  const saved = new Set((savedSkills ?? []).map(String));
  return saved.size !== new Set(generated.skills).size || generated.skills.some((s) => !saved.has(s));
}

function parseTarget(raw: unknown): Rec {
  let value = raw;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = undefined; } }
  return value && typeof value === 'object' ? (value as Rec) : {};
}

/** The content's own minCriteria/multiplier (stored at create by knowlg-service), or the defaults for content created before they were, or holding unusable values; mirrors the publish job's nodeSetting. */
export function dynamicAssessSettings(c: Record<string, unknown> | null | undefined): { minCriteria: number; multiplier: number } {
  const read = (v: unknown, min: number, fallback: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) && Math.trunc(n) >= min ? Math.trunc(n) : fallback;
  };
  return { minCriteria: read(c?.minCriteria, 0, DYNAMIC_ASSESS_MIN_CRITERIA), multiplier: read(c?.multiplier, 1, DYNAMIC_ASSESS_POOL_MULTIPLIER) };
}

/** The selected skills: the terms in the framework's deepest category field (`skillField`, e.g. "topic"), the same field the backend reads them from. */
export function selectedSkills(c: Record<string, unknown>, skillField: string): string[] {
  const v = c[skillField];
  return [...new Set((Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean))];
}

/** Save must also generate when Skill + Difficulty Target are usable and there are no questions yet, they were built for other settings, or the framework differs from `savedFramework`; any other save is a plain save. */
export function needsGeneration(c: { primaryCategory?: string; dynamicSkills?: unknown; difficultyTarget?: unknown; totalQuestions?: unknown; body?: unknown; framework?: unknown } | null, savedFramework?: unknown): boolean {
  if (c?.primaryCategory !== 'Dynamic Course Assessment') return false;
  const skills = Array.isArray(c.dynamicSkills) ? c.dynamicSkills.map(String) : [];
  const target = parseTarget(c.difficultyTarget);
  const savedTarget = { E: Number(target.E) || 0, M: Number(target.M) || 0, D: Number(target.D) || 0 };
  if (!skills.length || savedTarget.E + savedTarget.M + savedTarget.D <= 0) return false;
  // Another framework can keep the same skill names in a different category field, so its questions come from another pool; content saved without one isn't a switch.
  if (savedFramework && String(c.framework ?? '') !== String(savedFramework)) return true;
  return !(Number(c.totalQuestions ?? 0) > 0) || isGenerationStale(c.body, savedTarget, skills);
}

/** Trims each generated quiz in a parsed ECML body to this user's draw; bodies without the job's dynamic_assess block are returned unchanged. `multiplier` is the content's own (dynamicAssessSettings). */
export function ecmlBodyForUser(body: unknown, contentId: string, userId: string | undefined, multiplier = DYNAMIC_ASSESS_POOL_MULTIPLIER): unknown {
  if (!body || typeof body !== 'object') return body;
  const theme = asRec((body as Rec).theme);
  const stages = Array.isArray(theme?.stage) ? theme.stage : [];
  if (!stages.some((s) => asRec(s)?.['org.ekstep.questionset'])) return body;
  const copy = structuredClone(body) as Rec;
  const perLevel = Math.max(1, Math.trunc(multiplier) || 1);
  let changed = false;
  for (const stage of (asRec(copy.theme)?.stage ?? []) as unknown[]) {
    for (const quiz of asList(asRec(stage)?.['org.ekstep.questionset']).map(asRec)) {
      const config = quizConfig(quiz);
      const block = asRec(config?.dynamic_assess);
      const questions = asList(quiz?.['org.ekstep.question']).map((q) => asRec(q) ?? {});
      if (!quiz || !config || !block || questions.length === 0) continue;
      // Fails closed like the portal: a missing, zero or unparseable target draws nothing rather than revealing the pool.
      const target = parseTarget(block.target);
      const levels = asRec(block.levels) ?? {};
      const picked = new Set<string>();
      for (const [key, level] of LEVELS) {
        const atLevel = questions.map((q) => String(q.id)).filter((id) => String(levels[id] ?? '').toUpperCase() === level);
        // Capped at what the job generated for this level, like the QuestionSet editor, so an undersized pool is never shown whole.
        const count = Math.min(Number(target[key]) || 0, Math.floor(atLevel.length / perLevel));
        pickForLearner(atLevel, count, `${userId || 'anonymous'}:${contentId}:${level}`).forEach((id) => picked.add(id));
      }
      const kept = questions.filter((q) => picked.has(String(q.id)));
      if (kept.length === questions.length) continue;
      let items: Rec[] = [];
      const data = asRec(quiz.data);
      try { items = asList(JSON.parse(String(data?.__cdata ?? '[]'))).map((i) => asRec(i) ?? {}); } catch { items = []; }
      const keptItems = items.filter((item) => picked.has(String(item.identifier)));
      quiz['org.ekstep.question'] = kept;
      if (data) data.__cdata = JSON.stringify(keptItems);
      config.total_items = kept.length;
      config.max_score = keptItems.length ? keptItems.reduce((sum, item) => sum + (Number(item.max_score) || 1), 0) : kept.length;
      (quiz.config as Rec).__cdata = JSON.stringify(config);
      changed = true;
    }
  }
  return changed ? copy : body;
}
