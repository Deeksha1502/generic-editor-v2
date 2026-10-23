import { describe, it, expect } from 'vitest';
import { normalizeContent, ContentEditorService } from './ContentEditorService';

describe('normalizeContent', () => {
  it('coerces missing identifier/name to empty strings (negative)', () => {
    const c = normalizeContent({});
    expect(c.identifier).toBe('');
    expect(c.name).toBe('');
  });
  it('parses stringified Python-style arrays', () => {
    const c = normalizeContent({
      identifier: 'do_1', name: 'X', mimeType: 'application/pdf',
      medium: "['Hindi','English']", gradeLevel: "['Class 2']", subject: ['Science'],
    });
    expect(c.medium).toEqual(['Hindi', 'English']);
    expect(c.gradeLevel).toEqual(['Class 2']);
    expect(c.subject).toEqual(['Science']);
  });
  it('keeps board scalar but reduces board-array to its first value', () => {
    expect(normalizeContent({ identifier: 'd', name: 'n', board: 'CBSE' }).board).toBe('CBSE');
    expect(normalizeContent({ identifier: 'd', name: 'n', board: ['CBSE', 'ICSE'] }).board).toBe('CBSE');
  });
});

describe('ContentEditorService.readFormFields subType resolution', () => {
  it('requests the generic "resource" subType for ordinary content categories (negative)', async () => {
    const savedFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { form: { data: { fields: [] } } } }) };
    }) as unknown as typeof fetch;
    try {
      await new ContentEditorService().readFormFields('Learning Resource', 'save');
      expect((capturedBody?.request as Record<string, unknown>).subType).toBe('resource');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('requests its own subType for Dynamic Course Assessment content, not the generic one (positive)', async () => {
    const savedFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { form: { data: { fields: [] } } } }) };
    }) as unknown as typeof fetch;
    try {
      await new ContentEditorService().readFormFields('Dynamic Course Assessment', 'save');
      expect((capturedBody?.request as Record<string, unknown>).subType).toBe('Dynamic Course Assessment');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.refreshContentBody', () => {
  it('sends lastPublishedBy under request.content, which the refresh-body API requires (positive)', async () => {
    const savedFetch = globalThis.fetch;
    let captured: { url?: string; body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, body: JSON.parse(String(init?.body)) };
      return { ok: true, json: async () => ({ responseCode: 'OK', result: {} }) };
    }) as unknown as typeof fetch;
    try {
      await new ContentEditorService().refreshContentBody('do_1', 'u1');
      expect(captured.url).toContain('content/v3/refresh/body/do_1');
      expect(captured.body).toEqual({ request: { content: { lastPublishedBy: 'u1' } } });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.searchSkillPoolCounts', () => {
  it('counts Live AssessmentItems per skill with the same filters as knowlg-service (no channel, any level) (positive)', async () => {
    const savedFetch = globalThis.fetch;
    const filters: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const f = JSON.parse(String(init?.body)).request.filters;
      filters.push(f);
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { count: f.skill[0] === 'Azure' ? 2 : 30 } }) };
    }) as unknown as typeof fetch;
    try {
      expect(await new ContentEditorService().searchSkillPoolCounts(['Physics', 'Azure'])).toEqual({ Physics: 30, Azure: 2 });
      for (const f of filters) {
        expect(f).toMatchObject({ status: ['Live'], objectType: 'AssessmentItem' });
        expect(f).not.toHaveProperty('channel');
        expect(f).not.toHaveProperty('qlevel');
      }
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.searchAssessmentItemBucketCounts', () => {
  it('counts Live AssessmentItems per skill x level with channel and category, like the job (positive)', async () => {
    const savedFetch = globalThis.fetch;
    const filters: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const f = JSON.parse(String(init?.body)).request.filters;
      filters.push(f);
      const n = { EASY: 4, MEDIUM: 2, DIFFICULT: 1 }[f.qlevel as string] ?? 0;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { count: f.topic[0] === 'A' ? n : n * 10 } }) };
    }) as unknown as typeof fetch;
    try {
      const counts = await new ContentEditorService().searchAssessmentItemBucketCounts(['A', 'B'], 'ch1', 'topic');
      expect(counts).toEqual({ A: { E: 4, M: 2, D: 1 }, B: { E: 40, M: 20, D: 10 } });
      expect(filters).toHaveLength(6);
      for (const f of filters) expect(f).toMatchObject({ status: ['Live'], objectType: 'AssessmentItem', channel: 'ch1' });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('makes no calls when no skills are given (negative)', async () => {
    const savedFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    try {
      expect(await new ContentEditorService().searchAssessmentItemBucketCounts([])).toEqual({});
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
describe('ContentEditorService.readContent body field', () => {
  const capture = async (call: (s: ContentEditorService) => Promise<unknown>) => {
    const savedFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { content: { identifier: 'do_1' } } }) };
    }) as unknown as typeof fetch;
    try { await call(new ContentEditorService()); } finally { globalThis.fetch = savedFetch; }
    return new URL(capturedUrl, 'http://x').searchParams.get('fields')?.split(',') ?? [];
  };

  it('does not request body by default, so ordinary content reads what it always did (negative)', async () => {
    expect(await capture((s) => s.readContent('do_1'))).not.toContain('body');
  });

  it('requests body only when asked, for Dynamic Assess (positive)', async () => {
    expect(await capture((s) => s.readContent('do_1', 'edit', { withBody: true }))).toContain('body');
  });
});

describe('ContentEditorService.readContent caching', () => {
  it('reads with cache: no-store - this page re-reads its own content right after mutating it (save/publish/reject)', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { content: { identifier: 'do_1', name: 'X' } } }) };
    }) as unknown as typeof fetch;
    try {
      await new ContentEditorService().readContent('do_1');
      expect(capturedInit?.cache).toBe('no-store');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('sends Cache-Control: no-cache so an intermediary gateway cache (e.g. Kong proxy-cache) does not serve a pre-mutation response', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { content: { identifier: 'do_1', name: 'X' } } }) };
    }) as unknown as typeof fetch;
    try {
      await new ContentEditorService().readContent('do_1');
      expect((capturedInit?.headers as Record<string, string>)['Cache-Control']).toBe('no-cache');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('leaves other GETs on default browser caching (negative)', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { framework: { categories: [] } } }) };
    }) as unknown as typeof fetch;
    try {
      await new ContentEditorService().readFramework('NCF');
      expect(capturedInit?.cache).toBeUndefined();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService endpoints', () => {
  it('defaults to the verified versions and supports overrides', () => {
    const svc = new ContentEditorService({}, { review: 'content/v9/review' });
    const ep = svc.getEndpoints();
    expect(ep.create).toBe('content/v3/create');
    expect(ep.update).toBe('content/v3/update');
    expect(ep.uploadFinalize).toBe('content/v3/upload');
    expect(ep.collaboratorUpdate).toBe('content/v1/collaborator/update');
    expect(ep.review).toBe('content/v9/review');
  });
  it('uses /action slug and empty base by default', () => {
    const base = new ContentEditorService().getBase();
    expect(base.apiSlug).toBe('/action');
    expect(base.baseUrl).toBe('');
  });
  it('defaults transcript endpoints to the confirmed working versions', () => {
    const ep = new ContentEditorService().getEndpoints();
    expect(ep.transcriptCreate).toBe('content/v4/enrichment/object/create');
    expect(ep.transcriptUpdate).toBe('content/v4/enrichment/object/update');
    expect(ep.transcriptApprove).toBe('content/v4/enrichment/object/approve');
    expect(ep.transcriptReject).toBe('content/v4/enrichment/object/reject');
    expect(ep.transcriptsRead).toBe('content/v1/read');
  });
});

describe('ContentEditorService.createTranscript', () => {
  it('POSTs to transcriptCreate/{id} with an objectType: Transcript body', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { transcriptId: 't1' } }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      const result = await svc.createTranscript('do_1');
      expect(result).toEqual({ transcriptId: 't1' });
      expect(capturedUrl).toBe('/action/content/v4/enrichment/object/create/do_1');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.body).toBe(JSON.stringify({ request: { object: { objectType: 'Transcript' } } }));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.updateTranscript', () => {
  it('PATCHes transcriptUpdate/{contentId}/{transcriptId} with the full segment list', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: {} }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      const segments = [{ id: 0, start: 0, end: 2.5, text: 'Corrected text here' }];
      await svc.updateTranscript('do_2146', 'do_9999', segments);
      expect(capturedUrl).toBe('/action/content/v4/enrichment/object/update/do_2146/do_9999');
      expect(capturedInit?.method).toBe('PATCH');
      expect(capturedInit?.body).toBe(JSON.stringify({ request: { object: { objectType: 'Transcript', segments } } }));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('accepts arbitrary segment fields unmodified (not typed to {id,text,start,end}) - so a caller can round-trip fields it does not itself model', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: {} }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      const segments = [{ id: 0, text: 'Corrected', seek: 400, tokens: [1, 2, 3], avg_logprob: -0.2 }];
      await svc.updateTranscript('do_2146', 'do_9999', segments);
      expect(JSON.parse(String(capturedInit?.body))).toEqual({ request: { object: { objectType: 'Transcript', segments } } });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.approveTranscript / rejectTranscript', () => {
  it('POSTs to transcriptApprove/{contentId}/{transcriptId}', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: {} }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await svc.approveTranscript('do_2146', 'do_9999');
      expect(capturedUrl).toBe('/action/content/v4/enrichment/object/approve/do_2146/do_9999');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.body).toBe(JSON.stringify({ request: { object: { objectType: 'Transcript' } } }));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('POSTs to transcriptReject/{contentId}/{transcriptId}', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: {} }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await svc.rejectTranscript('do_2146', 'do_9999');
      expect(capturedUrl).toBe('/action/content/v4/enrichment/object/reject/do_2146/do_9999');
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.body).toBe(JSON.stringify({ request: { object: { objectType: 'Transcript' } } }));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('surfaces the backend error when the transcript is not in Review (negative)', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      json: async () => ({ responseCode: 'CLIENT_ERROR', params: { err: 'ERR_TRANSCRIPT_NOT_IN_REVIEW', errmsg: 'Transcript is not in Review' } }),
    })) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await expect(svc.approveTranscript('do_2146', 'do_9999')).rejects.toThrow('Transcript is not in Review');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.readTranscripts', () => {
  it('returns content.enrichment.transcripts when present', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        responseCode: 'OK',
        result: { content: { enrichment: { transcripts: [{ language: 'English', status: 'Live' }] } } },
      }),
    })) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      const result = await svc.readTranscripts('do_1');
      expect(result).toEqual([{ language: 'English', status: 'Live' }]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('returns an empty array when enrichment is missing (negative)', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ responseCode: 'OK', result: { content: {} } }),
    })) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      const result = await svc.readTranscripts('do_1');
      expect(result).toEqual([]);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('hits /portal/content/v1/read (not /action) - v1/read only exists via Kong, not direct knowledge-mw', async () => {
    const savedFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { content: {} } }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await svc.readTranscripts('do_1');
      expect(capturedUrl).toBe('/portal/content/v1/read/do_1?fields=identifier&enrich=all');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('throws with the response errmsg when the read fails (negative)', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({ params: { errmsg: 'Content not found' } }),
    })) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await expect(svc.readTranscripts('do_1')).rejects.toThrow('Content not found');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('respects a custom portalSlug from config instead of the hardcoded /portal (fix for a host with a different gateway path)', async () => {
    const savedFetch = globalThis.fetch;
    let capturedUrl = '';
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { content: {} } }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService({ portalSlug: '/gateway-portal' });
      await svc.readTranscripts('do_1');
      expect(capturedUrl).toBe('/gateway-portal/content/v1/read/do_1?fields=identifier&enrich=all');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('sends Cache-Control: no-cache so Kong proxy-cache does not serve a stale pre-approve/reject status', async () => {
    const savedFetch = globalThis.fetch;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return { ok: true, json: async () => ({ responseCode: 'OK', result: { content: {} } }) };
    }) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await svc.readTranscripts('do_1');
      expect((capturedInit?.headers as Record<string, string>)['Cache-Control']).toBe('no-cache');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService config', () => {
  it('honours baseUrl / apiSlug overrides', () => {
    const base = new ContentEditorService({ baseUrl: 'https://api.example.org', apiSlug: '/api' }).getBase();
    expect(base.baseUrl).toBe('https://api.example.org');
    expect(base.apiSlug).toBe('/api');
  });
  it('merges custom headers', () => {
    const base = new ContentEditorService({ headers: { Authorization: 'Bearer t' } }).getBase();
    expect(base.headers.Authorization).toBe('Bearer t');
  });
});

describe('ContentEditorService — malformed response', () => {
  it('treats an unparseable 2xx body as a failure, not a silent success (negative)', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    })) as unknown as typeof fetch;
    try {
      const svc = new ContentEditorService();
      await expect(svc.sendForReview('do_1')).rejects.toThrow(/Malformed response/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

describe('ContentEditorService.readRejectChecklist', () => {
  it('handles a successful response', async () => {
    const mockResponse = {
      responseCode: 'OK',
      result: {
        form: {
          data: {
            fields: [
              {
                title: 'Please check',
                otherReason: 'Other issues',
                contents: [{ name: 'Appropriateness', checkList: ['A', 'B'] }],
              },
            ],
          },
        },
      },
    };

    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ ok: true, json: async () => mockResponse })) as unknown as typeof fetch;

    try {
      const svc = new ContentEditorService();
      const res = await svc.readRejectChecklist();
      expect(res.categories).toEqual([{ name: 'Appropriateness', checkList: ['A', 'B'] }]);
      expect(res.otherReason).toBe('Other issues');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
