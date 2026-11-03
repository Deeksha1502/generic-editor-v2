import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import EditorPreview, { rendererData } from './EditorPreview';
import { makeEd, mockContext, mockContent } from '../test/mockEd';

describe('<EditorPreview />', () => {
  it('renders nothing when there is no content (negative)', () => {
    const ed = makeEd({ content: null });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the content name and a localized mimeType label', () => {
    const ed = makeEd({ content: mockContent });
    render(<EditorPreview ed={ed} context={mockContext} />);
    expect(screen.getByText('Sample content')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();     // application/pdf → PDF
    expect(screen.getByText('Preview mode')).toBeInTheDocument();
  });

  it('builds the renderer iframe src with webview=true', () => {
    const ed = makeEd({ content: mockContent, previewUrl: '/content/preview/preview.html' });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe).toHaveAttribute('src', '/content/preview/preview.html?webview=true');
    expect(iframe).toHaveAttribute('title', 'Sample content');
  });

  it('appends webview with & when previewUrl already has a query', () => {
    const ed = makeEd({ content: mockContent, previewUrl: '/preview.html?foo=1' });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    expect(container.querySelector('iframe')).toHaveAttribute('src', '/preview.html?foo=1&webview=true');
  });

  it('renders the iframe immediately for non-video content regardless of transcriptsChecked', () => {
    const ed = makeEd({ content: mockContent, transcriptsChecked: false }); // mockContent is application/pdf
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    expect(container.querySelector('iframe')).toBeInTheDocument();
  });

  it('shows a loading state instead of the iframe for video content until transcripts have been checked at least once (negative)', () => {
    const videoContent = { ...mockContent, mimeType: 'video/mp4' };
    const ed = makeEd({ content: videoContent, transcriptsChecked: false, transcripts: [] });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    expect(container.querySelector('iframe')).not.toBeInTheDocument();
    expect(container.querySelector('.ce-spinner')).toBeInTheDocument();
  });

  it('renders the iframe for video content once transcriptsChecked is true, even with zero transcripts', () => {
    const videoContent = { ...mockContent, mimeType: 'video/mp4' };
    const ed = makeEd({ content: videoContent, transcriptsChecked: true, transcripts: [] });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    expect(container.querySelector('iframe')).toBeInTheDocument();
  });

  it('does not treat a transcript with no status as Live (negative)', () => {
    const videoContent = { ...mockContent, mimeType: 'video/mp4' };
    const ed1 = makeEd({
      content: videoContent,
      transcriptsChecked: true,
      transcripts: [{ code: 'c_en', language: 'English', languageCode: 'en', captionsUrl: 'https://x/en.vtt' }], // no status
    });
    const { container, rerender } = render(<EditorPreview ed={ed1} context={mockContext} />);
    const withoutStatusIframe = container.querySelector('iframe');

    const ed2 = makeEd({
      content: videoContent,
      transcriptsChecked: true,
      transcripts: [],
    });
    rerender(<EditorPreview ed={ed2} context={mockContext} />);
    const emptyIframe = container.querySelector('iframe');
    // Same remount key either way, since a status-less entry must be excluded just like an empty list.
    expect(emptyIframe).toBe(withoutStatusIframe);
  });

  it('remounts the iframe (new DOM node) when the live-caption set changes at equal length', () => {
    const videoContent = { ...mockContent, mimeType: 'video/mp4' };
    const ed1 = makeEd({
      content: videoContent,
      transcriptsChecked: true,
      transcripts: [{ code: 'c_en', language: 'English', languageCode: 'en', captionsUrl: 'https://x/en.vtt', status: 'Live' }],
    });
    const { container, rerender } = render(<EditorPreview ed={ed1} context={mockContext} />);
    const firstIframe = container.querySelector('iframe');

    const ed2 = makeEd({
      content: videoContent,
      transcriptsChecked: true,
      transcripts: [{ code: 'c_fr', language: 'French', languageCode: 'fr', captionsUrl: 'https://x/fr.vtt', status: 'Live' }],
    });
    rerender(<EditorPreview ed={ed2} context={mockContext} />);
    const secondIframe = container.querySelector('iframe');
    expect(secondIframe).not.toBe(firstIframe);
  });

  it('hands the ECML body to the renderer as data, so a generated Dynamic Assess lesson can play (positive)', () => {
    const body = '{"theme":{"id":"theme","stage":[]}}';
    const ed = makeEd({ isDynamicAssess: true, content: { ...mockContent, mimeType: 'application/vnd.ekstep.ecml-archive', artifactUrl: undefined, body } });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    const iframe = container.querySelector('iframe')!;
    const initializePreview = vi.fn();
    (iframe.contentWindow as unknown as { initializePreview: typeof initializePreview }).initializePreview = initializePreview;
    fireEvent.load(iframe);
    expect(initializePreview).toHaveBeenCalledWith(expect.objectContaining({ data: { theme: { id: 'theme', stage: [] } } }));
  });

  it('gives the renderer only the draw in metadata.body too, never the full pool (positive)', () => {
    const ids = ['a1', 'a2', 'a3'];
    const body = JSON.stringify({ theme: { stage: [{ 'org.ekstep.questionset': [{
      config: { __cdata: JSON.stringify({ dynamic_assess: { target: { E: 1, M: 0, D: 0 }, levels: Object.fromEntries(ids.map((id) => [id, 'EASY'])) } }) },
      data: { __cdata: JSON.stringify(ids.map((id) => ({ identifier: id }))) },
      'org.ekstep.question': ids.map((id) => ({ id })),
    }] }] } });
    const ed = makeEd({ isDynamicAssess: true, content: { ...mockContent, mimeType: 'application/vnd.ekstep.ecml-archive', artifactUrl: undefined, body } });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    const iframe = container.querySelector('iframe')!;
    const initializePreview = vi.fn();
    (iframe.contentWindow as unknown as { initializePreview: typeof initializePreview }).initializePreview = initializePreview;
    fireEvent.load(iframe);
    const cfg = initializePreview.mock.calls[0]![0] as { metadata: { body: string }; data: unknown };
    const quiz = JSON.parse(cfg.metadata.body).theme.stage[0]['org.ekstep.questionset'][0];
    expect(quiz['org.ekstep.question']).toHaveLength(1);
    expect(JSON.parse(cfg.metadata.body)).toEqual(cfg.data);
  });

  it('passes ordinary content metadata through untouched (negative)', () => {
    const ed = makeEd({ isDynamicAssess: false, content: mockContent });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    const iframe = container.querySelector('iframe')!;
    const initializePreview = vi.fn();
    (iframe.contentWindow as unknown as { initializePreview: typeof initializePreview }).initializePreview = initializePreview;
    fireEvent.load(iframe);
    expect(initializePreview).toHaveBeenCalledWith(expect.objectContaining({ metadata: mockContent, data: {} }));
  });

  it('keeps passing empty data for regular ECML, so its preview loads exactly as before (negative)', () => {
    const body = '{"theme":{"id":"theme","stage":[]}}';
    const ed = makeEd({ isDynamicAssess: false, content: { ...mockContent, mimeType: 'application/vnd.ekstep.ecml-archive', body } });
    const { container } = render(<EditorPreview ed={ed} context={mockContext} />);
    const iframe = container.querySelector('iframe')!;
    const initializePreview = vi.fn();
    (iframe.contentWindow as unknown as { initializePreview: typeof initializePreview }).initializePreview = initializePreview;
    fireEvent.load(iframe);
    expect(initializePreview).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
  });
});

describe('rendererData', () => {
  it('parses a JSON-string body and passes an object body through (positive)', () => {
    expect(rendererData('{"theme":{}}')).toEqual({ theme: {} });
    expect(rendererData({ theme: {} })).toEqual({ theme: {} });
  });

  it('falls back to {} with no body, and keeps a non-JSON (XML) body as-is (negative)', () => {
    expect(rendererData(undefined)).toEqual({});
    expect(rendererData('')).toEqual({});
    expect(rendererData('<theme></theme>')).toBe('<theme></theme>');
  });
});
