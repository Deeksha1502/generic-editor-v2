import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Drawer from './Drawer';
import type { EditorController } from '../useEditor';
import type { FormField, FrameworkCategory } from '../types';
import { t, tf } from '../i18n/i18n';
import { cascadedOptions, deepestCategoryCode } from '../taxonomy';
import { PencilIcon, ChevronDown, ImageIcon, CheckIcon } from '../icons';
import { type DifficultyTarget, toDifficultyTarget, serializeDifficultyTarget } from '../difficultyTarget';
import { dynamicAssessSettings, needsGeneration } from '../dynamicAssessDraw';
import { planPool } from '../poolPlan';

/**
 * Multi-value field? Driven by the form definition, not a hardcoded list — a field
 * is an array if the form marks it multiselect (or dataType 'list'), so any custom
 * taxonomy category the framework returns is handled dynamically.
 */
function isMultiField(f: FormField, dynamicAssess = false): boolean {
  if (dynamicAssess && isSkillField(f)) return true;
  const it = (f.inputType ?? '').toLowerCase();
  if (it.includes('multi')) return true;
  const dt = (f.dataType ?? '').toLowerCase();
  return dt === 'list';
}

/** difficultyTarget is matched by code: the form definition has no inputType for three named number fields. */
function isDifficultyTargetField(f: FormField): boolean {
  return f.code?.toLowerCase() === 'difficultytarget';
}

/** Dynamic Assess skill is always a list bound to the framework's deepest category, matching question-set editor-v2's isSkillField. */
function isSkillField(f: FormField): boolean {
  return f.code?.toLowerCase() === 'skill';
}


const DifficultyTargetInput: React.FC<{
  lang: string; label: string; required?: boolean; disabled?: boolean;
  value: DifficultyTarget; onChange: (v: DifficultyTarget) => void;
}> = ({ lang, label, required, disabled, value, onChange }) => {
  const rows: Array<{ key: keyof DifficultyTarget; text: string }> = [
    { key: 'E', text: t(lang, 'DIFFICULTY_EASY') },
    { key: 'M', text: t(lang, 'DIFFICULTY_MEDIUM') },
    { key: 'D', text: t(lang, 'DIFFICULTY_DIFFICULT') },
  ];
  const labelId = useId();
  return (
    <div className="ce-field-full" role="group" aria-labelledby={labelId}>
      <label id={labelId} className="ce-label-sm">{label}{required && <span className="ce-required-star">*</span>}</label>
      <div style={{ display: 'flex', gap: 12 }}>
        {rows.map(({ key, text }) => (
          <div key={key} style={{ flex: 1 }}>
            <span className="ce-label-sm" style={{ fontWeight: 400 }} aria-hidden="true">{text}</span>
            <input
              type="number"
              min={0}
              step={1}
              className="ce-input ce-input-sm"
              aria-label={text}
              value={value[key] ?? 0}
              disabled={disabled}
              onChange={(e) => {
                const n = e.target.value === '' ? 0 : Math.max(0, Math.floor(Number(e.target.value)) || 0);
                onChange({ ...value, [key]: n });
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

/** Live pool counts the job allocates from: per skill x level, and per skill overall (knowlg-service's floor). */
export interface PoolCounts { buckets: Record<string, Record<'E' | 'M' | 'D', number>>; skillCounts: Record<string, number> }

/** Why the job couldn't generate these settings (the first problem, in the order Save reports them), or null; shared by Save's check and the panel's example. */
export function poolProblem(
  lang: string, skills: string[], target: DifficultyTarget, counts: PoolCounts, minCriteria: number, multiplier: number,
): string | null {
  const { buckets, skillCounts } = counts;
  const plan = planPool(skills, target, (s, l) => buckets[s]?.[l] ?? 0, minCriteria, multiplier);
  if (plan.infeasible) {
    return tf(lang, 'ERROR_TOO_MANY_SKILLS', { count: skills.length, needed: skills.length * minCriteria, min: minCriteria });
  }
  if (plan.uncovered.length) {
    const levelKey = { E: 'DIFFICULTY_EASY', M: 'DIFFICULTY_MEDIUM', D: 'DIFFICULTY_DIFFICULT' } as const;
    const lines = plan.uncovered.map(({ level, covered, target: requested }) =>
      tf(lang, 'ERROR_POOL_SHORTFALL', { level: t(lang, levelKey[level]), requested, needed: requested * multiplier, available: covered * multiplier }));
    return `${t(lang, 'ERROR_POOL_INSUFFICIENT')}: ${lines.join('; ')}`;
  }
  // A skill that can't get its own minimum would be left out of the pool, and the settings would then never match the questions.
  if (plan.shortSkills.length) return tf(lang, 'ERROR_SKILL_LEVELS_SHORT', { skills: plan.shortSkills.join(', ') });
  // Same per-skill floor knowlg-service enforces at Generate, so it fails here, translated, instead of after a successful save.
  const perSkill = minCriteria * multiplier;
  const shortSkills = skills.filter((s) => (skillCounts[s] ?? 0) < perSkill);
  return shortSkills.length ? tf(lang, 'ERROR_SKILL_POOL_TOO_SMALL', { needed: perSkill, skills: shortSkills.join(', ') }) : null;
}

/** Dynamic Assess: shows the per-skill minimum against the live Difficulty Target, so a too-small total is visible before Save rejects it; "See an example" explains the rule with a fixed example. */
export const MinimumPerSkillPanel: React.FC<{
  lang: string; minCriteria: number; skillCount: number; target: DifficultyTarget;
}> = ({ lang, minCriteria, skillCount, target }) => {
  const [expanded, setExpanded] = useState(false);
  const total = (target.E ?? 0) + (target.M ?? 0) + (target.D ?? 0);
  const minimum = minCriteria * skillCount;
  const short = total < minimum;
  // Fixed example (2 skills, n per level), independent of what the creator entered; only the system's minCriteria feeds it.
  const n = Math.max(minCriteria, 1);
  return (
    <div className={`ce-min-skill${short ? ' ce-min-skill--short' : ''}`} role="status">
      <p className="ce-min-skill-title">{t(lang, 'MIN_PER_SKILL_TITLE')}</p>
      <p className="ce-min-skill-sub">{tf(lang, short ? 'MIN_PER_SKILL_SHORT' : 'MIN_PER_SKILL_OK', { min: minCriteria, minimum })}</p>
      {expanded && (
        <div className="ce-min-skill-example">
          <p>{tf(lang, 'MIN_PER_SKILL_EX_INTRO', { n })}</p>
          <ul>
            <li>{tf(lang, 'MIN_PER_SKILL_EX_TOTAL', { total: 3 * n })}</li>
            <li>{tf(lang, 'MIN_PER_SKILL_EX_EACH', { min: minCriteria })}</li>
          </ul>
        </div>
      )}
      <div className="ce-min-skill-foot">
        <span>{tf(lang, 'MIN_PER_SKILL_TOTALS', { total, minimum })}</span>
        <span className="ce-min-skill-actions">
          {short && <span className="ce-min-skill-badge">{t(lang, 'MIN_PER_SKILL_NEEDS_ADJUSTMENT')}</span>}
          <button type="button" className="ce-min-skill-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? `${t(lang, 'MIN_PER_SKILL_HIDE_EXAMPLE')} ▴` : `${t(lang, 'MIN_PER_SKILL_SEE_EXAMPLE')} ▾`}
          </button>
        </span>
      </div>
    </div>
  );
};

/** Fallback field set when form/read returns nothing (keeps the drawer usable). */
const FALLBACK_FIELDS: FormField[] = [
  { code: 'appicon', inputType: 'file', label: 'Thumbnail', index: 1, visible: true, editable: true },
  { code: 'name', inputType: 'text', label: 'Title', index: 2, required: true, visible: true, editable: true },
  { code: 'description', inputType: 'textarea', label: 'Description', index: 3, visible: true, editable: true },
  { code: 'board', inputType: 'select', label: 'Board / Syllabus', index: 4, visible: true, editable: true },
  { code: 'medium', inputType: 'multiselect', label: 'Medium', index: 5, visible: true, editable: true },
  { code: 'gradeLevel', inputType: 'multiselect', label: 'Class', index: 6, visible: true, editable: true },
  { code: 'subject', inputType: 'multiselect', label: 'Subject', index: 7, visible: true, editable: true },
];

const Select: React.FC<{
  label: string; placeholder: string; value: string; required?: boolean; disabled?: boolean;
  options: { code: string; name: string }[]; onChange: (v: string) => void;
}> = ({ label, placeholder, value, required, disabled, options, onChange }) => (
  <div>
    <label className="ce-label-sm">{label}{required && <span className="ce-required-star">*</span>}</label>
    <div className="ce-select-wrap" style={{ maxWidth: 'none' }}>
      <select
        className="ce-select ce-select-sm"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => <option key={o.code} value={o.name}>{o.name}</option>)}
      </select>
      <span className="ce-select-chevron"><ChevronDown size={12} /></span>
    </div>
  </div>
);

/** Checkbox popover for multi-value taxonomy fields (medium, class, subject). */
const MultiSelect: React.FC<{
  label: string; placeholder: string; values: string[]; required?: boolean; disabled?: boolean;
  options: { code: string; name: string }[]; onChange: (v: string[]) => void;
}> = ({ label, placeholder, values, required, disabled, options, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const toggle = (name: string) =>
    onChange(values.includes(name) ? values.filter((v) => v !== name) : [...values, name]);
  const summary = values.length ? values.join(', ') : placeholder;
  return (
    <div>
      <label className="ce-label-sm">{label}{required && <span className="ce-required-star">*</span>}</label>
      <div className="ce-multi" ref={ref}>
        <button
          type="button"
          className="ce-multi-control"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          <span className={`ce-multi-summary${values.length ? '' : ' is-placeholder'}`}>{summary}</span>
          <span className="ce-select-chevron"><ChevronDown size={12} /></span>
        </button>
        {open && (
          <div className="ce-multi-panel">
            {options.length === 0 ? (
              <div className="ce-multi-empty">{placeholder}</div>
            ) : (
              options.map((o) => (
                <label key={o.code} className="ce-multi-opt">
                  <input type="checkbox" checked={values.includes(o.name)} onChange={() => toggle(o.name)} />
                  <span>{o.name}</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const MetadataDrawer: React.FC<{ ed: EditorController }> = ({ ed }) => {
  const {
    lang, content, drawer, setDrawer, saveMetadata, saveMetadataAndSubmit, service, framework, busy, busyAction,
    showToast, reviewErrors, setReviewErrors, reviewSubmitMode, setReviewSubmitMode,
  } = ed;
  const saving = busyAction === 'save-metadata' || busyAction === 'save-submit';
  const open = drawer === 'metadata';

  /* Single-value fields (name, description, board). */
  const [values, setValues] = useState<Record<string, string>>({});
  /* Multi-value taxonomy fields (medium, gradeLevel, subject) — real arrays. */
  const [multiVals, setMultiVals] = useState<Record<string, string[]>>({});
  /* Dynamic Assess difficultyTarget fields — object-shaped {E,M,D}, keyed by code. */
  const [diffTargets, setDiffTargets] = useState<Record<string, DifficultyTarget>>({});
  const [appIcon, setAppIcon] = useState<string | undefined>();
  const [categories, setCategories] = useState<FrameworkCategory[]>([]);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const loadedFw = useRef<string | null>(null);
  const loadedFormKey = useRef<string | null>(null);
  /** Content id already seeded this open-session — prevents an async form load re-seeding over edits. */
  const seededRef = useRef<string | null>(null);
  /** Separate seed guard for difficultyTarget: it only appears once the async form loads, after seededRef has already fired. */
  const diffSeededRef = useRef<string | null>(null);
  /* Dynamic Assess: author-chosen framework; skill options come from its deepest category. */
  const [selectedFw, setSelectedFw] = useState('');
  // True while the pool searches run before a generating save, so a second click can't save twice.
  const [checking, setChecking] = useState(false);
  const [fwOptions, setFwOptions] = useState<Array<{ identifier: string; name: string }>>([]);
  const contentChannel = (content as Record<string, unknown> | null)?.channel as string | undefined;

  useEffect(() => {
    if (open) setSelectedFw(String(content?.framework || framework || ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, content?.identifier]);

  useEffect(() => {
    if (!open || !ed.isDynamicAssess) return;
    service.searchFrameworks(contentChannel ?? ed.context.channel).then(setFwOptions).catch(() => setFwOptions([]));
  }, [open, ed.isDynamicAssess, service, contentChannel, ed.context.channel]);

  /* Framework categories for taxonomy cascade. */
  useEffect(() => {
    const fw = selectedFw || content?.framework || framework;
    if (!open || !fw || loadedFw.current === fw) return;
    loadedFw.current = fw;
    service.readFramework(fw).then(setCategories).catch(() => setCategories([]));
  }, [open, content, framework, service, selectedFw]);

  /* Form/read field definitions — save form for Edit Details, review form for
   * Submit-for-review. Keyed on subtype+action so switching mode refetches even
   * while the drawer stays open. */
  useEffect(() => {
    const subtype = content?.primaryCategory ?? content?.contentType ?? '';
    const action: 'save' | 'review' = reviewSubmitMode ? 'review' : 'save';
    const key = `${subtype}:${action}`;
    if (!open || !subtype || loadedFormKey.current === key) return;
    loadedFormKey.current = key;
    service
      .readFormFields(subtype, action, {
        framework: content?.framework ?? framework,
        rootOrgId: ed.rootOrgId ?? ed.context.channel,
      })
      .then((f) => setFormFields(f.length ? f : FALLBACK_FIELDS))
      .catch(() => setFormFields(FALLBACK_FIELDS));
  }, [open, content, reviewSubmitMode, service, framework, ed.rootOrgId, ed.context.channel]);

  /* Visible, render-ordered fields. */
  const fields = useMemo(() => {
    const src = formFields.length ? formFields : FALLBACK_FIELDS;
    return src.filter((f) => f.visible !== false);
  }, [formFields]);

  /* Taxonomy category codes come from the framework, not a hardcoded list. */
  const taxoCodes = useMemo(() => new Set(categories.map((c) => c.code)), [categories]);
  /* Cascade order: parents first (framework index), so we can reset dependents. */
  const orderedTaxoCodes = useMemo(
    () => [...categories].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((c) => c.code),
    [categories],
  );
  const skillCategoryCode = useMemo(() => deepestCategoryCode(categories), [categories]);
  // Dynamic Assess: the selection is the framework's deepest category, so the picker carries that category's name.
  const skillCategoryLabel = ed.isDynamicAssess ? categories.find((c) => c.code === skillCategoryCode)?.name : undefined;
  /** A form field for the deepest category itself, which the Dynamic skill picker already edits. */
  const isReplacedBySkillPicker = (f: FormField) => ed.isDynamicAssess && !!skillCategoryCode && f.code === skillCategoryCode && !isSkillField(f);
  const skillPickerCode = ed.isDynamicAssess ? fields.find(isSkillField)?.code : undefined;
  // This content's own rules (knowlg-service stores them at create), so the panel and pool check match what the job enforces.
  const { minCriteria, multiplier } = dynamicAssessSettings(content as Record<string, unknown> | null);
  /** Content as this save would leave it, with the picker's terms as the in-memory selection. */
  const withSelection = (out: Record<string, unknown>) => ({
    ...(content ?? {}),
    ...out,
    ...(skillPickerCode ? { dynamicSkills: multiVals[skillPickerCode] ?? [] } : {}),
  });

  const setVal = (code: string, v: string) => setValues((s) => ({ ...s, [code]: v }));
  const setMulti = (code: string, v: string[]) => setMultiVals((s) => ({ ...s, [code]: v }));

  /* Seed values from content once the field set is known — string fields into
     `values`, multiselect fields into `multiVals`, driven by the form definition. */
  useEffect(() => {
    if (!open) { seededRef.current = null; return; } // reset so the next open re-seeds
    if (!content) return;
    // Seed once per open-session; a later async form-fields load must not clobber user typing.
    if (seededRef.current === content.identifier) return;
    seededRef.current = content.identifier;
    const vals: Record<string, string> = {
      name: content.name ?? '',
      description: content.description ?? '',
    };
    const multi: Record<string, string[]> = {};
    for (const f of fields) {
      if (f.code === 'name' || f.code === 'description') continue;
      if (f.code === 'appicon' || f.code === 'appIcon') continue;
      if (isDifficultyTargetField(f)) continue; // seeded separately below — see diffSeededRef
      // The Dynamic skill picker shows the selection read from the framework's skill field, not a field named "skill".
      const cv = ed.isDynamicAssess && isSkillField(f) ? content.dynamicSkills : (content as Record<string, unknown>)[f.code];
      if (isMultiField(f, ed.isDynamicAssess)) {
        multi[f.code] = Array.isArray(cv) ? cv.map(String) : cv != null && cv !== '' ? [String(cv)] : [];
      } else {
        vals[f.code] = cv != null ? String(cv) : '';
      }
    }
    setValues(vals);
    setMultiVals(multi);
    setAppIcon(content.appIcon);
  }, [open, content, fields]);

  /* Seeds difficultyTarget and skill once they appear (form-only fields, absent from FALLBACK_FIELDS); safe since neither is rendered before then. */
  useEffect(() => {
    if (!open) { diffSeededRef.current = null; return; }
    if (!content) return;
    const dtFields = fields.filter(isDifficultyTargetField);
    if (dtFields.length === 0) return;
    if (diffSeededRef.current === content.identifier) return;
    diffSeededRef.current = content.identifier;
    const diff: Record<string, DifficultyTarget> = {};
    for (const f of dtFields) {
      diff[f.code] = toDifficultyTarget((content as Record<string, unknown>)[f.code]);
    }
    setDiffTargets((s) => ({ ...s, ...diff }));
    const skill: Record<string, string[]> = {};
    for (const f of ed.isDynamicAssess ? fields.filter(isSkillField) : []) {
      skill[f.code] = content.dynamicSkills ?? [];
    }
    setMultiVals((s) => ({ ...s, ...skill }));
  }, [open, content, fields]);

  const appIconField = fields.find((f) => f.code === 'appicon' || f.code === 'appIcon');
  const hasAppIcon = !!appIconField;
  const appIconLabel = appIconField?.label ?? appIconField?.name ?? t(lang, 'THUMBNAIL');
  const appIconAddText = appIconField?.placeholder ?? t(lang, 'ADD_IMAGE');

  /* Selected taxonomy values keyed by category code (for the cascade). */
  const selectedTaxo = useMemo(() => {
    const sel: Record<string, string | string[]> = {};
    for (const code of taxoCodes) sel[code] = multiVals[code] ?? values[code] ?? '';
    return sel;
  }, [taxoCodes, multiVals, values]);

  /* Reset every category that depends on `changedCode` (later in cascade order). */
  const resetDependents = (changedCode: string) => {
    const idx = orderedTaxoCodes.indexOf(changedCode);
    if (idx < 0) return;
    for (const code of orderedTaxoCodes.slice(idx + 1)) {
      setMulti(code, []);
      setVal(code, '');
    }
  };

  /** A new framework means different category terms, so clear skill and every category value picked under the old one. */
  const onFrameworkChange = (fw: string) => {
    const codes = [...categories.map((c) => c.code), 'skill'];
    setSelectedFw(fw);
    setCategories([]);
    loadedFw.current = null; // otherwise re-picking the original framework (or the placeholder) never reloads its categories
    setMultiVals((s) => ({ ...s, ...Object.fromEntries(codes.map((c) => [c, []])) }));
    setValues((s) => ({ ...s, ...Object.fromEntries(codes.filter((c) => c in s).map((c) => [c, ''])) }));
  };

  /** Labels of required, editable, visible fields left empty (any inputType). */
  const missingRequired = (): string[] => {
    const miss: string[] = [];
    for (const f of fields) {
      if (!f.required || f.editable === false || f.visible === false) continue;
      if (isReplacedBySkillPicker(f)) continue;
      const code = f.code;
      let empty: boolean;
      if (code === 'appicon' || code === 'appIcon') empty = !appIcon;
      else if (isDifficultyTargetField(f)) {
        const dt = diffTargets[code] ?? {};
        empty = (dt.E ?? 0) + (dt.M ?? 0) + (dt.D ?? 0) <= 0;
      }
      else if (isMultiField(f, ed.isDynamicAssess)) empty = (multiVals[code] ?? []).length === 0;
      else empty = !((values[code] ?? '').trim());
      if (empty) miss.push(f.label ?? f.name ?? code);
    }
    return miss;
  };

  /** The fields this save would write; the Save label and onSave both read it, so they never disagree. */
  const buildOut = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.editable === false) continue;
      const code = f.code === 'appIcon' ? 'appIcon' : f.code;
      if (code === 'appicon' || code === 'appIcon') continue; // handled below
      if (isDifficultyTargetField(f)) {
        out[f.code] = serializeDifficultyTarget(diffTargets[f.code] ?? { E: 0, M: 0, D: 0 });
        continue;
      }
      if (isReplacedBySkillPicker(f)) continue;
      if (ed.isDynamicAssess && isSkillField(f)) {
        // Saved in the framework's deepest category field, where the backend reads the selection; left out until that field is known.
        const arr = multiVals[f.code] ?? [];
        if (skillCategoryCode) out[skillCategoryCode] = arr.length ? arr : undefined;
        continue;
      }
      if (isMultiField(f, ed.isDynamicAssess)) {
        const arr = multiVals[f.code] ?? [];
        out[f.code] = arr.length ? arr : undefined;
        continue;
      }
      const raw = values[f.code];
      if (raw == null) continue;
      out[f.code] = raw || undefined;
    }
    if (appIcon) out.appIcon = appIcon;
    if (ed.isDynamicAssess && selectedFw) out.framework = selectedFw;
    out.name = (values.name ?? '').trim();
    return out;
  };

  /** Blocks the save unless the job could generate these settings (its own allocation rules) and knowlg-service would accept every skill; returns true to proceed. */
  /** Live pool counts for these skills, from the same searches the job allocates from. */
  const loadPoolCounts = async (skills: string[]): Promise<PoolCounts> => {
    const channel = (content as Record<string, unknown> | null)?.channel as string | undefined;
    const [buckets, skillCounts] = await Promise.all([
      service.searchAssessmentItemBucketCounts(skills, channel ?? ed.context.channel, skillCategoryCode ?? 'skill'),
      service.searchSkillPoolCounts(skills, skillCategoryCode ?? 'skill'),
    ]);
    return { buckets, skillCounts };
  };

  const checkPoolSufficiency = async (candidate: Record<string, unknown>): Promise<boolean> => {
    const target = toDifficultyTarget(candidate.difficultyTarget);
    const skillValues = Array.isArray(candidate.dynamicSkills) ? candidate.dynamicSkills.map(String) : [];
    let counts: PoolCounts;
    try {
      counts = await loadPoolCounts(skillValues);
    } catch {
      showToast(t(lang, 'ERROR_POOL_CHECK_FAILED'), 'error');
      return false;
    }
    const problem = poolProblem(lang, skillValues, target, counts, minCriteria, multiplier);
    if (problem) {
      showToast(problem, 'error');
      return false;
    }
    return true;
  };

  const onSave = async () => {
    if (checking || busy) return; // a second click during the pool searches would save and generate twice
    if (ed.dynamicAssessRefreshing) return; // a save now would skip generating, since only one generation runs at a time
    const nameField = fields.find((f) => f.code === 'name');
    if (nameField?.required !== false && !(values.name ?? '').trim()) {
      showToast(t(lang, 'ERROR_TITLE_REQUIRED'), 'error');
      return;
    }
    // On the submit-for-review path, enforce every required field the form marks (not just name).
    if (reviewSubmitMode) {
      const miss = missingRequired();
      if (miss.length) { setReviewErrors(miss); return; }
    }
    const out = buildOut();
    const generates = needsGeneration(withSelection(out));
    // Submitting can't also generate, so changed settings must be saved (and generated) first.
    if (reviewSubmitMode && generates) {
      showToast(t(lang, 'ERROR_DYNAMIC_ASSESS_SUBMIT_STALE'), 'error');
      return;
    }
    if (generates) {
      setChecking(true);
      try {
        // The pool is only checked when this save will generate, so other edits cost no extra searches.
        if (!(await checkPoolSufficiency(withSelection(out)))) return;
      } finally {
        setChecking(false);
      }
    }
    setReviewErrors([]);
    // Only a Dynamic save names the skill field it wrote; other content keeps the plain call.
    const args: [Record<string, unknown>, { skillField?: string }?] = ed.isDynamicAssess ? [out, { skillField: skillCategoryCode }] : [out];
    if (reviewSubmitMode) saveMetadataAndSubmit(...args);
    else saveMetadata(...args);
  };

  const onClose = () => { setReviewErrors([]); setReviewSubmitMode(false); setDrawer(null); };

  /* Renders a single form field by its inputType. */
  const renderField = (f: FormField) => {
    const code = f.code;
    const label = f.label ?? f.name ?? code;
    const placeholder = f.placeholder ?? '';
    const disabled = f.editable === false;
    const required = !!f.required;

    if (code === 'appicon' || code === 'appIcon') return null; // rendered in the top block

    if (isDifficultyTargetField(f)) {
      const target = diffTargets[code] ?? { E: 0, M: 0, D: 0 };
      const selectedSkills = skillPickerCode ? (multiVals[skillPickerCode] ?? []) : [];
      return (
        <React.Fragment key={code}>
          <DifficultyTargetInput
            lang={lang}
            label={label}
            required={required}
            disabled={disabled}
            value={target}
            onChange={(v) => setDiffTargets((s) => ({ ...s, [code]: v }))}
          />
          {ed.isDynamicAssess && selectedSkills.length > 0 && (
            <MinimumPerSkillPanel
              lang={lang} minCriteria={minCriteria} skillCount={selectedSkills.length} target={target}
            />
          )}
        </React.Fragment>
      );
    }

    if (ed.isDynamicAssess && isSkillField(f)) {
      // Current framework stays selectable even if it isn't in the system-default search results.
      const fwList = selectedFw && !fwOptions.some((o) => o.identifier === selectedFw)
        ? [{ identifier: selectedFw, name: selectedFw }, ...fwOptions]
        : fwOptions;
      return (
        <React.Fragment key={code}>
          {ed.isDynamicAssess && (
            <div className="ce-field-full">
              <label className="ce-label-sm" htmlFor="ce-framework-picker">{t(lang, 'DYNAMIC_ASSESS_FRAMEWORK')}</label>
              <div className="ce-select-wrap" style={{ maxWidth: 'none' }}>
                <select
                  id="ce-framework-picker"
                  className="ce-select ce-select-sm"
                  value={selectedFw}
                  disabled={disabled}
                  onChange={(e) => onFrameworkChange(e.target.value)}
                >
                  <option value="">{t(lang, 'DYNAMIC_ASSESS_SELECT_FRAMEWORK')}</option>
                  {fwList.map((o) => <option key={o.identifier} value={o.identifier}>{o.name}</option>)}
                </select>
                <span className="ce-select-chevron"><ChevronDown size={12} /></span>
              </div>
            </div>
          )}
          <MultiSelect
            label={skillCategoryLabel ?? label}
            placeholder={skillCategoryCode ? (placeholder || `Select ${skillCategoryLabel ?? label}`) : t(lang, 'DYNAMIC_ASSESS_SELECT_FRAMEWORK_FIRST')}
            required={required}
            disabled={disabled || !skillCategoryCode}
            values={multiVals[code] ?? []}
            options={skillCategoryCode ? cascadedOptions(categories, skillCategoryCode, selectedTaxo) : []}
            onChange={(vals) => setMulti(code, vals)}
          />
        </React.Fragment>
      );
    }

    if (taxoCodes.has(code)) {
      const options = cascadedOptions(categories, code, selectedTaxo);
      // Multi vs single is decided by the form definition, not the field name.
      if (isMultiField(f, ed.isDynamicAssess)) {
        return (
          <MultiSelect
            key={code}
            label={label}
            placeholder={placeholder || `Select ${label}`}
            required={required}
            disabled={disabled}
            values={multiVals[code] ?? []}
            options={options}
            onChange={(vals) => {
              setMulti(code, vals);
              resetDependents(code); // clear categories that depend on this one
            }}
          />
        );
      }
      return (
        <Select
          key={code}
          label={label}
          placeholder={placeholder || `Select ${label}`}
          required={required}
          disabled={disabled}
          value={values[code] ?? ''}
          options={options}
          onChange={(v) => {
            setVal(code, v);
            resetDependents(code);
          }}
        />
      );
    }

    if (f.inputType === 'textarea') {
      return (
        <div key={code} className="ce-field-full">
          <label className="ce-label-sm">{label}{required && <span className="ce-required-star">*</span>}</label>
          <textarea
            className="ce-textarea ce-textarea-sm"
            value={values[code] ?? ''}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => setVal(code, e.target.value)}
          />
        </div>
      );
    }

    // default: text / number / url → text input
    return (
      <div key={code} className="ce-field-full">
        <label className="ce-label-sm">{label}{required && <span className="ce-required-star">*</span>}</label>
        <input
          className="ce-input ce-input-sm"
          value={values[code] ?? ''}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setVal(code, e.target.value)}
        />
      </div>
    );
  };

  // Live label: tells the author when Save will also generate questions.
  const saveGenerates = ed.isDynamicAssess && open && needsGeneration(withSelection(buildOut()));

  // Skill always renders with the other fields (under its framework picker), even when a framework names a category 'skill'.
  const taxoFields = fields.filter((f) => taxoCodes.has(f.code) && !(ed.isDynamicAssess && isSkillField(f)) && !isReplacedBySkillPicker(f));
  const nonTaxoFields = fields.filter(
    (f) => (!taxoCodes.has(f.code) || (ed.isDynamicAssess && isSkillField(f))) && f.code !== 'appicon' && f.code !== 'appIcon',
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      titleIcon={<PencilIcon size={18} />}
      title={t(lang, 'EDIT_CONTENT_DETAILS')}
      closeLabel={t(lang, 'CLOSE')}
      footer={
        <>
          <button type="button" className="ce-btn ce-btn--ghost" onClick={onClose}>
            {t(lang, 'CANCEL')}
          </button>
          <button type="button" className="ce-btn ce-btn--primary" onClick={() => void onSave()} disabled={busy || checking || ed.dynamicAssessRefreshing}>
            {saving || checking
              ? <><span className="ce-spinner ce-spinner--xs" /> {t(lang, 'SAVING')}</>
              : <><CheckIcon size={13} /> {reviewSubmitMode ? t(lang, 'SAVE_AND_SUBMIT') : t(lang, saveGenerates ? 'SAVE_AND_GENERATE' : 'SAVE_CHANGES')}</>}
          </button>
        </>
      }
    >
      {reviewErrors.length > 0 && (
        <div className="ce-validation" style={{ marginBottom: 16 }}>
          <p className="ce-validation-title">{t(lang, 'REVIEW_VALIDATION')}</p>
          <ul>{reviewErrors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <div className="ce-meta-top">
        {hasAppIcon && (
          <div>
            <label className="ce-label-sm">
              {appIconLabel}
              {appIconField?.required && <span className="ce-required-star">*</span>}
            </label>
            <div className="ce-thumb" onClick={() => ed.openAssetPicker(setAppIcon)} role="button" tabIndex={0}>
              {appIcon ? (
                <img src={appIcon} alt="" />
              ) : (
                <>
                  <div className="ce-thumb-ic"><ImageIcon size={16} /></div>
                  <span className="ce-thumb-text">{appIconAddText}</span>
                </>
              )}
            </div>
            {appIcon && (
              <button type="button" className="ce-link-btn" onClick={() => ed.openAssetPicker(setAppIcon)}>
                {t(lang, 'CHANGE_IMAGE')}
              </button>
            )}
          </div>
        )}
        <div className="ce-meta-fields">
          {nonTaxoFields.map(renderField)}
        </div>
      </div>

      {taxoFields.length > 0 && (
        <div className="ce-taxo-grid">
          {taxoFields.map(renderField)}
        </div>
      )}
    </Drawer>
  );
};

export default MetadataDrawer;
