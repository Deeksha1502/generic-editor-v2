/** useEditor — the editor controller; owns content/view state and orchestrates services while UI components stay thin and just call its actions. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContentData, DrawerKind, EditorConfig, EditorContext, EditorEventPayload,
  EditorMode, EditorView, RawTranscript, UploadProgress,
} from './types';
import { ContentEditorService } from './services/ContentEditorService';
import { difficultyTargetTotal, toDifficultyTarget } from './difficultyTarget';
import { isGenerationStale, needsGeneration } from './dynamicAssessDraw';
import { UploadService, detectFileMime, detectUrlMime } from './services/UploadService';
import { TelemetryService } from './telemetry/TelemetryService';
import type { TelemetryEvent } from './telemetry/telemetry.types';
import { t, tf } from './i18n/i18n';
import {
  DEFAULT_MAX_FILE_SIZE_MB, DEFAULT_PRIMARY_CATEGORIES, EDITOR_EVENTS,
  IDLE_TIMEOUT_MS, isVideoMimeType, LARGE_UPLOAD_EXTENSIONS, LARGE_UPLOAD_MAX_MB, STATUS,
} from './constants';

export interface UseEditorOptions {
  context: EditorContext;
  config?: EditorConfig;
  contentId?: string;
  language?: string;
  service?: ContentEditorService;
  onEvent?: (e: EditorEventPayload) => void;
  onTelemetryEvent?: (e: TelemetryEvent) => void;
  onClose?: () => void;
  /** Host-provided asset uploader for the thumbnail/appIcon. Returns the asset URL. */
  onUploadAsset?: (file: File) => Promise<string>;
}

export interface ToastState {
  msg: string;
  kind: 'success' | 'error';
}

const REVIEWER_ROLES = ['CONTENT_REVIEWER', 'BOOK_REVIEWER'];

const TRANSCRIPT_POLL_MS = 20000;
/** ~5 minutes of active (non-hidden) polling - generation is expected to finish well within this. */
const TRANSCRIPT_POLL_MAX_ATTEMPTS = 15;

/** refresh-body polling: faster and shorter than transcript polling since the job write is quicker. */
const DYNAMIC_ASSESS_POLL_MS = 3000;
const DYNAMIC_ASSESS_POLL_MAX_ATTEMPTS = 20;

const DYNAMIC_ASSESS_CATEGORY = 'Dynamic Course Assessment';

/** Dynamic Assess has no uploaded artifact (the job generates its body), so it counts as usable and skips the upload view. */
function hasUsableContent(content: { artifactUrl?: string; primaryCategory?: string } | null): boolean {
  return !!content?.artifactUrl || content?.primaryCategory === DYNAMIC_ASSESS_CATEGORY;
}

/** Dynamic Assess content whose saved skill/difficultyTarget differ from what its questions were generated for. */
function isStaleGeneration(c: ContentData | null): boolean {
  return c?.primaryCategory === DYNAMIC_ASSESS_CATEGORY && Number(c.totalQuestions ?? 0) > 0
    && isGenerationStale(c.body, toDifficultyTarget(c.difficultyTarget), c.skill);
}

/** Translates knowlg-service's per-skill pool rejection; its message is English-only ("Fewer than 6 Live questions found for skill(s): A, B"). */
function skillPoolErrorMessage(err: unknown, lang: string): string | null {
  const e = err as { code?: string; message?: string };
  if (e?.code !== 'ERR_SKILL_INSUFFICIENT_POOL') return null;
  const match = /Fewer than (\d+).*skill\(s\):\s*(.+)$/.exec(e.message ?? '');
  if (!match) return e.message ?? null;
  return tf(lang, 'ERROR_SKILL_POOL_TOO_SMALL', { needed: match[1] ?? '', skills: match[2] ?? '' });
}

/** Dynamic Assess content the job hasn't generated questions for yet. */
function lacksGeneratedQuestions(c: ContentData | null): boolean {
  return c?.primaryCategory === DYNAMIC_ASSESS_CATEGORY && !(Number(c.totalQuestions ?? 0) > 0);
}

function resolveMode(status: string | undefined, roles: string[] = []): EditorMode {
  const s = (status || STATUS.DRAFT).toLowerCase().trim();
  const isReviewer = roles.some((r) => REVIEWER_ROLES.includes(r));
  // Non-editable workflow states (mid-publish, flagged, retired).
  if (['processing', 'flagged', 'flagdraft', 'flagreview', 'retired'].includes(s)) return 'read';
  // Under review: only a reviewer gets the review actions; everyone else is read-only.
  if (s === 'review') return isReviewer ? 'review' : 'read';
  // Draft / Live / Unlisted (and anything else) → fully editable. Editing a Live
  // content creates a new draft version upstream; the header still shows all actions.
  return 'edit';
}

export function useEditor(opts: UseEditorOptions) {
  const { context, config, contentId: initialId, onEvent, onTelemetryEvent, onClose } = opts;
  const lang = opts.language ?? config?.language ?? 'en';
  const largeUpload = !!config?.largeUpload;
  const headerLogo = config?.headerLogo;
  const previewUrl = config?.previewUrl ?? '/content/preview/preview.html';
  const previewConfig = config?.previewConfig ?? { showEndpage: true };
  // Portal can override either cap via config.maxFileSizeMB; otherwise mode-specific defaults apply.
  const maxMB = config?.maxFileSizeMB ?? (largeUpload ? LARGE_UPLOAD_MAX_MB : DEFAULT_MAX_FILE_SIZE_MB);

  /* Rebuild the service only when its API-affecting config actually changes (not on every
     render — portal passes an inline `config` literal). An injected service always wins. */
  const configKey = JSON.stringify({
    baseUrl: config?.baseUrl, apiSlug: config?.apiSlug, headers: config?.headers, cloudStorage: config?.cloudStorage,
  });
  const service = useMemo(
    () => opts.service ?? new ContentEditorService(config, undefined, context),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.service, configKey],
  );
  const uploader = useMemo(() => new UploadService(service, config), [service, config]);
  const telemetry = useRef<TelemetryService | null>(null);
  if (!telemetry.current) {
    telemetry.current = new TelemetryService(
      context,
      (e) => onTelemetryEvent?.(e),
      config?.telemetry?.url ? () => Promise.resolve() : null,
    );
  }
  /* Keep telemetry's context current if the host swaps it (uid/sid/channel/pdata). */
  useEffect(() => {
    telemetry.current?.updateContext(context);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.uid, context.sid, context.did, context.channel]);

  const [content, setContent] = useState<ContentData | null>(null);
  const [view, setView] = useState<EditorView>(initialId ? 'loading' : 'upload');
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  /** When set, the full-screen image picker is open; onPick receives the chosen URL. */
  const [assetPicker, setAssetPicker] = useState<{ onPick: (url: string) => void } | null>(null);
  const [drawer, setDrawer] = useState<DrawerKind>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  /** Content-type options fetched from the save form (data/v1/form/read). */
  const [fetchedCategories, setFetchedCategories] = useState<string[]>([]);
  const categories = useMemo(
    () =>
      fetchedCategories.length
        ? fetchedCategories
        : config?.primaryCategories?.length
          ? config.primaryCategories
          : [...DEFAULT_PRIMARY_CATEGORIES],
    [fetchedCategories, config],
  );
  /* Empty = the "Select one" placeholder; user must pick before uploading. */
  const [contentType, setContentType] = useState<string>('');
  const [uploadUrl, setUploadUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which async action is in flight (drives per-control "saving…" spinners). */
  const [busyAction, setBusyAction] = useState<string | null>(null);
  /** Set when the user cancels an in-flight upload so a late finish can't flip to player. */
  const cancelledRef = useRef(false);
  const [reviewErrors, setReviewErrors] = useState<string[]>([]);
  /** When true, the metadata drawer is in "edit-then-submit-for-review" flow. */
  const [reviewSubmitMode, setReviewSubmitMode] = useState(false);
  const lockedRef = useRef(false);
  /** Id of the content we hold a lock on — used to retire on unmount. */
  const lockedIdRef = useRef<string | null>(null);
  /** Guards against re-entrant upload calls (double-click / drop) creating duplicates. */
  const uploadingRef = useRef(false);
  /** False once the hook unmounts — stops late async work touching a torn-down instance. */
  const mountedRef = useRef(true);
  const refreshPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Lets saveMetadata (declared above refreshBody) start generation with the just-saved content.
  const generateRef = useRef<(c?: ContentData) => Promise<void>>(async () => {});
  const generatingRef = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mode: EditorMode = resolveMode(content?.status, context.user?.roles);

  const emit = useCallback(
    (eid: string, edata?: Record<string, unknown>) => onEvent?.({ eid, edata, ts: Date.now() }),
    [onEvent],
  );

  /** Open/close a drawer; emits an INTERACT on open (drawer-view instrumentation). */
  const openDrawer = useCallback((kind: DrawerKind) => {
    if (kind) telemetry.current?.interact('click', `${kind}Drawer`, 'open');
    setDrawer(kind);
  }, []);

  const showToast = useCallback((msg: string, kind: 'success' | 'error' = 'success') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  /* ---- Unmount guard: retire any held lock if the editor is torn down without close() ---- */
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (refreshPollRef.current) clearInterval(refreshPollRef.current);
      if (lockedIdRef.current) {
        service.retireLock(lockedIdRef.current).catch(() => {});
        lockedRef.current = false;
        lockedIdRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Initial load ---- */
  useEffect(() => {
    telemetry.current?.start('content-editor');
    telemetry.current?.impression('content-editor');
    emit(EDITOR_EVENTS.READY);
    if (!initialId) return;
    setBusy(true);
    service
      .readContent(initialId)
      // Only Dynamic Assess needs its body (generated questions), so only it pays for a second read that includes it.
      .then((c) => (c.primaryCategory === DYNAMIC_ASSESS_CATEGORY ? service.readContent(initialId, 'edit', { withBody: true }) : c))
      .then((c) => {
        if (!mountedRef.current) return; // editor torn down mid-load
        telemetry.current?.setObject(c.identifier);
        setContent(c);
        setView(hasUsableContent(c) ? 'player' : 'upload');
        // Dynamic Assess opens on the metadata form, since there's nothing to preview until questions are generated.
        if (c.primaryCategory === DYNAMIC_ASSESS_CATEGORY && resolveMode(c.status, context.user?.roles) === 'edit') {
          openDrawer('metadata');
        }
        // Lock the content when opened for editing (creator on a draft), mirroring the old editor.
        if (resolveMode(c.status, context.user?.roles) === 'edit' && !lockedRef.current) {
          service.createLock(c.identifier, context, c)
            .then(() => {
              // If we unmounted while the lock was being created, retire it right away.
              if (!mountedRef.current) { service.retireLock(c.identifier).catch(() => {}); return; }
              lockedRef.current = true;
              lockedIdRef.current = c.identifier;
            })
            .catch(() => { /* non-fatal: proceed without lock */ });
        }
      })
      .catch((err) => {
        telemetry.current?.error(String((err as Error)?.message ?? err), 'load');
        showToast(t(lang, 'ERROR_LOAD'), 'error');
      })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Content-type options from the save form (dynamic, like the old editor) ---- */
  useEffect(() => {
    service
      .readPrimaryCategories({
        framework: context.framework,
        rootOrgId: context.user?.rootOrgId ?? context.channel,
      })
      .then((cats) => { if (cats.length) setFetchedCategories(cats); })
      .catch(() => { /* fall back to config/defaults */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Drop a stale selection if the options change; keep "Select one" as default. */
  useEffect(() => {
    if (contentType && categories.length && !categories.includes(contentType)) setContentType('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories]);

  const reload = useCallback(
    async (id: string) => {
      const fresh = await service.readContent(id);
      setContent(fresh);
      return fresh;
    },
    [service],
  );

  /** Ensure a content record + lock exists; returns its id. */
  const ensureContent = useCallback(
    async (mimeType: string): Promise<{ id: string; data: ContentData }> => {
      if (content?.identifier) return { id: content.identifier, data: content };
      const id = await service.createContent(context, {
        mimeType,
        primaryCategory: contentType,
        framework: context.framework,
      });
      telemetry.current?.setObject(id);
      const data = await reload(id);
      emit(EDITOR_EVENTS.CONTENT_CREATED, { id });
      try {
        if (!lockedRef.current) {
          await service.createLock(id, context, data);
          lockedRef.current = true;
          lockedIdRef.current = id;
        }
      } catch {
        /* non-fatal: proceed without lock */
      }
      return { id, data };
    },
    [content, service, context, contentType, reload, emit],
  );

  /* ---- Upload a file --- wantTranscripts is the upload-time "generate transcripts?" checkbox value; it fires the API call right after upload completes, not deferred to submit-for-review. */
  const uploadFile = useCallback(
    async (file: File, wantTranscripts?: boolean) => {
      if (uploadingRef.current) return; // ignore re-entry (double-click / re-drop)
      if (!content?.identifier && !contentType) {
        showToast(t(lang, 'CONTENT_TYPE_REQUIRED'), 'error');
        return;
      }
      if (file.size > maxMB * 1024 * 1024) {
        showToast(tf(lang, 'ERROR_FILE_SIZE', { n: maxMB }), 'error');
        return;
      }
      if (largeUpload) {
        const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
        if (!(LARGE_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
          showToast(t(lang, 'ERROR_FILE_TYPE'), 'error');
          return;
        }
      }
      const mimeType = await detectFileMime(file);
      if (mimeType === 'application/octet-stream') {
        showToast(t(lang, 'ERROR_FILE_TYPE'), 'error');
        return;
      }
      cancelledRef.current = false;
      uploadingRef.current = true;
      setBusy(true);
      setBusyAction('upload');
      setView('uploading');
      setProgress({ percent: 0, bytesUploaded: 0, totalBytes: file.size });
      emit(EDITOR_EVENTS.UPLOAD_START, { mimeType, size: file.size, generateTranscripts: wantTranscripts });
      telemetry.current?.interact('click', 'uploadButton', 'upload', { mimeType, generateTranscripts: wantTranscripts });
      try {
        const { id } = await ensureContent(mimeType);
        const signed = await uploader.getPresignedUrl(id, file.name);
        await uploader.putToCloud(signed, file, mimeType, (p) => {
          if (!cancelledRef.current) setProgress(p);
          emit(EDITOR_EVENTS.UPLOAD_PROGRESS, { percent: p.percent });
        });
        await uploader.finalizeUpload(id, signed, mimeType);
        if (cancelledRef.current) return;
        await reload(id);
        setView('player');
        emit(EDITOR_EVENTS.UPLOAD_COMPLETE, { id });
        if (wantTranscripts && isVideoMimeType(mimeType)) {
          // Non-fatal: the upload itself already succeeded - a failed transcript
          // kickoff shouldn't block or scare the user, just isn't retried here.
          service.createTranscript(id).catch((err) => {
            telemetry.current?.error(String((err as Error)?.message ?? err), 'transcript');
          });
        }
        setUploadSuccess(true);
        setTimeout(() => setUploadSuccess(false), 2500);
      } catch (err) {
        if (cancelledRef.current) return;
        telemetry.current?.error(String((err as Error)?.message ?? err));
        emit(EDITOR_EVENTS.ERROR, { phase: 'upload', message: String((err as Error)?.message) });
        showToast(t(lang, 'ERROR_UPLOAD'), 'error');
        setView(hasUsableContent(content) ? 'player' : 'upload');
      } finally {
        uploadingRef.current = false;
        setBusy(false);
        setBusyAction(null);
        if (!cancelledRef.current) setProgress(null);
      }
    },
    [maxMB, largeUpload, contentType, lang, emit, ensureContent, uploader, reload, content, showToast, service],
  );

  /* ---- Upload from a URL ---- */
  const uploadFromUrl = useCallback(
    async (url: string) => {
      if (uploadingRef.current) return; // ignore re-entry
      const link = url.trim();
      if (!link) return;
      if (!content?.identifier && !contentType) {
        showToast(t(lang, 'CONTENT_TYPE_REQUIRED'), 'error');
        return;
      }
      const mimeType = detectUrlMime(link);
      cancelledRef.current = false;
      uploadingRef.current = true;
      setUrlError(null);
      setBusy(true);
      setBusyAction('upload');
      setView('uploading');
      emit(EDITOR_EVENTS.UPLOAD_START, { mimeType, url: link });
      telemetry.current?.interact('click', 'uploadUrlButton', 'upload', { mimeType, source: 'url' });
      try {
        const { id } = await ensureContent(mimeType);
        await uploader.finalizeUrl(id, link, mimeType);
        if (cancelledRef.current) return;
        await reload(id);
        setView('player');
        emit(EDITOR_EVENTS.UPLOAD_COMPLETE, { id });
        setUploadSuccess(true);
        setTimeout(() => setUploadSuccess(false), 2500);
      } catch (err) {
        if (cancelledRef.current) return;
        const code = (err as { code?: string })?.code;
        const message = String((err as Error)?.message ?? err);
        telemetry.current?.error(message, 'upload');
        emit(EDITOR_EVENTS.ERROR, { phase: 'upload-url', message });
        const invalidUrl = code === 'ERR_INVALID_FILE_URL' || /valid file url/i.test(message);
        if (invalidUrl) {
          setUrlError(t(lang, 'INVALID_LINK'));
          setView('upload');
        } else {
          showToast(t(lang, 'ERROR_UPLOAD'), 'error');
          setView(hasUsableContent(content) ? 'player' : 'upload');
        }
      } finally {
        uploadingRef.current = false;
        setBusy(false);
        setBusyAction(null);
      }
    },
    [contentType, lang, emit, ensureContent, uploader, reload, content, showToast],
  );

  /* ---- Cancel an in-flight upload (soft: resets UI; late finish is ignored) ---- */
  const cancelUpload = useCallback(() => {
    cancelledRef.current = true;
    uploadingRef.current = false;
    setBusy(false);
    setBusyAction(null);
    setProgress(null);
    setView(hasUsableContent(content) ? 'player' : 'upload');
    telemetry.current?.interact('click', 'cancelUpload', 'upload');
  }, [content]);

  /* ---- Save metadata ---- */
  const saveMetadata = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!content?.identifier) return;
      setBusy(true);
      setBusyAction('save-metadata');
      try {
        const res = await service.updateContent(content.identifier, fields, content.versionKey);
        const merged = { ...content, ...fields, versionKey: res?.versionKey ?? content.versionKey } as ContentData;
        setContent((c) => (c ? { ...c, ...fields, versionKey: res?.versionKey ?? c.versionKey } : c));
        setDrawer(null);
        telemetry.current?.interact('modify', 'metadata', 'save');
        emit(EDITOR_EVENTS.SAVED, { id: content.identifier });
        // Dynamic Assess generates as part of Save, only when Skill/Target need it; generation shows its own loader and toast.
        if (needsGeneration(merged)) void generateRef.current(merged);
        else showToast(t(lang, 'TOAST_DETAILS_SAVED'));
      } catch (err) {
        telemetry.current?.error(String((err as Error)?.message ?? err), 'edit');
        showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
      } finally {
        setBusy(false);
        setBusyAction(null);
      }
    },
    [content, service, emit, lang, showToast],
  );

  /* ---- Save draft (header Save) ---- */
  const saveDraft = useCallback(async () => {
    if (!content?.identifier) {
      showToast(t(lang, 'TOAST_SAVED'));
      return;
    }
    setBusy(true);
    setBusyAction('save-draft');
    try {
      const res = await service.updateContent(content.identifier, { name: content.name }, content.versionKey);
      setContent((c) => (c ? { ...c, versionKey: res?.versionKey ?? c.versionKey } : c));
      telemetry.current?.interact('click', 'saveButton', 'save');
      emit(EDITOR_EVENTS.SAVED, { id: content.identifier });
      showToast(t(lang, 'TOAST_SAVED'));
    } catch (err) {
      showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }, [content, service, emit, lang, showToast]);

  /* ---- Collaborators ---- */
  const saveCollaborators = useCallback(
    async (collaborators: string[]) => {
      if (!content?.identifier) return;
      setBusy(true);
      setBusyAction('collaborator');
      try {
        const res = await service.updateCollaborators(content.identifier, collaborators);
        setContent((c) =>
          c ? { ...c, collaborators, versionKey: (res as { versionKey?: string })?.versionKey ?? c.versionKey } : c,
        );
        telemetry.current?.interact('modify', 'collaborator', 'collaborator');
        emit(EDITOR_EVENTS.COLLABORATORS_UPDATED, { id: content.identifier, count: collaborators.length });
        showToast(t(lang, 'TOAST_COLLAB_SAVED'));
        // Drawer stays open: add/remove are inline, persisted per click.
      } catch (err) {
        telemetry.current?.error(String((err as Error)?.message ?? err), 'edit');
        showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
      } finally {
        setBusy(false);
        setBusyAction(null);
      }
    },
    [content, service, emit, lang, showToast],
  );

  /* ---- Send for review ---- */
  const validateForReview = useCallback((override?: ContentData): string[] => {
    const errs: string[] = [];
    const c = override ?? content;
    if (!c) return [t(lang, 'ERROR_LOAD')];
    if (!c.name || c.name === 'Untitled Content') errs.push(t(lang, 'TITLE'));
    if (!c.description) errs.push(t(lang, 'DESCRIPTION'));
    if (!c.appIcon) errs.push(t(lang, 'THUMBNAIL'));
    if (!c.board) errs.push(t(lang, 'BOARD'));
    if (!c.medium?.length) errs.push(t(lang, 'MEDIUM'));
    if (!c.gradeLevel?.length) errs.push(t(lang, 'CLASS'));
    if (!c.subject?.length) errs.push(t(lang, 'SUBJECT'));
    return errs;
  }, [content, lang]);

  /** Async variant: validates against dynamically-fetched review-form required fields, falling back to the static list on error. */
  const validateForReviewAsync = useCallback(async (override?: ContentData): Promise<string[]> => {
    const c = override ?? content;
    if (!c) return [t(lang, 'ERROR_LOAD')];
    try {
      const subtype = c.primaryCategory ?? c.contentType ?? '';
      const fields = subtype
        ? await service.readFormFields(subtype, 'review', {
          framework: c.framework ?? context.framework,
          rootOrgId: context.user?.rootOrgId ?? context.channel,
        })
        : [];
      if (fields.length === 0) return validateForReview(c);
      const errs: string[] = [];
      for (const f of fields) {
        if (!f.required) continue;
        const val = c[f.code as keyof typeof c];
        const empty = val == null || val === '' || (Array.isArray(val) && val.length === 0);
        if (empty) errs.push(f.label ?? f.name ?? f.code);
      }
      return errs;
    } catch {
      return validateForReview();
    }
  }, [content, lang, service, validateForReview, context]);

  const sendForReview = useCallback(async () => {
    if (!content?.identifier) return;
    if (isStaleGeneration(content)) { showToast(t(lang, 'ERROR_DYNAMIC_ASSESS_STALE'), 'error'); return; }
    if (lacksGeneratedQuestions(content)) { showToast(t(lang, 'DYNAMIC_ASSESS_GENERATE_FIRST'), 'error'); return; }
    setBusy(true);
    setBusyAction('save-submit');
    try {
      await service.sendForReview(content.identifier);
      telemetry.current?.interact('click', 'reviewButton', 'review');
      emit(EDITOR_EVENTS.SENT_FOR_REVIEW, { id: content.identifier });
      if (lockedRef.current) {
        service.retireLock(content.identifier).catch(() => {});
        lockedRef.current = false;
        lockedIdRef.current = null;
      }
      showToast(t(lang, 'TOAST_SENT_REVIEW'));
      setDrawer(null);
      setTimeout(() => onClose?.(), 800);
    } catch (err) {
      showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }, [content, service, emit, lang, showToast, onClose]);

  /** Saves edited metadata, re-validates against the review form, and only submits for review if valid. */
  const saveMetadataAndSubmit = useCallback(
    async (fields: Record<string, unknown>) => {
      if (!content?.identifier) return;
      setBusy(true);
      setBusyAction('save-submit');
      let merged: ContentData;
      try {
        const res = await service.updateContent(content.identifier, fields, content.versionKey);
        merged = { ...content, ...fields, versionKey: res?.versionKey ?? content.versionKey } as ContentData;
        setContent(merged);
        telemetry.current?.interact('modify', 'metadata', 'save');
        emit(EDITOR_EVENTS.SAVED, { id: content.identifier });
      } catch (err) {
        telemetry.current?.error(String((err as Error)?.message ?? err), 'edit');
        showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
        setBusy(false);
        setBusyAction(null);
        return;
      }
      // Settings changed in the review drawer itself would otherwise submit questions built for the old ones.
      if (isStaleGeneration(merged) || lacksGeneratedQuestions(merged)) {
        showToast(t(lang, lacksGeneratedQuestions(merged) ? 'DYNAMIC_ASSESS_GENERATE_FIRST' : 'ERROR_DYNAMIC_ASSESS_STALE'), 'error');
        setBusy(false);
        setBusyAction(null);
        return;
      }
      // Re-validate the just-saved content (pass `merged` — `content` in closure is pre-save).
      const errs = await validateForReviewAsync(merged);
      if (errs.length) {
        setReviewErrors(errs);
        setBusy(false);
        setBusyAction(null);
        return;
      }
      setReviewErrors([]);
      try {
        await service.sendForReview(content.identifier);
        telemetry.current?.interact('click', 'reviewButton', 'review');
        emit(EDITOR_EVENTS.SENT_FOR_REVIEW, { id: content.identifier });
        if (lockedRef.current) {
          service.retireLock(content.identifier).catch(() => {});
          lockedRef.current = false;
          lockedIdRef.current = null;
        }
        showToast(t(lang, 'TOAST_SENT_REVIEW'));
        setReviewSubmitMode(false);
        setDrawer(null);
        setTimeout(() => onClose?.(), 800);
      } catch (err) {
        showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
      } finally {
        setBusy(false);
        setBusyAction(null);
      }
    },
    [content, service, emit, lang, showToast, onClose, validateForReviewAsync],
  );

  /* ---- Reviewer actions ---- */
  const publish = useCallback(async () => {
    if (!content?.identifier) return;
    if (isStaleGeneration(content)) { showToast(t(lang, 'ERROR_DYNAMIC_ASSESS_STALE_REVIEW'), 'error'); return; }
    if (lacksGeneratedQuestions(content)) { showToast(t(lang, 'DYNAMIC_ASSESS_GENERATE_FIRST'), 'error'); return; }
    setBusy(true);
    setBusyAction('publish');
    try {
      await service.publishContent(content.identifier, context.user?.id ?? '');
      telemetry.current?.interact('click', 'publishButton', 'publish');
      emit(EDITOR_EVENTS.PUBLISHED, { id: content.identifier });
      showToast(t(lang, 'TOAST_PUBLISHED'));
      setDrawer(null);
      setTimeout(() => onClose?.(), 800);
    } catch (err) {
      showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }, [content, service, context, emit, lang, showToast, onClose]);

  const requestChanges = useCallback(
    async (reasons: string[], comment?: string) => {
      if (!content?.identifier) return;
      setBusy(true);
      setBusyAction('reject');
      try {
        await service.rejectContent(content.identifier, reasons, comment);
        telemetry.current?.interact('click', 'requestChangesButton', 'reject', { reasons });
        emit(EDITOR_EVENTS.REJECTED, { id: content.identifier });
        showToast(t(lang, 'TOAST_REJECTED'));
        setDrawer(null);
        setTimeout(() => onClose?.(), 800);
      } catch (err) {
        telemetry.current?.error(String((err as Error)?.message ?? err), 'edit');
        showToast(String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
      } finally {
        setBusy(false);
        setBusyAction(null);
      }
    },
    [content, service, emit, lang, showToast, onClose],
  );

  /* ---- Close ---- */
  const close = useCallback(() => {
    if (content?.identifier && lockedRef.current) {
      service.retireLock(content.identifier).catch(() => {});
    }
    telemetry.current?.interact('click', 'closeButton', 'close');
    telemetry.current?.end('content-editor');
    telemetry.current?.destroy();
    emit(EDITOR_EVENTS.CLOSED);
    onClose?.();
  }, [content, service, emit, onClose]);

  /* ---- Inactivity / session-timeout prompt: mirrors the old editor's idle-timeout popup, resetting a timer on activity and showing Continue/Close when it fires. */
  const dismissSessionExpiry = useCallback(() => {
    setSessionExpired(false);
    telemetry.current?.interact('click', 'sessionPrompt', 'continue');
  }, []);

  /** Open the full-screen image picker; `onPick` is called with the chosen URL. */
  const openAssetPicker = useCallback((onPick: (url: string) => void) => {
    setAssetPicker({ onPick });
    telemetry.current?.interact('click', 'assetPicker', 'open');
  }, []);
  const closeAssetPicker = useCallback(() => setAssetPicker(null), []);

  useEffect(() => {
    // Don't run while still loading the initial content.
    if (view === 'loading') return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setSessionExpired(true);
        telemetry.current?.interact('other', 'session', 'inactivity');
      }, IDLE_TIMEOUT_MS);
    };
    const events: Array<keyof DocumentEventMap> = ['mousemove', 'keydown', 'click', 'scroll'];
    const onActivity = () => { if (!sessionExpired) reset(); };
    events.forEach((e) => document.addEventListener(e, onActivity, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => document.removeEventListener(e, onActivity));
    };
  }, [view, sessionExpired]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /** True when content was rejected and has reviewer suggestions to show. */
  const hasReviewComments = !!(content?.rejectReasons?.length || content?.rejectComment);

  /* Dynamic Assess: totalQuestions (set by the job) means questions exist; pkgVersion only moves on publish, and Drafts aren't published. */
  const isDynamicAssess = content?.primaryCategory === DYNAMIC_ASSESS_CATEGORY;
  const hasGeneratedBody = Number(content?.totalQuestions ?? 0) > 0;
  const dynamicAssessStale = isDynamicAssess && hasGeneratedBody && isStaleGeneration(content);
  const [dynamicAssessRefreshing, setDynamicAssessRefreshing] = useState(false);

  const refreshBody = useCallback(async (override?: ContentData) => {
    // Save passes the just-saved content, since this callback's `content` is from before the save.
    const current = override ?? content;
    if (!current?.identifier || generatingRef.current) return; // one generation at a time

    // Without saved inputs the job fails silently, which would show up ~60s later as a misleading "still in progress".
    const skills = Array.isArray(current.skill) ? current.skill : [];
    if (!skills.length || difficultyTargetTotal(current.difficultyTarget) <= 0) {
      showToast(t(lang, 'ERROR_DYNAMIC_ASSESS_INPUTS'), 'error');
      return;
    }
    const id = current.identifier;
    // lastUpdatedOn changes on every job write even when the count doesn't.
    const snapshot = (c: ContentData | null) => `${String(c?.totalQuestions ?? '')}|${String(c?.lastUpdatedOn ?? '')}`;
    setDynamicAssessRefreshing(true);
    generatingRef.current = true;
    let baseline: string;
    try {
      await service.refreshContentBody(id, context.user?.id ?? '');
      telemetry.current?.interact('click', 'dynamicAssessRefreshButton', 'refresh-body');
      // Baseline only after the API returns: for Live content it first writes the edit copy, which also bumps lastUpdatedOn.
      baseline = snapshot(await service.readContent(id).catch(() => current));
    } catch (err) {
      showToast(skillPoolErrorMessage(err, lang) ?? String((err as Error)?.message ?? t(lang, 'ERROR_GENERIC')), 'error');
      setDynamicAssessRefreshing(false);
      generatingRef.current = false;
      return;
    }
    // The job writes asynchronously: poll until it lands, bounded like the transcripts poll below.
    let attempts = 0;
    let done = false;
    const poll = () => {
      service.readContent(id, 'edit', { withBody: true }).then((updated) => {
        if (!mountedRef.current || done) return;
        if (snapshot(updated) !== baseline) {
          done = true;
          generatingRef.current = false;
          setContent(updated);
          setDynamicAssessRefreshing(false);
          showToast(t(lang, 'TOAST_DYNAMIC_ASSESS_REFRESH_DONE'));
        }
      }).catch(() => {});
    };
    if (refreshPollRef.current) clearInterval(refreshPollRef.current);
    const interval = setInterval(() => {
      if (done || !mountedRef.current) { clearInterval(interval); return; }
      // A hidden tab doesn't poll, so it mustn't use up attempts either.
      if (typeof document !== 'undefined' && document.hidden) return;
      attempts += 1;
      if (attempts > DYNAMIC_ASSESS_POLL_MAX_ATTEMPTS) {
        clearInterval(interval);
        done = true; // a late in-flight response must not report "done" after "still pending"
        // One last read so the editor shows what the server has, even when the job wrote before the baseline read.
        service.readContent(id, 'edit', { withBody: true })
          .then((updated) => {
            if (!mountedRef.current) return;
            setContent(updated);
            showToast(t(lang, snapshot(updated) !== baseline ? 'TOAST_DYNAMIC_ASSESS_REFRESH_DONE' : 'TOAST_DYNAMIC_ASSESS_PENDING'));
          })
          .catch(() => { if (mountedRef.current) showToast(t(lang, 'TOAST_DYNAMIC_ASSESS_PENDING')); })
          .finally(() => {
            generatingRef.current = false;
            if (mountedRef.current) setDynamicAssessRefreshing(false);
          });
        return;
      }
      poll();
    }, DYNAMIC_ASSESS_POLL_MS);
    refreshPollRef.current = interval;
  }, [content, service, lang, showToast, context.user?.id]);
  generateRef.current = refreshBody;

  /* ---- Transcripts: single fetch owner for the raw list (EditorPreview/TranscriptsDrawer
     read it from here instead of each independently re-fetching the same slow ?enrich=all
     payload). Gates the header's "View transcript" button and feeds the preview's live
     captions. Polls every 20s until transcripts exist since generation is async - capped
     at TRANSCRIPT_POLL_MAX_ATTEMPTS so a video that never gets transcripts (box left
     unchecked, or generation failed) doesn't poll for the rest of the session, and skips
     the fetch (without stopping the poll) while the tab is hidden. */
  const [transcripts, setTranscripts] = useState<RawTranscript[]>([]);
  const [transcriptsChecked, setTranscriptsChecked] = useState(false);
  const hasTranscripts = transcripts.length > 0;
  useEffect(() => {
    setTranscripts([]);
    setTranscriptsChecked(false);
    if (!content?.identifier || !isVideoMimeType(content.mimeType)) { setTranscriptsChecked(true); return; }
    const id = content.identifier;
    let found = false;
    let attempts = 0;
    const check = () => {
      service
        .readTranscripts(id)
        .then((list) => {
          if (!mountedRef.current || found) return;
          found = list.length > 0;
          setTranscripts(list);
        })
        .catch(() => { if (mountedRef.current && !found) setTranscripts([]); })
        .finally(() => { if (mountedRef.current) setTranscriptsChecked(true); });
    };
    check();
    const interval = setInterval(() => {
      if (found) { clearInterval(interval); return; }
      attempts += 1;
      if (attempts > TRANSCRIPT_POLL_MAX_ATTEMPTS) { clearInterval(interval); return; }
      if (typeof document !== 'undefined' && document.hidden) return;
      check();
    }, TRANSCRIPT_POLL_MS);
    return () => clearInterval(interval);
  }, [content?.identifier, content?.mimeType, service]);

  return {
    // state
    content, view, drawer, toast, progress, contentType, uploadUrl, urlError, busy, busyAction, mode, lang, categories,
    maxMB, largeUpload, headerLogo, previewUrl, previewConfig, framework: context.framework,
    userId: context.user?.id, rootOrgId: context.user?.rootOrgId, userRoles: context.user?.roles ?? [],
    reviewErrors, uploadSuccess, sessionExpired, assetPicker, reviewSubmitMode, hasReviewComments,
    hasTranscripts, transcripts, transcriptsChecked,
    isDynamicAssess, hasGeneratedBody, dynamicAssessRefreshing, dynamicAssessStale,
    // setters
    setDrawer: openDrawer, setContentType, setUploadUrl, setUrlError, showToast, setReviewErrors, setReviewSubmitMode,
    dismissSessionExpiry, openAssetPicker, closeAssetPicker,
    // actions
    uploadFile, uploadFromUrl, cancelUpload, saveMetadata, saveMetadataAndSubmit, saveDraft, saveCollaborators,
    validateForReview, validateForReviewAsync, sendForReview, publish, requestChanges, close, refreshBody,
    uploadAsset: opts.onUploadAsset,
    // services (for drawers that need search / framework)
    service, context,
  };
}

export type EditorController = ReturnType<typeof useEditor>;
