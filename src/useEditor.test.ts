import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useEditor } from './useEditor';
import type { ContentEditorService } from './services/ContentEditorService';
import { mockContext } from './test/mockEd';
import type { ContentData } from './types';

/** A fake service covering everything useEditor + UploadService touch on mount/upload. */
function svc(over: Record<string, unknown> = {}) {
  return {
    readContent: vi.fn(),
    readPrimaryCategories: vi.fn().mockResolvedValue([]),
    createLock: vi.fn().mockResolvedValue({}),
    retireLock: vi.fn().mockResolvedValue(undefined),
    sendForReview: vi.fn().mockResolvedValue({}),
    createTranscript: vi.fn().mockResolvedValue({ transcriptId: 't1' }),
    readTranscripts: vi.fn().mockResolvedValue([]),
    updateContent: vi.fn().mockResolvedValue({ versionKey: 'vk2' }),
    readFormFields: vi.fn().mockResolvedValue([{ code: 'name', required: false }]),
    getBase: () => ({ baseUrl: '', apiSlug: '/action', headers: {}, fetchImpl: fetch }),
    getEndpoints: () => ({ presigned: 'content/v3/upload/url', uploadFinalize: 'content/v3/upload' }),
    ...over,
  } as unknown as ContentEditorService;
}

function videoContent(over: Partial<ContentData> = {}): ContentData {
  return {
    identifier: 'do_video_1',
    name: 'A video',
    mimeType: 'video/mp4',
    primaryCategory: 'Learning Resource',
    status: 'Draft',
    versionKey: 'vk1',
    ...over,
  } as ContentData;
}

async function mountWithContent(service: ContentEditorService, content: ContentData) {
  (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(content);
  const { result } = renderHook(() =>
    useEditor({ context: mockContext, contentId: content.identifier, service }),
  );
  await waitFor(() => expect(result.current.content?.identifier).toBe(content.identifier));
  return result;
}

function fakeFile(name: string, sizeBytes = 1024, type = 'video/mp4'): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
}

/** Stubs the 3-call upload pipeline (presign → cloud PUT → finalize) that
 *  UploadService drives with raw fetch, independent of ContentEditorService. */
function stubUploadPipeline() {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('upload/url')) return { ok: true, json: async () => ({ result: { pre_signed_url: 'https://blob.test/upload' } }) };
    if (u === 'https://blob.test/upload') return { ok: true };
    return { ok: true, json: async () => ({ responseCode: 'OK' }) }; // finalize
  }) as unknown as typeof fetch;
}

describe('useEditor — hasTranscripts polling', () => {
  it('polls readTranscripts periodically until transcripts appear, then stops polling', async () => {
    vi.useFakeTimers();
    try {
      const readTranscripts = vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ identifier: 't1', language: 'English', status: 'Live' }]);
      const service = svc({ readTranscripts });
      (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(videoContent());
      const { result } = renderHook(() => useEditor({ context: mockContext, contentId: 'do_video_1', service }));

      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      expect(result.current.hasTranscripts).toBe(false); // first check: not ready yet

      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(result.current.hasTranscripts).toBe(false); // still not ready on the first poll

      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(result.current.hasTranscripts).toBe(true); // second poll: now it exists

      const callsOnceConfirmed = readTranscripts.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      // No further reads once confirmed - polling stops instead of running forever.
      expect(readTranscripts.mock.calls.length).toBe(callsOnceConfirmed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll for non-video content (negative)', async () => {
    vi.useFakeTimers();
    try {
      const readTranscripts = vi.fn().mockResolvedValue([]);
      const service = svc({ readTranscripts });
      (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(videoContent({ mimeType: 'application/pdf' }));
      renderHook(() => useEditor({ context: mockContext, contentId: 'do_video_1', service }));
      await act(async () => { await vi.runOnlyPendingTimersAsync(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(readTranscripts).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling after TRANSCRIPT_POLL_MAX_ATTEMPTS when transcripts never arrive', async () => {
    vi.useFakeTimers();
    try {
      const readTranscripts = vi.fn().mockResolvedValue([]);
      const service = svc({ readTranscripts });
      (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(videoContent());
      renderHook(() => useEditor({ context: mockContext, contentId: 'do_video_1', service }));

      await act(async () => { await vi.runOnlyPendingTimersAsync(); }); // initial check
      for (let i = 0; i < 15; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      }
      const callsAtCap = readTranscripts.mock.calls.length;
      expect(callsAtCap).toBe(16); // 1 initial + 15 capped polls

      await act(async () => { await vi.advanceTimersByTimeAsync(20000 * 5); });
      // No further reads once the cap is hit - this is the "polls forever" bug being fixed.
      expect(readTranscripts.mock.calls.length).toBe(callsAtCap);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the fetch (but keeps ticking) while the tab is hidden (negative)', async () => {
    vi.useFakeTimers();
    const originalHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      const readTranscripts = vi.fn().mockResolvedValue([]);
      const service = svc({ readTranscripts });
      (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(videoContent());
      renderHook(() => useEditor({ context: mockContext, contentId: 'do_video_1', service }));
      await act(async () => { await vi.runOnlyPendingTimersAsync(); }); // initial check always fires
      const callsAfterInitial = readTranscripts.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(20000 * 3); });
      expect(readTranscripts.mock.calls.length).toBe(callsAfterInitial);
    } finally {
      vi.useRealTimers();
      if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
    }
  });

  it('exposes the raw transcript list and transcriptsChecked alongside hasTranscripts', async () => {
    const list = [{ identifier: 't1', language: 'English', status: 'Live' }];
    const readTranscripts = vi.fn().mockResolvedValue(list);
    const service = svc({ readTranscripts });
    const result = await mountWithContent(service, videoContent());
    await waitFor(() => expect(result.current.hasTranscripts).toBe(true));
    expect(result.current.transcriptsChecked).toBe(true);
    expect(result.current.transcripts).toEqual(list);
  });

  it('marks transcriptsChecked true immediately for non-video content, without ever reading (negative)', async () => {
    const service = svc();
    (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(videoContent({ mimeType: 'application/pdf' }));
    const { result } = renderHook(() => useEditor({ context: mockContext, contentId: 'do_video_1', service }));
    await waitFor(() => expect(result.current.content).toBeTruthy());
    expect(result.current.transcriptsChecked).toBe(true);
    expect(result.current.transcripts).toEqual([]);
    expect(service.readTranscripts).not.toHaveBeenCalled();
  });
});

describe('useEditor — transcript generation on upload', () => {
  it('calls createTranscript right after a successful video upload when the checkbox was checked', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent());
    const savedFetch = globalThis.fetch;
    globalThis.fetch = stubUploadPipeline();
    try {
      await act(async () => { await result.current.uploadFile(fakeFile('lecture.mp4'), true); });
      expect(service.createTranscript).toHaveBeenCalledWith('do_video_1');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('does not call createTranscript when the checkbox was unchecked (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent());
    const savedFetch = globalThis.fetch;
    globalThis.fetch = stubUploadPipeline();
    try {
      await act(async () => { await result.current.uploadFile(fakeFile('lecture.mp4'), false); });
      expect(service.createTranscript).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('does not call createTranscript for a non-video file even if passed true (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent({ mimeType: 'application/pdf' }));
    const savedFetch = globalThis.fetch;
    globalThis.fetch = stubUploadPipeline();
    try {
      await act(async () => { await result.current.uploadFile(fakeFile('doc.pdf', 1024, 'application/pdf'), true); });
      expect(service.createTranscript).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('a failed transcript kickoff does not block the upload-success path (negative)', async () => {
    const service = svc({ createTranscript: vi.fn().mockRejectedValue(new Error('boom')) });
    const result = await mountWithContent(service, videoContent());
    const savedFetch = globalThis.fetch;
    globalThis.fetch = stubUploadPipeline();
    try {
      await act(async () => { await result.current.uploadFile(fakeFile('lecture.mp4'), true); });
      await waitFor(() => expect(result.current.uploadSuccess).toBe(true));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('sendForReview no longer triggers createTranscript - that now happens at upload time (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent());
    await act(async () => { await result.current.sendForReview(); });
    expect(service.createTranscript).not.toHaveBeenCalled();
  });

  it('saveMetadataAndSubmit no longer triggers createTranscript (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent());
    await act(async () => { await result.current.saveMetadataAndSubmit({ name: 'A video (edited)' }); });
    expect(service.createTranscript).not.toHaveBeenCalled();
  });
});

describe('Dynamic Assess content view gating', () => {
  it('lands on the player view with no artifactUrl, unlike ordinary content (positive)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent({
      identifier: 'do_dynamic_assess_1',
      mimeType: 'application/vnd.ekstep.ecml-archive',
      primaryCategory: 'Dynamic Course Assessment',
      artifactUrl: undefined,
    }));
    expect(result.current.view).toBe('player');
  });

  it('ordinary content with no artifactUrl still lands on the upload view (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent({ artifactUrl: undefined }));
    expect(result.current.view).toBe('upload');
  });

  it('auto-opens the metadata drawer on load in edit mode (positive)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent({
      identifier: 'do_dynamic_assess_2',
      mimeType: 'application/vnd.ekstep.ecml-archive',
      primaryCategory: 'Dynamic Course Assessment',
      status: 'Draft',
      artifactUrl: undefined,
    }));
    await waitFor(() => expect(result.current.drawer).toBe('metadata'));
  });

  it('reads the body (generated questions) for Dynamic Assess content (positive)', async () => {
    const service = svc();
    await mountWithContent(service, videoContent({ identifier: 'do_da_body', primaryCategory: 'Dynamic Course Assessment', artifactUrl: undefined }));
    // No framework, so the skill field falls back to "skill" like the backend.
    expect(service.readContent).toHaveBeenCalledWith('do_da_body', 'edit', { withBody: true, extraFields: ['skill'] });
  });

  it('never reads the body for ordinary content (negative)', async () => {
    const service = svc();
    await mountWithContent(service, videoContent({ artifactUrl: 'https://cdn/video.mp4' }));
    for (const call of (service.readContent as ReturnType<typeof vi.fn>).mock.calls) expect(call[2]).toBeUndefined();
  });

  it('does not auto-open the metadata drawer for ordinary content (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, videoContent({ artifactUrl: 'https://cdn/video.mp4' }));
    expect(result.current.drawer).toBeNull();
  });
});

describe('useEditor — Dynamic Assess refreshBody polling', () => {
  const daContent = (over: Partial<ContentData> = {}): ContentData => videoContent({
    identifier: 'do_da_1', mimeType: 'application/vnd.ekstep.ecml-archive',
    primaryCategory: 'Dynamic Course Assessment', status: 'Draft',
    totalQuestions: 3, lastUpdatedOn: 't0',
    skill: ['Physics'], difficultyTarget: '{"E":1,"M":1,"D":1}', ...over,
  } as Partial<ContentData>);

  it('blocks Generate with a clear message when Skill is not saved, instead of a misleading wait (positive)', async () => {
    const refreshContentBody = vi.fn();
    const service = svc({ refreshContentBody });
    const result = await mountWithContent(service, daContent({ skill: [] }));
    await act(async () => { await result.current.refreshBody(); });
    expect(refreshContentBody).not.toHaveBeenCalled();
    expect(result.current.toast?.msg).toBe('Set Skill and Difficulty Target before generating questions.');
    expect(result.current.dynamicAssessRefreshing).toBe(false);
  });

  it('blocks Generate when every difficulty count is zero (negative)', async () => {
    const refreshContentBody = vi.fn();
    const service = svc({ refreshContentBody });
    const result = await mountWithContent(service, daContent({ difficultyTarget: '{"E":0,"M":0,"D":0}' }));
    await act(async () => { await result.current.refreshBody(); });
    expect(refreshContentBody).not.toHaveBeenCalled();
  });

  it('detects a regenerate that keeps the same count via lastUpdatedOn, without needing a publish (positive)', async () => {
    const refreshContentBody = vi.fn().mockResolvedValue({});
    const service = svc({ refreshContentBody });
    const result = await mountWithContent(service, daContent());
    vi.useFakeTimers();
    try {
      const readContent = service.readContent as ReturnType<typeof vi.fn>;
      readContent
        .mockResolvedValueOnce(daContent())                         // baseline
        .mockResolvedValueOnce(daContent())                         // poll 1: job not done
        .mockResolvedValue(daContent({ lastUpdatedOn: 't1' }));     // poll 2: job wrote

      await act(async () => { await result.current.refreshBody(); });
      expect(refreshContentBody).toHaveBeenCalledWith('do_da_1', 'u1'); // logged-in user as lastPublishedBy
      expect(result.current.dynamicAssessRefreshing).toBe(true);

      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(result.current.dynamicAssessRefreshing).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(result.current.dynamicAssessRefreshing).toBe(false);
      expect(result.current.toast?.msg).toBe('Questions generated');
      expect(result.current.content?.pkgVersion ?? 0).toBe(0); // still an unpublished Draft
    } finally {
      vi.useRealTimers();
    }
  });

  it('says generation is still in progress, not done, when nothing changes before the poll limit (negative)', async () => {
    const service = svc({ refreshContentBody: vi.fn().mockResolvedValue({}) });
    const result = await mountWithContent(service, daContent());
    vi.useFakeTimers();
    try {
      await act(async () => { await result.current.refreshBody(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 21); });
      expect(result.current.dynamicAssessRefreshing).toBe(false);
      expect(result.current.toast?.msg).toMatch(/haven't appeared yet/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useEditor — Dynamic Assess refreshBody timeout', () => {
  const daContent = (over: Partial<ContentData> = {}): ContentData => videoContent({
    identifier: 'do_da_t', mimeType: 'application/vnd.ekstep.ecml-archive',
    primaryCategory: 'Dynamic Course Assessment', status: 'Draft',
    totalQuestions: 0, lastUpdatedOn: 't0',
    skill: ['Physics'], difficultyTarget: '{"E":1,"M":1,"D":1}', ...over,
  } as Partial<ContentData>);

  it('shows what the server has after the poll limit, even when the job wrote before the baseline read (positive)', async () => {
    const service = svc({ refreshContentBody: vi.fn().mockResolvedValue({}) });
    const result = await mountWithContent(service, daContent());
    vi.useFakeTimers();
    try {
      // The job finished before the baseline read, so no poll ever sees a change.
      (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(daContent({ totalQuestions: 3, lastUpdatedOn: 't1' }));
      await act(async () => { await result.current.refreshBody(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 21); });
      expect(result.current.dynamicAssessRefreshing).toBe(false);
      expect(result.current.content?.totalQuestions).toBe(3);
      expect(result.current.hasGeneratedBody).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still says pending, and clears the loader, when the last read fails (negative)', async () => {
    const service = svc({ refreshContentBody: vi.fn().mockResolvedValue({}) });
    const result = await mountWithContent(service, daContent());
    vi.useFakeTimers();
    try {
      (service.readContent as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('down'));
      await act(async () => { await result.current.refreshBody(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000 * 21); });
      expect(result.current.dynamicAssessRefreshing).toBe(false);
      expect(result.current.toast?.msg).toMatch(/haven't appeared yet/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useEditor — Save also generates when needed', () => {
  const generatedBody = JSON.stringify({
    theme: { stage: [{ 'org.ekstep.questionset': { config: { __cdata: JSON.stringify({ dynamic_assess: { skills: ['Physics'], target: { E: 1, M: 0, D: 0 } } }) } } }] },
  });
  const daContent = (over: Partial<ContentData> = {}): ContentData => videoContent({
    identifier: 'do_da_2', mimeType: 'application/vnd.ekstep.ecml-archive', primaryCategory: 'Dynamic Course Assessment', ...over,
  } as Partial<ContentData>);

  it('generates right after the first save that has Skill and Difficulty Target (positive)', async () => {
    const refreshContentBody = vi.fn().mockResolvedValue({});
    const result = await mountWithContent(svc({ refreshContentBody }), daContent({ totalQuestions: 0 } as Partial<ContentData>));
    await act(async () => { await result.current.saveMetadata({ skill: ['Physics'], difficultyTarget: '{"E":1,"M":0,"D":0}' }, { skillField: 'skill' }); });
    await waitFor(() => expect(refreshContentBody).toHaveBeenCalledWith('do_da_2', 'u1'));
    expect(result.current.dynamicAssessRefreshing).toBe(true);
  });

  it('regenerates when a save changes the Skill of already-generated questions (positive)', async () => {
    const refreshContentBody = vi.fn().mockResolvedValue({});
    const content = daContent({ totalQuestions: 3, skill: ['Physics'], difficultyTarget: '{"E":1,"M":0,"D":0}', body: generatedBody } as Partial<ContentData>);
    const result = await mountWithContent(svc({ refreshContentBody }), content);
    await act(async () => { await result.current.saveMetadata({ skill: ['Physics', 'Chemistry'] }, { skillField: 'skill' }); });
    await waitFor(() => expect(refreshContentBody).toHaveBeenCalled());
  });

  it('is a plain save, with no generate call, for a spelling fix (negative)', async () => {
    const refreshContentBody = vi.fn();
    const content = daContent({ totalQuestions: 3, skill: ['Physics'], difficultyTarget: '{"E":1,"M":0,"D":0}', body: generatedBody } as Partial<ContentData>);
    const result = await mountWithContent(svc({ refreshContentBody }), content);
    await act(async () => { await result.current.saveMetadata({ name: 'Fixed typo' }); });
    expect(refreshContentBody).not.toHaveBeenCalled();
    expect(result.current.toast?.msg).toBe('Details saved — content updated');
  });

  it('keeps the generic toast for other content (negative)', async () => {
    const result = await mountWithContent(svc(), videoContent());
    await act(async () => { await result.current.saveMetadata({ name: 'Renamed' }); });
    expect(result.current.toast?.msg).toBe('Details saved — content updated');
  });
});

describe('useEditor — Dynamic Assess settings changed after generation', () => {
  const generatedBody = JSON.stringify({
    theme: { stage: [{ 'org.ekstep.questionset': { config: { __cdata: JSON.stringify({ dynamic_assess: { skills: ['Physics'], target: { E: 3, M: 3, D: 3 } } }) } } }] },
  });
  const daContent = (over: Partial<ContentData> = {}): ContentData => videoContent({
    identifier: 'do_da_s', mimeType: 'application/vnd.ekstep.ecml-archive',
    primaryCategory: 'Dynamic Course Assessment', status: 'Draft', totalQuestions: 9,
    skill: ['Physics'], difficultyTarget: '{"E":3,"M":3,"D":3}', body: generatedBody, ...over,
  } as Partial<ContentData>);

  it('blocks Send for Review when the target was changed without regenerating (positive)', async () => {
    const service = svc();
    const result = await mountWithContent(service, daContent({ difficultyTarget: '{"E":3,"M":2,"D":3}' } as Partial<ContentData>));
    expect(result.current.dynamicAssessStale).toBe(true);
    await act(async () => { await result.current.sendForReview(); });
    expect(service.sendForReview).not.toHaveBeenCalled();
    expect(result.current.toast?.msg).toMatch(/changed since the questions were generated/);
  });

  it('saves but does not submit when the review drawer itself changes the skill (positive)', async () => {
    const service = svc();
    const result = await mountWithContent(service, daContent());
    expect(result.current.dynamicAssessStale).toBe(false);
    await act(async () => { await result.current.saveMetadataAndSubmit({ skill: ['Chemistry'] }, { skillField: 'skill' }); });
    expect(service.updateContent).toHaveBeenCalled();
    expect(service.sendForReview).not.toHaveBeenCalled();
    expect(result.current.dynamicAssessStale).toBe(true);
  });

  it('blocks Publish for a reviewer when settings do not match the questions (positive)', async () => {
    const publishContent = vi.fn().mockResolvedValue({});
    const service = svc({ publishContent });
    const result = await mountWithContent(service, daContent({ skill: ['Chemistry'] }));
    await act(async () => { await result.current.publish(); });
    expect(publishContent).not.toHaveBeenCalled();
    expect(result.current.toast?.msg).toMatch(/Request changes/);
  });

  it('submits normally when the settings still match the generated questions (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, daContent());
    await act(async () => { await result.current.sendForReview(); });
    expect(service.sendForReview).toHaveBeenCalledWith('do_da_s');
  });

  it('never flags ordinary content, whatever its fields say (negative)', async () => {
    const service = svc();
    const result = await mountWithContent(service, daContent({ primaryCategory: 'Learning Resource', difficultyTarget: '{"E":1}' } as Partial<ContentData>));
    expect(result.current.dynamicAssessStale).toBe(false);
    await act(async () => { await result.current.sendForReview(); });
    expect(service.sendForReview).toHaveBeenCalled();
  });
});

describe('useEditor — Dynamic Assess Generate edge cases', () => {
  const daContent = (over: Partial<ContentData> = {}): ContentData => videoContent({
    identifier: 'do_da_g', mimeType: 'application/vnd.ekstep.ecml-archive',
    primaryCategory: 'Dynamic Course Assessment', status: 'Live',
    totalQuestions: 6, lastUpdatedOn: 't0',
    skill: ['Physics'], difficultyTarget: '{"E":2,"M":2,"D":2}', ...over,
  } as Partial<ContentData>);

  it('ignores the edit-copy write the API makes for Live content and waits for the job (positive)', async () => {
    const service = svc({ refreshContentBody: vi.fn().mockResolvedValue({}) });
    const result = await mountWithContent(service, daContent());
    vi.useFakeTimers();
    try {
      (service.readContent as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(daContent({ lastUpdatedOn: 't-img' }))      // baseline, after the API created the .img copy
        .mockResolvedValueOnce(daContent({ lastUpdatedOn: 't-img' }))      // poll 1: job not done
        .mockResolvedValue(daContent({ lastUpdatedOn: 't-job' }));         // poll 2: job wrote
      await act(async () => { await result.current.refreshBody(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(result.current.dynamicAssessRefreshing).toBe(true);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(result.current.dynamicAssessRefreshing).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling when the editor unmounts mid-generation (negative)', async () => {
    const service = svc({ refreshContentBody: vi.fn().mockResolvedValue({}) });
    (service.readContent as ReturnType<typeof vi.fn>).mockResolvedValue(daContent());
    const { result, unmount } = renderHook(() => useEditor({ context: mockContext, contentId: 'do_da_g', service }));
    await waitFor(() => expect(result.current.content?.identifier).toBe('do_da_g'));
    vi.useFakeTimers();
    try {
      await act(async () => { await result.current.refreshBody(); });
      unmount();
      const callsAtUnmount = (service.readContent as ReturnType<typeof vi.fn>).mock.calls.length;
      await vi.advanceTimersByTimeAsync(3000 * 5);
      expect((service.readContent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses Send for Review before any questions are generated, whatever the caller (positive)', async () => {
    const service = svc();
    const result = await mountWithContent(service, daContent({ status: 'Draft', totalQuestions: 0 }));
    await act(async () => { await result.current.sendForReview(); });
    expect(service.sendForReview).not.toHaveBeenCalled();
    expect(result.current.toast?.msg).toBe('Generate questions before sending for review');
  });

  it('translates the knowlg-service per-skill rejection instead of showing its English text (positive)', async () => {
    const rejection = Object.assign(new Error('Fewer than 6 Live questions found for skill(s): Azure'), { code: 'ERR_SKILL_INSUFFICIENT_POOL' });
    const service = svc({ refreshContentBody: vi.fn().mockRejectedValue(rejection) });
    const result = await mountWithContent(service, daContent({ status: 'Draft' }));
    await act(async () => { await result.current.refreshBody(); });
    expect(result.current.toast?.msg).toBe('Each skill needs at least 6 Live questions. Too few for: Azure');
    expect(result.current.dynamicAssessRefreshing).toBe(false);
  });
});

describe('useEditor — Dynamic Assess skills live in the framework\'s deepest category', () => {
  const bmgs = [{ code: 'board', name: 'Board', index: 1, terms: [] }, { code: 'topic', name: 'Topic', index: 2, terms: [] }];
  const daContent = (over: Partial<ContentData> = {}): ContentData => videoContent({
    identifier: 'do_da_topic', mimeType: 'application/vnd.ekstep.ecml-archive', primaryCategory: 'Dynamic Course Assessment',
    status: 'Draft', framework: 'BMGS', difficultyTarget: '{"E":1,"M":0,"D":0}', ...over,
  } as Partial<ContentData>);

  it('reads the selection from the deepest category field, not a field named skill (positive)', async () => {
    const service = svc({ readFramework: vi.fn().mockResolvedValue(bmgs) });
    const result = await mountWithContent(service, daContent({ topic: ['Algebra'], skill: ['Stray'] } as Partial<ContentData>));
    expect(service.readContent).toHaveBeenCalledWith('do_da_topic', 'edit', { withBody: true, extraFields: ['topic'] });
    await waitFor(() => expect(result.current.content?.dynamicSkills).toEqual(['Algebra']));
  });

  it('generates after a save that writes the deepest category, and keeps that field in polled reads (positive)', async () => {
    const refreshContentBody = vi.fn().mockResolvedValue({});
    const service = svc({ readFramework: vi.fn().mockResolvedValue(bmgs), refreshContentBody });
    const result = await mountWithContent(service, daContent());
    await act(async () => { await result.current.saveMetadata({ topic: ['Algebra'] }, { skillField: 'topic' }); });
    await waitFor(() => expect(refreshContentBody).toHaveBeenCalledWith('do_da_topic', 'u1'));
    expect(result.current.content?.dynamicSkills).toEqual(['Algebra']);
  });

  it('never resolves a framework or reads extra fields for ordinary content (negative)', async () => {
    const readFramework = vi.fn().mockResolvedValue(bmgs);
    const service = svc({ readFramework });
    await mountWithContent(service, videoContent({ artifactUrl: 'https://cdn/video.mp4', framework: 'BMGS' } as Partial<ContentData>));
    expect(readFramework).not.toHaveBeenCalled();
    for (const call of (service.readContent as ReturnType<typeof vi.fn>).mock.calls) expect(call[2]).toBeUndefined();
  });
});
