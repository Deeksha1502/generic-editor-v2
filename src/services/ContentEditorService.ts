/** ContentEditorService — backend abstraction for the editor; calls go to relative `/action/...` (proxied to knowledge-mw/Kong) by default, overridable via EditorConfig. */
import type { ContentData, EditorContext, EditorConfig, FrameworkCategory, FormField, AssetItem, RawTranscript } from '../types';

/** Keep in sync with useEditor.ts's DYNAMIC_ASSESS_CATEGORY (not imported: the modules don't otherwise depend on each other). */
const DYNAMIC_ASSESS_ECML_CATEGORY = 'Dynamic Course Assessment';

const DEFAULT_ENDPOINTS = {
  /* Versions verified against the portal's ContentService, the old generic editor, and the backend proxy; all hit /action → knowledge-mw. */
  create: 'content/v3/create',
  read: 'content/v3/read',
  update: 'content/v3/update',
  collaboratorUpdate: 'content/v1/collaborator/update',
  presigned: 'content/v3/upload/url',
  uploadFinalize: 'content/v3/upload',
  review: 'content/v3/review',
  publish: 'content/v1/publish',
  reject: 'content/v1/reject',
  lockCreate: 'lock/v1/create',
  lockRetire: 'lock/v1/retire',
  framework: 'framework/v1/read',
  form: 'data/v1/form/read',
  compositeSearch: 'composite/v3/search',
  assetCreate: 'content/v3/create',
  assetUpload: 'content/v3/upload',
  userSearch: 'user/v1/search',
  reviewCommentCreate: 'review/comment/v1/create/comment',
  reviewCommentRead: 'review/comment/v1/read/comment',
  transcriptCreate: 'content/v4/enrichment/object/create',
  transcriptUpdate: 'content/v4/enrichment/object/update',
  transcriptApprove: 'content/v4/enrichment/object/approve',
  transcriptReject: 'content/v4/enrichment/object/reject',
  /* v1, not v3 - only v1+enrich=all via the /portal/* proxy route is confirmed to return enrichment.transcripts (see readTranscripts()'s own comment). */
  transcriptsRead: 'content/v1/read',
  /* Dynamic Assess — triggers the knowlg-publish job's pool-based question selection. */
  refreshBody: 'content/v3/refresh/body',
} as const;

export type EndpointMap = Partial<typeof DEFAULT_ENDPOINTS>;

const READ_FIELDS = [
  'name', 'description', 'mimeType', 'contentType', 'primaryCategory', 'resourceType',
  'status', 'artifactUrl', 'streamingUrl', 'downloadUrl', 'appIcon', 'posterImage',
  'framework', 'board', 'medium', 'gradeLevel', 'subject', 'keywords', 'collaborators',
  'createdBy', 'creator', 'versionKey', 'pkgVersion', 'rejectReasons', 'rejectComment', 'channel',
  /* Dynamic Assess fields (absent on other content); the knowlg-publish job sets totalQuestions and lastUpdatedOn. The selected skills' field depends on the framework, so callers add it via extraFields. */
  'difficultyTarget', 'totalQuestions', 'lastUpdatedOn',
].join(',');

function toArray(val: unknown): string[] | undefined {
  if (val == null) return undefined;
  if (Array.isArray(val)) return val.map(String).filter(Boolean);
  if (typeof val === 'string') {
    const m = val.match(/\[([^\]]*)\]/);
    if (m) return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    return val ? [val] : undefined;
  }
  return undefined;
}

export function normalizeContent(raw: Record<string, unknown>): ContentData {
  return {
    ...raw,
    identifier: String(raw.identifier ?? ''),
    name: String(raw.name ?? ''),
    mimeType: raw.mimeType ? String(raw.mimeType) : undefined,
    artifactUrl: raw.artifactUrl ? String(raw.artifactUrl) : undefined,
    medium: toArray(raw.medium),
    gradeLevel: toArray(raw.gradeLevel),
    subject: toArray(raw.subject),
    keywords: toArray(raw.keywords),
    collaborators: toArray(raw.collaborators),
    rejectReasons: toArray(raw.rejectReasons),
    board: typeof raw.board === 'string' ? raw.board : toArray(raw.board)?.[0],
  } as ContentData;
}

export class ContentEditorService {
  private baseUrl: string;
  private apiSlug: string;
  private portalSlug: string;
  private headers: Record<string, string>;
  private fetchImpl: typeof fetch;
  private ep: typeof DEFAULT_ENDPOINTS;

  constructor(config: EditorConfig = {}, endpoints?: EndpointMap, context?: EditorContext) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/$/, '');
    this.apiSlug = config.apiSlug ?? '/action';
    this.portalSlug = config.portalSlug ?? '/portal';
    // knowledge-mw/lock require these device+client headers on every /action call; explicit config.headers always win.
    const did = context?.did || (typeof localStorage !== 'undefined' ? localStorage.getItem('deviceId') || '' : '');
    const contextHeaders: Record<string, string> = {
      'X-Requested-With': 'XMLHttpRequest',
      ...(did ? { 'X-device-Id': did } : {}),
      // `user-id` is client-supplied and unauthenticated — the backend MUST derive the real
      // identity from the session/keycloak token and never trust this header for authorization.
      ...(context?.uid ? { 'user-id': context.uid } : {}),
    };
    this.headers = {
      'Content-Type': 'application/json',
      ...contextHeaders,
      ...(config.headers ?? {}),
    };
    this.fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : (undefined as never));
    this.ep = { ...DEFAULT_ENDPOINTS, ...(endpoints ?? {}) };
  }

  private url(path: string): string {
    return `${this.baseUrl}${this.apiSlug}/${path}`;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { cache?: RequestCache; headers?: Record<string, string> },
  ): Promise<T> {
    const resp = await this.fetchImpl(this.url(path), {
      method,
      headers: { ...this.headers, ...(opts?.headers ?? {}) },
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(opts?.cache ? { cache: opts.cache } : {}),
    });
    // A malformed/unparseable body must NOT be read as success — every Sunbird action API
    // returns a JSON envelope, so a parse failure means the write likely never landed.
    let data: unknown = {};
    let parseFailed = false;
    try {
      data = await resp.json();
    } catch {
      parseFailed = true;
    }
    const code = (data as { responseCode?: string }).responseCode;
    if (!resp.ok || parseFailed || (code && code !== 'OK' && code !== 'ok')) {
      const errmsg =
        (data as { params?: { errmsg?: string; err?: string } }).params?.errmsg ||
        (parseFailed
          ? `Malformed response (${resp.status}) for ${path}`
          : `Request failed (${resp.status}) for ${path}`);
      const err = new Error(errmsg) as Error & { code?: string; status?: number; body?: unknown };
      err.code = (data as { params?: { err?: string } }).params?.err;
      err.status = resp.status;
      err.body = data;
      throw err;
    }
    return (data as { result?: T }).result as T;
  }

  /** POST content/v1/create — returns new identifier. */
  async createContent(context: EditorContext, props: {
    name?: string;
    mimeType: string;
    primaryCategory: string;
    contentType?: string;
    framework?: string;
  }): Promise<string> {
    const user = context.user;
    const code = `ce-${Date.now()}-${Math.round(Number(String(Date.now()).slice(-4)))}`;
    const content: Record<string, unknown> = {
      name: props.name || 'Untitled Content',
      code,
      mimeType: props.mimeType,
      createdBy: user?.id,
      createdFor: user?.organisationIds,
      contentType: props.contentType || 'Resource',
      resourceType: 'Learn',
      creator: user?.name,
      framework: props.framework || context.framework,
      organisation: user?.organisationNames,
      primaryCategory: props.primaryCategory,
    };
    const result = await this.request<{ identifier?: string; node_id?: string; versionKey?: string }>(
      'POST',
      this.ep.create,
      { request: { content } },
    );
    return String(result.identifier ?? result.node_id ?? '');
  }

  /** GET content/v3/read/{id}?mode=edit — no-store, since this page re-reads its own content right after
   *  mutating it; also sends Cache-Control: no-cache so an intermediary gateway cache (e.g. Kong's
   *  proxy-cache plugin, which honors this request header) doesn't serve a pre-mutation response. */
  async readContent(contentId: string, mode = 'edit', opts: { withBody?: boolean; extraFields?: string[] } = {}): Promise<ContentData> {
    // body and extra fields are opt-in (only Dynamic Assess needs them), so other content reads exactly the fields it always did.
    const extra = [...(opts.withBody ? ['body'] : []), ...(opts.extraFields ?? [])].filter((f) => f && !READ_FIELDS.split(',').includes(f));
    const fields = extra.length ? `${READ_FIELDS},${[...new Set(extra)].join(',')}` : READ_FIELDS;
    const path = `${this.ep.read}/${encodeURIComponent(contentId)}?mode=${mode}&fields=${fields}`;
    const result = await this.request<{ content: Record<string, unknown> }>('GET', path, undefined, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    });
    return normalizeContent(result.content);
  }

  /** PATCH content/v3/update/{id} — partial metadata update. */
  async updateContent(
    contentId: string,
    fields: Record<string, unknown>,
    versionKey?: string,
  ): Promise<{ versionKey?: string; identifier?: string }> {
    const content = versionKey ? { ...fields, versionKey } : fields;
    return this.request('PATCH', `${this.ep.update}/${encodeURIComponent(contentId)}`, {
      request: { content },
    });
  }

  /** POST content/v3/review/{id} — Draft → Review. */
  async sendForReview(contentId: string): Promise<unknown> {
    return this.request('POST', `${this.ep.review}/${encodeURIComponent(contentId)}`, {
      request: { content: {} },
    });
  }

  /** POST content/v3/refresh/body/{id}: queues pool-based question selection; the API rejects a blank lastPublishedBy, same body shape as publish. */
  async refreshContentBody(contentId: string, lastPublishedBy: string): Promise<unknown> {
    return this.request('POST', `${this.ep.refreshBody}/${encodeURIComponent(contentId)}`, {
      request: { content: { lastPublishedBy } },
    });
  }

  /** POST content/v4/enrichment/object/create/{id} — kicks off async transcript generation. */
  async createTranscript(contentId: string): Promise<{ identifier?: string; transcriptId?: string; message?: string }> {
    return this.request('POST', `${this.ep.transcriptCreate}/${encodeURIComponent(contentId)}`, {
      request: { object: { objectType: 'Transcript' } },
    });
  }

  /** PATCH content/v4/enrichment/object/update/{contentId}/{transcriptId} — persists the full segment
   *  list (the API expects the whole set, not a diff). Callers should send back the original segment
   *  objects with only the edited fields changed (not a reconstruction), so unrecognized fields the
   *  parser doesn't know about (Whisper's seek/tokens/... etc.) survive a round-trip - hence `unknown[]`
   *  rather than `TranscriptSegment[]` here. */
  async updateTranscript(contentId: string, transcriptId: string, segments: unknown[]): Promise<unknown> {
    return this.request(
      'PATCH',
      `${this.ep.transcriptUpdate}/${encodeURIComponent(contentId)}/${encodeURIComponent(transcriptId)}`,
      { request: { object: { objectType: 'Transcript', segments } } },
    );
  }

  /** POST content/v4/enrichment/object/approve/{contentId}/{transcriptId} — only valid while Review, else 400s with ERR_TRANSCRIPT_NOT_IN_REVIEW. */
  async approveTranscript(contentId: string, transcriptId: string): Promise<unknown> {
    return this.request(
      'POST',
      `${this.ep.transcriptApprove}/${encodeURIComponent(contentId)}/${encodeURIComponent(transcriptId)}`,
      { request: { object: { objectType: 'Transcript' } } },
    );
  }

  /** POST content/v4/enrichment/object/reject/{contentId}/{transcriptId} — only valid while Review; resets it to Draft. */
  async rejectTranscript(contentId: string, transcriptId: string): Promise<unknown> {
    return this.request(
      'POST',
      `${this.ep.transcriptReject}/${encodeURIComponent(contentId)}/${encodeURIComponent(transcriptId)}`,
      { request: { object: { objectType: 'Transcript' } } },
    );
  }

  /** GET {portalSlug}/content/v1/read/{id}?enrich=all — bypasses this.apiSlug and hits the portal
   *  proxy directly (default '/portal', overridable via config.portalSlug), since v1/read+enrich=all
   *  only works via Kong's proxy, not direct-to-knowledge-mw /action routes. */
  async readTranscripts(contentId: string): Promise<RawTranscript[]> {
    const url = `${this.baseUrl}${this.portalSlug}/${this.ep.transcriptsRead}/${encodeURIComponent(contentId)}?fields=identifier&enrich=all`;
    // no-store (browser-local) + Cache-Control: no-cache (honored by Kong's proxy-cache plugin to
    // bypass its gateway-level cache) - transcript status changes server-side right after approve/
    // reject, so either layer serving a cached response here can show a stale status.
    const resp = await this.fetchImpl(url, {
      method: 'GET',
      headers: { ...this.headers, 'Cache-Control': 'no-cache' },
      credentials: 'same-origin',
      cache: 'no-store',
    });
    let data: { result?: { content?: { enrichment?: { transcripts?: RawTranscript[] } } }; responseCode?: string; params?: { errmsg?: string } } = {};
    let parseFailed = false;
    try { data = await resp.json(); } catch { parseFailed = true; }
    if (!resp.ok || parseFailed || (data.responseCode && data.responseCode !== 'OK' && data.responseCode !== 'ok')) {
      throw new Error(data?.params?.errmsg
        || (parseFailed ? `Malformed response (${resp.status}) for ${url}` : `Request failed (${resp.status}) for ${url}`));
    }
    return data.result?.content?.enrichment?.transcripts ?? [];
  }

  /** POST content/v1/publish/{id} */
  async publishContent(contentId: string, lastPublishedBy: string): Promise<unknown> {
    return this.request('POST', `${this.ep.publish}/${encodeURIComponent(contentId)}`, {
      request: { content: { lastPublishedBy } },
    });
  }

  /** POST content/v1/reject/{id} — request changes. */
  async rejectContent(contentId: string, rejectReasons: string[], rejectComment?: string): Promise<unknown> {
    return this.request('POST', `${this.ep.reject}/${encodeURIComponent(contentId)}`, {
      request: { content: { rejectReasons, ...(rejectComment ? { rejectComment } : {}) } },
    });
  }

  /** PATCH content/v1/collaborator/update/{id} — sets the full collaborator list ({request:{content:{collaborators:[...]}}}, no versionKey). */
  async updateCollaborators(contentId: string, collaborators: string[]): Promise<unknown> {
    return this.request('PATCH', `${this.ep.collaboratorUpdate}/${encodeURIComponent(contentId)}`, {
      request: { content: { collaborators } },
    });
  }

  /** POST lock/v1/create */
  async createLock(contentId: string, context: EditorContext, content: ContentData): Promise<{
    lockKey?: string; expiresAt?: string; expiresIn?: number;
  }> {
    return this.request('POST', this.ep.lockCreate, {
      request: {
        resourceId: contentId,
        resourceType: 'Content',
        resourceInfo: JSON.stringify({
          contentType: content.contentType,
          identifier: contentId,
          mimeType: content.mimeType,
          framework: content.framework,
        }),
        creatorInfo: JSON.stringify({ name: context.user?.name, id: context.user?.id }),
        createdBy: context.user?.id,
      },
    });
  }

  /** DELETE lock/v1/retire */
  async retireLock(contentId: string): Promise<void> {
    await this.request('DELETE', this.ep.lockRetire, {
      request: { resourceId: contentId, resourceType: 'Content' },
    });
  }

  /** GET framework/v1/read/{id} — returns category list for taxonomy cascade. */
  async readFramework(frameworkId: string): Promise<FrameworkCategory[]> {
    const result = await this.request<{ framework: { categories?: FrameworkCategory[] } }>(
      'GET',
      `${this.ep.framework}/${encodeURIComponent(frameworkId)}`,
    );
    return result.framework?.categories ?? [];
  }

  /** POST data/v1/form/read — checklist / form config (publish, review). */
  async readForm(request: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', this.ep.form, { request });
  }

  /** Fetches form field definitions for a content type + action, mirroring the old generic editor's payload, and returns them sorted by `index`. */
  async readFormFields(
    subtype: string,
    action: 'save' | 'review' | 'publish',
    opts: { framework?: string; rootOrgId?: string } = {},
  ): Promise<FormField[]> {
    type FormResp = { form?: { data?: { fields?: FormField[] } } };
    const result = await this.request<FormResp>('POST', this.ep.form, {
      request: {
        type: 'content',
        // Fixed 'resource' subType like the old editor, except Dynamic Assess, whose fields live on a form under its own category.
        subType: subtype === DYNAMIC_ASSESS_ECML_CATEGORY ? subtype : 'resource',
        action,
        framework: opts.framework ?? '*',
        rootOrgId: opts.rootOrgId ?? '*',
        popup: true,
        editMode: true,
      },
    });
    const fields = result?.form?.data?.fields ?? [];
    return [...fields].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  /** Fetches the reject-checklist category columns and optional "Other Issue(s)" label from the form API, mirroring the legacy editor's `requestforchanges` call. */
  async readRejectChecklist(opts: {
    subType?: string;
    framework?: string;
    rootOrgId?: string;
  } = {}): Promise<{
    categories: Array<{ name: string; checkList: string[] }>;
    otherReason?: string;
  }> {
    type FormResp = {
      form?: {
        data?: {
          fields?: Array<{
            contents?: Array<{ name: string; checkList: string[] }>;
            otherReason?: string;
          }>;
        };
      };
    };
    try {
      const result = await this.request<FormResp>('POST', this.ep.form, {
        request: {
          type: 'content',
          subType: opts.subType ?? 'resource',
          action: 'requestforchanges',
          framework: opts.framework ?? '*',
          rootOrgId: opts.rootOrgId ?? '*',
        },
      });
      const field = result?.form?.data?.fields?.[0];
      return {
        categories: field?.contents ?? [],
        otherReason: field?.otherReason,
      };
    } catch {
      return { categories: [] };
    }
  }

  /** Resolves upload content-type options from the save form's `primaryCategory` field range, returning [] on miss/error so callers fall back to config/defaults. */
  async readPrimaryCategories(opts: { framework?: string; rootOrgId?: string } = {}): Promise<string[]> {
    try {
      const fields = await this.readFormFields('resource', 'save', opts);
      const field =
        fields.find((f) => f.code === 'primaryCategory') ??
        fields.find((f) => f.code === 'contentType');
      const range = field?.range ?? [];
      return range.map((r) => r.name).filter((n): n is string => !!n);
    } catch {
      return [];
    }
  }

  /** POST composite/v3/search — image asset browser; `createdBy` filters to "My Images", omit for "All Images". */
  async searchImageAssets(createdBy?: string, query?: string, offset = 0, limit = 50): Promise<AssetItem[]> {
    const filters: Record<string, unknown> = {
      mediaType: ['image'],
      contentType: ['Asset'],
      compatibilityLevel: { min: 1, max: 2 },
      status: ['Live', 'Review', 'Draft'],
    };
    if (createdBy) filters.createdBy = createdBy;
    const result = await this.request<{ content?: Array<Record<string, unknown>> }>(
      'POST',
      this.ep.compositeSearch,
      { request: { filters, ...(query ? { query } : {}), limit, offset } },
    );
    return (result?.content ?? []).map((c) => {
      const variants = c.variants as { medium?: string; low?: string } | undefined;
      const src = String(
        variants?.medium ?? c.downloadUrl ?? c.artifactUrl ?? '',
      );
      return {
        identifier: String(c.identifier ?? ''),
        name: String(c.name ?? ''),
        src,
        thumbnail: String(variants?.low ?? src),
        mediaType: c.mediaType ? String(c.mediaType) : undefined,
        mimeType: c.mimeType ? String(c.mimeType) : undefined,
      };
    });
  }

  /** Live AssessmentItem counts per skill x level, the availability the job allocates from (same channel + category filters). */
  async searchAssessmentItemBucketCounts(
    skills: string[],
    channel?: string,
    categoryField = 'skill',
  ): Promise<Record<string, Record<'E' | 'M' | 'D', number>>> {
    const levels = [['E', 'EASY'], ['M', 'MEDIUM'], ['D', 'DIFFICULT']] as const;
    const pairs = skills.flatMap((skill) => levels.map(([key, qlevel]) => ({ skill, key, qlevel })));
    // limit 1: `count` reflects the total matches regardless of limit.
    const results = await Promise.all(pairs.map(({ skill, qlevel }) => {
      const filters: Record<string, unknown> = { status: ['Live'], objectType: 'AssessmentItem', [categoryField]: [skill], qlevel };
      if (channel) filters.channel = channel;
      return this.request<{ count?: number }>('POST', this.ep.compositeSearch, { request: { filters, fields: ['identifier'], limit: 1 } });
    }));
    const out: Record<string, Record<'E' | 'M' | 'D', number>> = {};
    pairs.forEach(({ skill, key }, i) => {
      out[skill] = out[skill] ?? { E: 0, M: 0, D: 0 };
      out[skill][key] = Number(results[i]?.count ?? 0) || 0;
    });
    return out;
  }

  /** Live AssessmentItems per skill, with the same filters knowlg-service uses to reject a refresh (no channel, any level). */
  async searchSkillPoolCounts(skills: string[], categoryField = 'skill'): Promise<Record<string, number>> {
    const results = await Promise.all(skills.map((skill) => this.request<{ count?: number }>(
      'POST',
      this.ep.compositeSearch,
      { request: { filters: { status: ['Live'], objectType: 'AssessmentItem', [categoryField]: [skill] }, fields: ['identifier'], limit: 1 } },
    )));
    return Object.fromEntries(skills.map((skill, i) => [skill, Number(results[i]?.count ?? 0) || 0]));
  }

  /** Live system-default frameworks for the Framework picker, channel-scoped via X-Channel-Id, same as question-set editor-v2's searchFrameworks. */
  async searchFrameworks(channel?: string): Promise<Array<{ identifier: string; name: string }>> {
    const result = await this.request<{ Framework?: Array<Record<string, unknown>> }>(
      'POST',
      this.ep.compositeSearch,
      { request: { filters: { objectType: 'Framework', status: ['Live'], systemDefault: 'Yes' } } },
      channel ? { headers: { 'X-Channel-Id': channel } } : undefined,
    );
    return (result?.Framework ?? [])
      .map((f) => ({ identifier: String(f.identifier ?? ''), name: String(f.name ?? f.identifier ?? '') }))
      .filter((f) => f.identifier);
  }

  /** Creates an image Asset record then uploads the file to it (asset/v1/create → asset/v1/upload/{id}), returning the artifact URL. */
  async uploadImageAsset(file: File, context: EditorContext): Promise<string> {
    const created = await this.request<{ identifier?: string; node_id?: string }>(
      'POST',
      this.ep.create,
      {
        request: {
          content: {
            name: file.name,
            code: `asset-${Date.now()}`,
            mimeType: file.type || 'image/png',
            mediaType: 'image',
            contentType: 'Asset',
            primaryCategory: 'Asset',
            creator: context.user?.name,
            createdBy: context.user?.id,
            channel: context.channel,
          },
        },
      },
    );
    const assetId = String(created.identifier ?? created.node_id ?? '');
    if (!assetId) throw new Error('Asset create failed');

    const form = new FormData();
    form.append('file', file);
    // Multipart upload: drop the JSON Content-Type so the browser sets the boundary.
    const { 'Content-Type': _ct, ...rest } = this.headers;
    const resp = await this.fetchImpl(this.url(`${this.ep.assetUpload}/${encodeURIComponent(assetId)}`), {
      method: 'POST',
      headers: rest,
      credentials: 'same-origin',
      body: form,
    });
    const data = await resp.json().catch(() => ({}));
    const url = (data as { result?: { artifactUrl?: string; content_url?: string } }).result?.artifactUrl
      ?? (data as { result?: { content_url?: string } }).result?.content_url;
    if (!resp.ok || !url) throw new Error('Asset upload failed');
    return String(url);
  }

  /** POST user/v1/search?fields=orgName — fetches the full CONTENT_CREATOR user pool for the org; the drawer marks which are already collaborators. */
  async searchUsers(query = '', rootOrgId?: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{ response?: { content?: Array<Record<string, unknown>> } }>(
      'POST',
      `${this.ep.userSearch}?fields=orgName`,
      {
        request: {
          query,
          filters: {
            'organisations.roles': ['CONTENT_CREATOR'],
            rootOrgId: rootOrgId ? [rootOrgId] : [],
          },
          fields: ['email', 'firstName', 'identifier', 'lastName', 'organisations', 'rootOrgName', 'phone'],
          offset: 0,
          limit: 200,
        },
      },
    );
    return result.response?.content ?? [];
  }

  /** POST review comments. */
  async createReviewComment(payload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', this.ep.reviewCommentCreate, { request: payload });
  }
  async readReviewComments(payload: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', this.ep.reviewCommentRead, { request: payload });
  }

  /** Raw access for UploadService (presigned URL + finalize). */
  getEndpoints(): typeof DEFAULT_ENDPOINTS { return this.ep; }
  getBase(): { baseUrl: string; apiSlug: string; headers: Record<string, string>; fetchImpl: typeof fetch } {
    return { baseUrl: this.baseUrl, apiSlug: this.apiSlug, headers: this.headers, fetchImpl: this.fetchImpl };
  }
}
