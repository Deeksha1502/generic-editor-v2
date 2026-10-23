import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Header from './Header';
import { makeEd, mockContent } from '../test/mockEd';

describe('<Header />', () => {
  it('shows the content title', () => {
    const ed = makeEd({ view: 'player', content: mockContent });
    render(<Header ed={ed} />);
    expect(screen.getByText('Sample content')).toBeInTheDocument();
  });

  it('renders the saved appIcon as the far-left logo when present', () => {
    const ed = makeEd({ view: 'player', content: { ...mockContent, appIcon: 'https://cdn/icon.png' } });
    const { container } = render(<Header ed={ed} />);
    const img = container.querySelector('.ce-logo-mark img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.src).toContain('https://cdn/icon.png');
  });

  it('opens the collaborator drawer from the icon button', () => {
    const setDrawer = vi.fn();
    const ed = makeEd({ view: 'player', mode: 'edit', setDrawer });
    render(<Header ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add collaborators' }));
    expect(setDrawer).toHaveBeenCalledWith('collaborator');
  });

  it('disables action buttons while busy (negative)', () => {
    const ed = makeEd({ view: 'player', mode: 'edit', busy: true });
    render(<Header ed={ed} />);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add collaborators' })).toBeDisabled();
  });

  it('shows Publish for a reviewer and wires it up', () => {
    const publish = vi.fn();
    const ed = makeEd({ view: 'player', mode: 'review', publish });
    render(<Header ed={ed} />);
    const btn = screen.getByRole('button', { name: /Publish/ });
    fireEvent.click(btn);
    expect(publish).toHaveBeenCalled();
  });

  it('shows "View transcript" for video content once transcripts exist, and opens the drawer', () => {
    const setDrawer = vi.fn();
    const ed = makeEd({
      view: 'player', mode: 'edit', setDrawer, hasTranscripts: true,
      content: { ...mockContent, mimeType: 'video/mp4' },
    });
    render(<Header ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: 'View transcript' }));
    expect(setDrawer).toHaveBeenCalledWith('transcripts');
  });

  it('hides "View transcript" for video content with no transcripts yet (negative)', () => {
    const ed = makeEd({
      view: 'player', mode: 'edit', hasTranscripts: false,
      content: { ...mockContent, mimeType: 'video/mp4' },
    });
    render(<Header ed={ed} />);
    expect(screen.queryByRole('button', { name: 'View transcript' })).not.toBeInTheDocument();
  });

  it('hides "View transcript" for non-video content (negative)', () => {
    const ed = makeEd({ view: 'player', mode: 'edit', content: { ...mockContent, mimeType: 'application/pdf' } });
    render(<Header ed={ed} />);
    expect(screen.queryByRole('button', { name: 'View transcript' })).not.toBeInTheDocument();
  });
});

describe('<Header /> — Regenerate (Dynamic Assess)', () => {
  it('sits next to Save for the creator once questions exist and re-rolls on click (positive)', () => {
    const refreshBody = vi.fn();
    const ed = makeEd({ view: 'player', content: mockContent, mode: 'edit', isDynamicAssess: true, hasGeneratedBody: true, refreshBody });
    render(<Header ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    expect(refreshBody).toHaveBeenCalled();
  });

  it('explains a disabled Send for review / Publish with a hover hint (positive)', () => {
    const creator = makeEd({ view: 'player', content: mockContent, mode: 'edit', isDynamicAssess: true, hasGeneratedBody: false });
    const { container, unmount } = render(<Header ed={creator} />);
    expect(screen.getByRole('button', { name: /Send for review/i })).toBeDisabled();
    expect(container.querySelector('.ce-disabled-hint')).toHaveAttribute('data-tooltip', 'Generate questions before sending for review');
    unmount();
    const reviewer = makeEd({ view: 'player', content: mockContent, mode: 'review', isDynamicAssess: true, hasGeneratedBody: true, dynamicAssessStale: true });
    const { container: c2 } = render(<Header ed={reviewer} />);
    expect(screen.getByRole('button', { name: /Publish/ })).toBeDisabled();
    expect(c2.querySelector('.ce-disabled-hint')).toHaveAttribute('data-tooltip', 'Settings changed — generate questions again first');
  });

  it('adds no hint wrapper for ordinary content (negative)', () => {
    const { container } = render(<Header ed={makeEd({ view: 'player', content: mockContent, mode: 'edit' })} />);
    expect(container.querySelector('.ce-disabled-hint')).toBeNull();
  });

  it('is hidden for reviewers, before any questions exist, and for ordinary content (negative)', () => {
    const cases = [
      makeEd({ view: 'player', content: mockContent, mode: 'review', isDynamicAssess: true, hasGeneratedBody: true }),
      makeEd({ view: 'player', content: mockContent, mode: 'edit', isDynamicAssess: true, hasGeneratedBody: false }),
      makeEd({ view: 'player', content: mockContent, mode: 'edit', isDynamicAssess: false, hasGeneratedBody: true }),
    ];
    for (const ed of cases) {
      const { unmount } = render(<Header ed={ed} />);
      expect(screen.queryByRole('button', { name: /Regenerate/ })).not.toBeInTheDocument();
      unmount();
    }
  });
});
