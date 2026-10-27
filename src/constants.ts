/** Sunbird Content Editor v2 — shared constants. */

export const TELEMETRY_VERSION = '3.0';

/** Dynamic Assess: each difficulty needs requested x this many Live questions; fallback for content without its own multiplier (the backend's dynamicassess.multiplier default). */
export const DYNAMIC_ASSESS_POOL_MULTIPLIER = 2;

/** Dynamic Assess: each selected skill must contribute at least this many questions; fallback for content without its own minCriteria (the backend's dynamicassess.minCriteria default). */
export const DYNAMIC_ASSESS_MIN_CRITERIA = 2;

/** Default content category options shown in the upload content-type picker.
 *  Mirrors portal editorConfig.DEFAULT_PRIMARY_CATEGORIES (subset relevant to upload). */
export const DEFAULT_PRIMARY_CATEGORIES = [
  'eTextbook',
  'Explanation Content',
  'Learning Resource',
  'Practice Question Set',
  'Teacher Resource',
  'Exam Question',
] as const;

/** File extension → mimeType. zip resolved further (SCORM vs HTML vs H5P) at detect time. */
export const EXTENSION_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub',
  mp4: 'video/mp4',
  webm: 'video/webm',
  h5p: 'application/vnd.ekstep.h5p-archive',
  zip: 'application/vnd.ekstep.html-archive',
};

export const MIME_HTML = 'application/vnd.ekstep.html-archive';
export const MIME_H5P = 'application/vnd.ekstep.h5p-archive';
export const MIME_SCORM = 'application/vnd.ekstep.scorm-archive';
export const MIME_YOUTUBE = 'video/x-youtube';
export const MIME_URL = 'text/x-url';

/** Accepted upload extensions (for the dropzone hint + file picker). */
export const ACCEPTED_EXTENSIONS = ['pdf', 'mp4', 'epub', 'webm', 'h5p', 'zip'] as const;

/** Extensions that map to a video/* mimeType - gate the "generate transcripts?" prompt. */
export const VIDEO_EXTENSIONS = ['mp4', 'webm'] as const;

/** mimeTypes that get a transcript checkbox (upload confirm + Edit Content Details). */
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;

export function isVideoMimeType(mimeType?: string): boolean {
  return !!mimeType && (VIDEO_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Default max upload size in MB (configurable via EditorConfig.maxFileSizeMB). */
export const DEFAULT_MAX_FILE_SIZE_MB = 150;

/** Large-content upload mode (EditorConfig.largeUpload): video + zip/SCORM only.
 *  Mirrors org.ekstep.uploadlargecontent — mp4/webm/zip, 15 GB cap. */
export const LARGE_UPLOAD_EXTENSIONS = ['mp4', 'webm', 'zip'] as const;
export const LARGE_UPLOAD_MAX_MB = 15 * 1024; // 15 GB

/** Chunked-upload tuning (Azure block blob), mirrors org.ekstep.uploadlargecontent. */
export const CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const CHUNK_RETRY_LIMIT = 10;
export const CHUNK_RETRY_DELAY_MS = 2000;
/** Files above this size use the chunked block-upload path. */
export const CHUNK_THRESHOLD_BYTES = CHUNK_SIZE_BYTES;
/** H5P content needs server-side processing time before reload. */
export const H5P_UPLOAD_DELAY_MS = 25_000;

/** Idle duration before the "session timed out" prompt appears (30 min). */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Content lifecycle statuses. */
export const STATUS = {
  DRAFT: 'Draft',
  REVIEW: 'Review',
  LIVE: 'Live',
  FLAGGED: 'Flagged',
  RETIRED: 'Retired',
} as const;

/** Editor event ids emitted via onEvent. */
export const EDITOR_EVENTS = {
  READY: 'editor:ready',
  CONTENT_CREATED: 'editor:content-created',
  UPLOAD_START: 'editor:upload-start',
  UPLOAD_PROGRESS: 'editor:upload-progress',
  UPLOAD_COMPLETE: 'editor:upload-complete',
  SAVED: 'editor:saved',
  SENT_FOR_REVIEW: 'editor:sent-for-review',
  PUBLISHED: 'editor:published',
  REJECTED: 'editor:rejected',
  COLLABORATORS_UPDATED: 'editor:collaborators-updated',
  CLOSED: 'editor:closed',
  ERROR: 'editor:error',
} as const;
