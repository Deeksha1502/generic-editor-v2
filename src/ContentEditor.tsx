/** ContentEditor — the editor root component; render with a `context`, optional `contentId` (omit for a new upload), and its `onClose`/`onTelemetryEvent` callbacks. */
import React from 'react';
import './editor.scss';
import { useEditor, type UseEditorOptions } from './useEditor';
import { getDir } from './i18n/i18n';
import Header from './components/Header';
import UploadCanvas from './components/UploadCanvas';
import EditorPreview from './components/EditorPreview';
import MetadataDrawer from './components/MetadataDrawer';
import CollaboratorDrawer from './components/CollaboratorDrawer';
import ReviewDrawer from './components/ReviewDrawer';
import ReviewCommentsDrawer from './components/ReviewCommentsDrawer';
import TranscriptsDrawer from './components/TranscriptsDrawer';
import AssetPickerModal from './components/AssetPickerModal';
import Toast from './components/Toast';
import { t } from './i18n/i18n';
import { CheckIcon, InfoIcon, RefreshIcon } from './icons';

export type ContentEditorProps = UseEditorOptions;

const ContentEditor: React.FC<ContentEditorProps> = (props) => {
  const ed = useEditor(props);
  const dir = getDir(ed.lang);

  return (
    <div className="ce-editor" dir={dir} data-view={ed.view}>
      <Header ed={ed} />

      <main className="ce-main">
        {ed.view === 'loading' && (
          <div className="ce-center">
            <div className="ce-spinner" />
          </div>
        )}
        {(ed.view === 'upload' || ed.view === 'uploading') && (
          <div className="ce-upload-overlay"><UploadCanvas ed={ed} /></div>
        )}
        {ed.view === 'player' && ed.isDynamicAssess && !ed.hasGeneratedBody && (
          <div className="ce-center">
            <RefreshIcon size={32} />
            <p>{t(ed.lang, 'DYNAMIC_ASSESS_EMPTY_TITLE')}</p>
            {/* Only an editor can save details (which generates); reviewers/readers just see it's empty. */}
            <p>{t(ed.lang, ed.mode === 'edit' ? 'DYNAMIC_ASSESS_EMPTY_SUB' : 'DYNAMIC_ASSESS_EMPTY_SUB_READONLY')}</p>
            {ed.mode === 'edit' && (
              <button type="button" className="ce-btn ce-btn--primary" onClick={() => ed.setDrawer('metadata')}>
                {t(ed.lang, 'EDIT_DETAILS')}
              </button>
            )}
          </div>
        )}
        {/* Only when the saved settings don't match the questions and nothing is regenerating, e.g. a failed or older generation. */}
        {ed.view === 'player' && ed.dynamicAssessStale && !ed.dynamicAssessRefreshing && (
          <div className="ce-stale-banner" role="alert">
            <span className="ce-stale-banner-ic" aria-hidden="true"><InfoIcon size={17} /></span>
            <div className="ce-stale-banner-tx">
              <p className="ce-stale-banner-title">{t(ed.lang, 'DYNAMIC_ASSESS_STALE_TITLE')}</p>
              <p className="ce-stale-banner-sub">{t(ed.lang, ed.mode === 'edit' ? 'DYNAMIC_ASSESS_STALE_SUB' : 'DYNAMIC_ASSESS_STALE_SUB_READONLY')}</p>
            </div>
          </div>
        )}
        {ed.view === 'player' && !(ed.isDynamicAssess && !ed.hasGeneratedBody) && (
          <EditorPreview ed={ed} context={props.context} />
        )}
      </main>

      <div className="ce-backdrop" data-open={ed.drawer !== null} onClick={() => ed.setDrawer(null)} />

      <MetadataDrawer ed={ed} />
      <CollaboratorDrawer ed={ed} />
      <ReviewDrawer ed={ed} />
      <ReviewCommentsDrawer ed={ed} />
      <TranscriptsDrawer ed={ed} />
      <AssetPickerModal ed={ed} />

      <Toast toast={ed.toast} />

      {/* Inactivity / session timeout prompt */}
      {ed.sessionExpired && (
        <div className="ce-session-overlay">
          <div className="ce-session-card">
            <p className="ce-session-title">{t(ed.lang, 'SESSION_TITLE')}</p>
            <p className="ce-session-msg">{t(ed.lang, 'SESSION_MSG')}</p>
            <div className="ce-session-actions">
              <button type="button" className="ce-btn ce-btn--ghost" onClick={ed.close}>
                {t(ed.lang, 'CLOSE_EDITOR')}
              </button>
              <button type="button" className="ce-btn ce-btn--primary" onClick={ed.dismissSessionExpiry}>
                {t(ed.lang, 'CONTINUE_EDITING')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Blocks editing while the job writes the quiz, so a stale save can't race it. */}
      {ed.isDynamicAssess && ed.dynamicAssessRefreshing && (
        <div className="ce-generating-overlay" role="status" aria-live="polite">
          <div className="ce-generating-card">
            <div className="ce-spinner ce-spinner--sm" />
            <p className="ce-generating-title">{t(ed.lang, 'DYNAMIC_ASSESS_GENERATING_TITLE')}</p>
            <p className="ce-generating-sub">{t(ed.lang, 'DYNAMIC_ASSESS_GENERATING_SUB')}</p>
          </div>
        </div>
      )}

      {/* Upload success overlay */}
      {ed.uploadSuccess && (
        <div className="ce-upload-success-overlay">
          <div className="ce-upload-success-card">
            <div className="ce-upload-success-icon"><CheckIcon size={28} /></div>
            <p className="ce-upload-success-title">{t(ed.lang, 'UPLOAD_SUCCESS_TITLE')}</p>
            <p className="ce-upload-success-sub">{t(ed.lang, 'UPLOAD_SUCCESS_SUB')}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContentEditor;
