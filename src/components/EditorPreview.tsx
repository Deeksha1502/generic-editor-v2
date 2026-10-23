import React, { useRef } from 'react';
import type { EditorController } from '../useEditor';
import type { ContentData, EditorContext, RawTranscript } from '../types';
import { getMimeTypeLabel, t } from '../i18n/i18n';
import { FileIcon } from '../icons';
import { isVideoMimeType } from '../constants';
import { ecmlBodyForUser } from '../dynamicAssessDraw';

interface PlayerTranscript {
  language: string;
  identifier: string;
  languageCode: string;
  artifactUrl: string;
  wordByWordUrl?: string;
  sourceLanguage?: boolean;
}

/** Maps raw enrichment.transcripts into the shape sunbird-video-player expects, mirroring
 *  the portal's ContentService mapping (artifactUrl here is the VTT, not transcript.json).
 *  Requires an explicit 'Live' status - a missing status is treated the same safe way
 *  TranscriptsDrawer.statusTone does (not-yet-approved), never served as a live caption. */
function mapRawTranscripts(raw: RawTranscript[]): PlayerTranscript[] {
  return raw
    .filter((e): e is RawTranscript & { captionsUrl: string } =>
      !!e.captionsUrl && e.status === 'Live')
    .map((e) => ({
      language: e.language || (e.languageCode || 'Unknown').toUpperCase(),
      identifier: e.code ?? e.identifier ?? '',
      languageCode: e.languageCode || '',
      artifactUrl: e.captionsUrl,
      wordByWordUrl: e.captionsUrl,
      sourceLanguage: !!e.sourceLanguage,
    }));
}

/** The ECML renderer reads the lesson from `data` (as the portal's EcmlPlayerService passes metadata.body); the API returns the body JSON-stringified. */
export function rendererData(body: unknown): unknown {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string' && body.trim()) {
    try { return JSON.parse(body); } catch { return body; }
  }
  return {};
}

/** Preview via the legacy ekstep content renderer (all mimeTypes through its coreplugins), loaded in an iframe and driven via its global `initializePreview()`. */
const RendererPreview: React.FC<{
  content: ContentData; context: EditorContext; previewUrl: string; previewConfig: Record<string, unknown>; isDynamicAssess?: boolean;
}> = ({ content, context, previewUrl, previewConfig, isDynamicAssess = false }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const src = `${previewUrl}${previewUrl.includes('?') ? '&' : '?'}webview=true`;

  const onLoad = () => {
    const win = iframeRef.current?.contentWindow as
      | (Window & { initializePreview?: (cfg: unknown) => void })
      | null;
    if (!win || typeof win.initializePreview !== 'function') return;
    const rawBody = (content as Record<string, unknown>).body;
    // Only Dynamic Assess renders from its generated body (the user's own draw, never the whole pool); other content keeps the renderer's own loading.
    const data = isDynamicAssess ? ecmlBodyForUser(rendererData(rawBody), content.identifier, context.user?.id) : {};
    // metadata.body carries the same draw, like the portal's ecmlForLearner, so the full pool never reaches the renderer.
    const metadata = isDynamicAssess && rawBody
      ? { ...content, body: typeof rawBody === 'string' && data && typeof data === 'object' ? JSON.stringify(data) : data }
      : content;
    win.initializePreview({
      context: {
        mode: 'edit',
        contentId: content.identifier,
        sid: context.sid,
        uid: context.uid,
        channel: context.channel,
        pdata: context.pdata,
        app: [],
        dims: [],
        partner: [],
      },
      config: previewConfig,
      metadata,
      data,
    });
  };

  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={content.name}
      onLoad={onLoad}
      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
      allow="autoplay; fullscreen; encrypted-media"
    />
  );
};

const EditorPreview: React.FC<{ ed: EditorController; context: EditorContext }> = ({ ed, context }) => {
  const { content, lang, previewUrl, previewConfig, transcripts: rawTranscripts, transcriptsChecked } = ed;

  if (!content) return null;

  const isVideo = isVideoMimeType(content.mimeType);
  const transcripts = mapRawTranscripts(rawTranscripts);
  // The iframe key changes only when the actual live-caption set changes (not just its
  // count), so a same-count swap (one language leaves Live as another joins) still remounts.
  const transcriptsKey = transcripts.map((tr) => tr.identifier).sort().join(',');
  const previewMetadata = transcripts.length ? { ...content, transcripts } : content;

  return (
    <div className="ce-preview-card">
      <div className="ce-preview-bar">
        <div className="ce-icon-sq"><FileIcon size={12} /></div>
        <span className="ce-preview-name">{content.name}</span>
        <span className="ce-preview-type">{getMimeTypeLabel(lang, content.mimeType)}</span>
        <span className="ce-preview-chip">{t(lang, 'PREVIEW_MODE')}</span>
      </div>
      <div className="ce-preview-frame">
        {isVideo && !transcriptsChecked ? (
          // Wait for the first transcripts check before ever mounting the renderer, so a
          // slow initial read can't yank the iframe out (and restart playback) right after
          // the user presses play - by the time it first mounts, this is already settled.
          <div className="ce-center" style={{ height: '100%' }}>
            <div className="ce-spinner ce-spinner--sm" />
          </div>
        ) : (
          <RendererPreview
            // A regenerated ECML body has no new artifactUrl, so lastUpdatedOn (set by the job) is what remounts the player onto it.
            key={`${content.identifier}-${content.artifactUrl ?? ''}-${transcriptsKey}${ed.isDynamicAssess ? `-${String(content.lastUpdatedOn ?? '')}` : ''}`}
            content={previewMetadata}
            isDynamicAssess={ed.isDynamicAssess}
            context={context}
            previewUrl={previewUrl}
            previewConfig={previewConfig}
          />
        )}
      </div>
    </div>
  );
};

export default EditorPreview;
