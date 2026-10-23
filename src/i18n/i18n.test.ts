import { describe, it, expect } from 'vitest';
import { t, tf, getDir, getMimeTypeLabel, getCategoryLabel } from './i18n';
import { MIME_H5P } from '../constants';
import { TRANSLATIONS_EN } from './translations.en';
import { TRANSLATIONS_AR } from './translations.ar';
import { TRANSLATIONS_FR } from './translations.fr';
import { TRANSLATIONS_HI } from './translations.hi';
import { TRANSLATIONS_PT } from './translations.pt';
import { TRANSLATIONS_TA } from './translations.ta';

describe('i18n', () => {
  it('t returns the key itself when missing (negative)', () => {
    expect(t('en', 'DOES_NOT_EXIST')).toBe('DOES_NOT_EXIST');
    expect(t('en', 'SAVE')).toBe('Save');
  });
  it('tf interpolates {placeholders}', () => {
    expect(tf('en', 'MAX_SIZE', { n: '150 MB' })).toContain('150 MB');
  });
  it('getMimeTypeLabel maps knowns and defaults unknowns', () => {
    expect(getMimeTypeLabel('en', 'application/pdf')).toBe('PDF');
    expect(getMimeTypeLabel('en', MIME_H5P)).toBe('H5P');
    expect(getMimeTypeLabel('en', 'application/weird')).toBe('CONTENT');
    expect(getMimeTypeLabel('en', undefined)).toBe('CONTENT');
  });
  it('getCategoryLabel falls back to the raw category when unknown', () => {
    expect(getCategoryLabel('en', 'Totally Custom Category')).toBe('Totally Custom Category');
  });
  it('translates every Dynamic Assess key in every language instead of falling back to English (positive)', () => {
    const tables = { ar: TRANSLATIONS_AR, fr: TRANSLATIONS_FR, hi: TRANSLATIONS_HI, pt: TRANSLATIONS_PT, ta: TRANSLATIONS_TA };
    const daKeys = Object.keys(TRANSLATIONS_EN).filter((k) => /DYNAMIC_ASSESS|POOL|^DIFFICULTY_|GENERATE|SKILL/.test(k));
    expect(daKeys.length).toBeGreaterThan(0);
    for (const [lang, table] of Object.entries(tables)) {
      for (const key of daKeys) expect(table[key], `${lang}.${key}`).toBeTruthy();
    }
  });
  it('fills every placeholder of the pool shortfall message in every language (positive)', () => {
    for (const lang of ['en', 'ar', 'fr', 'hi', 'pt', 'ta']) {
      const msg = tf(lang, 'ERROR_POOL_SHORTFALL', { level: 'L', requested: 2, needed: 6, available: 4 });
      expect(msg, lang).not.toMatch(/\{\w+\}/);
      expect(msg, lang).toContain('6');
    }
  });
  it('getDir defaults to ltr for latin languages', () => {
    expect(getDir('en')).toBe('ltr');
  });
});
