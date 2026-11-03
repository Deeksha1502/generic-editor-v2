import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ContentEditor from './ContentEditor';
import type { ContentEditorService } from './services/ContentEditorService';
import { mockContext, mockContent } from './test/mockEd';

/** A fake service covering everything useEditor touches on mount. */
function svc(over: Record<string, unknown> = {}) {
  return {
    readPrimaryCategories: vi.fn().mockResolvedValue(['eTextbook', 'Learning Resource']),
    readContent: vi.fn().mockResolvedValue(mockContent),
    createLock: vi.fn().mockResolvedValue({}),
    retireLock: vi.fn().mockResolvedValue(undefined),
    readFormFields: vi.fn().mockResolvedValue([]),
    readFramework: vi.fn().mockResolvedValue([]),
    searchFrameworks: vi.fn().mockResolvedValue([]),
    getBase: () => ({ baseUrl: '', apiSlug: '/action', headers: {}, fetchImpl: fetch }),
    getEndpoints: () => ({}),
    ...over,
  } as unknown as ContentEditorService;
}

describe('<ContentEditor /> — new upload', () => {
  it('renders the upload UI when no contentId is given', async () => {
    render(<ContentEditor context={mockContext} service={svc()} onClose={vi.fn()} />);
    expect(await screen.findByText('Upload content')).toBeInTheDocument();
    expect(screen.getByText('What are you uploading?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Editor' })).toBeInTheDocument();
  });
});

describe('<ContentEditor /> — existing content', () => {
  it('loads the content, shows the preview, and locks it on open', async () => {
    const service = svc();
    render(<ContentEditor context={mockContext} contentId="do_1" service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(service.readContent).toHaveBeenCalledWith('do_1'));
    // Preview bar shows the content name (also in the header) + type.
    await waitFor(() => expect(screen.getAllByText('Sample content').length).toBeGreaterThan(0));
    expect(screen.getByText('PDF')).toBeInTheDocument();
    // Lock created for an editable draft opened by its creator.
    await waitFor(() => expect(service.createLock).toHaveBeenCalled());
  });

  it('surfaces a load error toast when read fails (negative)', async () => {
    const service = svc({ readContent: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<ContentEditor context={mockContext} contentId="do_x" service={service} onClose={vi.fn()} />);
    expect(await screen.findByText('Failed to load content.')).toBeInTheDocument();
  });
});

describe('<ContentEditor /> — Dynamic Assess empty state', () => {
  it('shows a placeholder instead of the legacy player when no body has been generated yet (positive)', async () => {
    const service = svc({
      readContent: vi.fn().mockResolvedValue({
        ...mockContent,
        primaryCategory: 'Dynamic Course Assessment',
        totalQuestions: 0,
      }),
    });
    render(<ContentEditor context={mockContext} contentId="do_da_1" service={service} onClose={vi.fn()} />);
    expect(await screen.findByText('No questions generated yet')).toBeInTheDocument();
    expect(screen.getByText(/save to generate the questions/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.queryByText('PDF')).not.toBeInTheDocument();
  });

  it('shows the normal preview once the job has written questions, even for a never-published Draft (negative)', async () => {
    const service = svc({
      readContent: vi.fn().mockResolvedValue({
        ...mockContent,
        primaryCategory: 'Dynamic Course Assessment',
        status: 'Draft',
        pkgVersion: 0,
        totalQuestions: 3,
      }),
    });
    render(<ContentEditor context={mockContext} contentId="do_da_2" service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('Sample content').length).toBeGreaterThan(0));
    expect(screen.queryByText('No questions generated yet')).not.toBeInTheDocument();
  });

  it('does not point a reviewer at a Generate button they do not have (positive)', async () => {
    const service = svc({
      readContent: vi.fn().mockResolvedValue({
        ...mockContent,
        primaryCategory: 'Dynamic Course Assessment',
        status: 'Review',
        totalQuestions: 0,
      }),
    });
    const reviewerContext = { ...mockContext, user: { ...mockContext.user!, roles: ['CONTENT_REVIEWER'] } };
    render(<ContentEditor context={reviewerContext} contentId="do_da_3" service={service} onClose={vi.fn()} />);
    expect(await screen.findByText('No questions have been generated for this content yet.')).toBeInTheDocument();
    expect(screen.queryByText(/save to generate the questions/)).not.toBeInTheDocument();
  });
});

describe('<ContentEditor /> — Dynamic Assess generating overlay', () => {
  const staleBody = JSON.stringify({
    theme: { stage: [{ 'org.ekstep.questionset': { config: { __cdata: JSON.stringify({ dynamic_assess: { skills: ['Physics'], target: { E: 2, M: 0, D: 0 } } }) } } }] },
  });
  const daContent = (over: Record<string, unknown> = {}) => ({
    ...mockContent,
    primaryCategory: 'Dynamic Course Assessment',
    totalQuestions: 3,
    lastUpdatedOn: 't0',
    skill: ['Physics'],
    difficultyTarget: '{"E":1,"M":1,"D":1}',
    body: staleBody,
    ...over,
  });

  it('shows a blocking loader while questions generate and removes it once the job writes (positive)', async () => {
    let written = false;
    const service = svc({
      readContent: vi.fn().mockImplementation(async () => daContent(written ? { lastUpdatedOn: 't1' } : {})),
      refreshContentBody: vi.fn().mockResolvedValue({}),
    });
    render(<ContentEditor context={mockContext} contentId="do_da_4" service={service} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Regenerate/ }));
    expect(await screen.findByRole('status')).toHaveTextContent('Generating questions');
    // The settings banner stays hidden behind the loader while generating.
    expect(screen.queryByText('Settings changed since the questions were generated')).not.toBeInTheDocument();
    written = true;
    await waitFor(() => expect(screen.queryByText('Generating questions')).not.toBeInTheDocument(), { timeout: 8000 });
    expect(await screen.findByText('Questions generated')).toBeInTheDocument();
  }, 10000);

  it('never shows the loader or a Generate button for ordinary content (negative)', async () => {
    render(<ContentEditor context={mockContext} contentId="do_1" service={svc()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('Sample content').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Generating questions')).not.toBeInTheDocument();
  });
});

describe('<ContentEditor /> — Dynamic Assess stale settings banner', () => {
  const generatedBody = JSON.stringify({
    theme: { stage: [{ 'org.ekstep.questionset': { config: { __cdata: JSON.stringify({ dynamic_assess: { skills: ['Physics'], target: { E: 3, M: 3, D: 3 } } }) } } }] },
  });
  const daContent = (over: Record<string, unknown> = {}) => ({
    ...mockContent, primaryCategory: 'Dynamic Course Assessment', totalQuestions: 9,
    skill: ['Physics'], difficultyTarget: '{"E":3,"M":3,"D":3}', body: generatedBody, ...over,
  });

  it('warns the creator and disables Send for Review when settings changed after generation (positive)', async () => {
    const service = svc({ readContent: vi.fn().mockResolvedValue(daContent({ difficultyTarget: '{"E":3,"M":2,"D":3}' })) });
    render(<ContentEditor context={mockContext} contentId="do_da_6" service={service} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings changed since the questions were generated');
    expect(screen.getByText(/Click Regenerate to update them/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send for review/i })).toBeDisabled();
  });

  it('shows no banner when the settings match the generated questions (negative)', async () => {
    const service = svc({ readContent: vi.fn().mockResolvedValue(daContent()) });
    render(<ContentEditor context={mockContext} contentId="do_da_7" service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByText('Sample content').length).toBeGreaterThan(0));
    expect(screen.queryByText('Settings changed since the questions were generated')).not.toBeInTheDocument();
  });
});
