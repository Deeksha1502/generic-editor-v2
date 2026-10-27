import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import MetadataDrawer from './MetadataDrawer';
import { makeEd, mockContent, mockService } from '../test/mockEd';

describe('<MetadataDrawer />', () => {
  it('renders the fallback form fields when open', () => {
    const ed = makeEd({ drawer: 'metadata', content: mockContent });
    render(<MetadataDrawer ed={ed} />);
    expect(screen.getByRole('heading', { name: 'Edit Content Details' })).toBeInTheDocument();
    expect(screen.getByText('Title')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
  });

  it('saves metadata with the trimmed name (positive)', async () => {
    const saveMetadata = vi.fn();
    const ed = makeEd({ drawer: 'metadata', content: mockContent, saveMetadata });
    render(<MetadataDrawer ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
    await waitFor(() => expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sample content' })));
  });

  it('blocks save and toasts when the title is empty (negative)', () => {
    const saveMetadata = vi.fn();
    const showToast = vi.fn();
    const ed = makeEd({ drawer: 'metadata', content: { ...mockContent, name: '' }, saveMetadata, showToast });
    render(<MetadataDrawer ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
    expect(showToast).toHaveBeenCalledWith('Title is required.', 'error');
    expect(saveMetadata).not.toHaveBeenCalled();
  });

  it('renders a dynamic (non-hardcoded) framework category as a taxonomy select', async () => {
    const service = mockService({
      // Form defines a custom taxonomy field "topic" (not board/medium/subject).
      readFormFields: vi.fn().mockResolvedValue([
        { code: 'name', inputType: 'text', label: 'Title', required: true, visible: true, editable: true },
        { code: 'topic', inputType: 'select', label: 'Topic', visible: true, editable: true },
      ]),
      readFramework: vi.fn().mockResolvedValue([
        { code: 'topic', name: 'Topic', index: 1, terms: [{ code: 't1', name: 'Algebra' }, { code: 't2', name: 'Geometry' }] },
      ]),
    });
    const ed = makeEd({
      drawer: 'metadata',
      service,
      content: { ...mockContent, primaryCategory: 'Learning Resource' },
    });
    render(<MetadataDrawer ed={ed} />);
    // The custom category renders with its framework terms as options.
    expect(await screen.findByText('Topic')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Algebra' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'Geometry' })).toBeInTheDocument();
  });

  it('routes to save-and-submit in review-submit mode', async () => {
    const saveMetadataAndSubmit = vi.fn();
    const ed = makeEd({ drawer: 'metadata', content: mockContent, reviewSubmitMode: true, saveMetadataAndSubmit });
    render(<MetadataDrawer ed={ed} />);
    fireEvent.click(screen.getByRole('button', { name: /Save & Submit/ }));
    await waitFor(() => expect(saveMetadataAndSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sample content' })));
  });

  it('keeps a skill field on a non-Dynamic form as an ordinary field (negative)', async () => {
    const service = mockService({
      readFormFields: vi.fn().mockResolvedValue([
        { code: 'name', inputType: 'text', label: 'Title', required: true, visible: true, editable: true },
        { code: 'skill', inputType: 'text', label: 'Skill', required: false, visible: true, editable: true },
      ]),
    });
    render(<MetadataDrawer ed={makeEd({ drawer: 'metadata', service, isDynamicAssess: false, content: { ...mockContent, primaryCategory: 'Learning Resource' } })} />);
    expect(await screen.findByText('Skill')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select Skill/ })).toBeNull();
    expect(screen.queryByText('Framework')).toBeNull();
  });

  describe('difficultyTarget (Dynamic Assess)', () => {
    const service = () => mockService({
      readFormFields: vi.fn().mockResolvedValue([
        { code: 'name', inputType: 'text', label: 'Title', required: true, visible: true, editable: true },
        { code: 'difficultyTarget', label: 'Difficulty Target', required: true, visible: true, editable: true },
      ]),
    });

    it('renders three E/M/D number inputs and saves the entered counts as the API-expected JSON string', async () => {
      const saveMetadata = vi.fn();
      // Seeded in the API's real wire format: a JSON string, not an object.
      const ed = makeEd({
        drawer: 'metadata', service: service(), saveMetadata,
        content: { ...mockContent, primaryCategory: 'Learning Resource', difficultyTarget: '{"E":1,"M":0,"D":0}' },
      });
      render(<MetadataDrawer ed={ed} />);
      expect(await screen.findByText('Difficulty Target')).toBeInTheDocument();
      const easyInput = screen.getByDisplayValue('1');
      fireEvent.change(easyInput, { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(saveMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ difficultyTarget: '{"E":3,"M":0,"D":0}' }),
      ));
    });

    it('gives each count input an accessible name inside a labelled group (positive)', async () => {
      const ed = makeEd({
        drawer: 'metadata', service: service(),
        content: { ...mockContent, primaryCategory: 'Learning Resource', difficultyTarget: '{"E":1,"M":2,"D":3}' },
      });
      render(<MetadataDrawer ed={ed} />);
      expect(await screen.findByRole('group', { name: /Difficulty Target/ })).toBeInTheDocument();
      expect(screen.getByRole('spinbutton', { name: 'Easy' })).toHaveValue(1);
      expect(screen.getByRole('spinbutton', { name: 'Medium' })).toHaveValue(2);
      expect(screen.getByRole('spinbutton', { name: 'Difficult' })).toHaveValue(3);
    });

    it('blocks submit-for-review when every bucket is zero (negative)', async () => {
      const saveMetadataAndSubmit = vi.fn();
      const setReviewErrors = vi.fn();
      const ed = makeEd({
        drawer: 'metadata', service: service(), reviewSubmitMode: true, saveMetadataAndSubmit, setReviewErrors,
        content: { ...mockContent, primaryCategory: 'Learning Resource', difficultyTarget: { E: 0, M: 0, D: 0 } },
      });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      fireEvent.click(screen.getByRole('button', { name: /Save & Submit/ }));
      expect(setReviewErrors).toHaveBeenCalledWith(['Difficulty Target']);
      expect(saveMetadataAndSubmit).not.toHaveBeenCalled();
    });
  });

  describe('pool sufficiency check (Dynamic Assess)', () => {
    const serviceWithSkill = (over: Record<string, unknown> = {}) => mockService({
      readFormFields: vi.fn().mockResolvedValue([
        { code: 'name', inputType: 'text', label: 'Title', required: true, visible: true, editable: true },
        { code: 'skill', inputType: 'multiSelect', label: 'Skill', required: true, visible: true, editable: true },
        { code: 'difficultyTarget', label: 'Difficulty Target', required: true, visible: true, editable: true },
      ]),
      readFramework: vi.fn().mockResolvedValue([
        { code: 'skill', name: 'Skill', index: 1, terms: [{ code: 'physics', name: 'physics' }] },
      ]),
      ...over,
    });
    const baseContent = {
      ...mockContent, primaryCategory: 'Dynamic Course Assessment',
      difficultyTarget: '{"E":2,"M":0,"D":0}',
    };

    /** Selects "physics" through the UI (baseContent has no saved skill). */
    async function selectPhysicsSkill() {
      fireEvent.click(await screen.findByRole('button', { name: /Select Skill/ }));
      fireEvent.click(await screen.findByText('physics'));
    }

    it('blocks save and shows the per-level shortfall when the pool is insufficient (positive)', async () => {
      const saveMetadata = vi.fn();
      const showToast = vi.fn();
      const service = serviceWithSkill({
        searchAssessmentItemBucketCounts: vi.fn().mockResolvedValue({ physics: { E: 0, M: 0, D: 0 } }),
      });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, showToast, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Easy: requested 2 needs 4, available 0'), 'error',
      ));
      expect(saveMetadata).not.toHaveBeenCalled();
    });

    it('allows save when the pool covers the requested counts (negative)', async () => {
      const saveMetadata = vi.fn();
      const service = serviceWithSkill({
      });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(saveMetadata).toHaveBeenCalled());
    });

    it('blocks save when the pool has the requested count but not requested x multiplier (negative)', async () => {
      const saveMetadata = vi.fn();
      const showToast = vi.fn();
      const service = serviceWithSkill({
        // 3 Easy items exist but only floor(3/2)=1 can be drawn per the job's multiplier rule.
        searchAssessmentItemBucketCounts: vi.fn().mockResolvedValue({ physics: { E: 3, M: 0, D: 0 } }),
      });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, showToast, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('Easy: requested 2 needs 4, available 2'), 'error',
      ));
      expect(saveMetadata).not.toHaveBeenCalled();
    });

    it('blocks save, translated, when one skill has fewer than minCriteria x multiplier Live questions (positive)', async () => {
      const saveMetadata = vi.fn();
      const showToast = vi.fn();
      const service = serviceWithSkill({
        searchSkillPoolCounts: vi.fn().mockResolvedValue({ physics: 3 }),
      });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, showToast, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(
        'Each skill needs at least 4 Live questions. Too few for: physics', 'error',
      ));
      expect(saveMetadata).not.toHaveBeenCalled();
    });

  it('shows and keeps the saved skill when the form loads after the drawer opens (positive)', async () => {
      const saveMetadata = vi.fn();
      const service = serviceWithSkill({
      });
      // The editor holds the selection read from the framework's skill category as dynamicSkills.
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, content: { ...baseContent, dynamicSkills: ['physics'] } });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      expect(await screen.findByText('physics')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining({ skill: ['physics'] }), { skillField: 'skill' }));
    });

    it('blocks a skill the job could not give its own minimum at the chosen levels, which would otherwise stay stale forever (positive)', async () => {
      const saveMetadata = vi.fn();
      const showToast = vi.fn();
      // All of physics' questions are Difficult, but only Easy is requested.
      const service = serviceWithSkill({ searchAssessmentItemBucketCounts: vi.fn().mockResolvedValue({ physics: { E: 0, M: 0, D: 30 } }) });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, showToast, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save & Generate/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalled());
      expect(saveMetadata).not.toHaveBeenCalled();
    });

    it('blocks a target too small for the number of skills, like the job does (positive)', async () => {
      const saveMetadata = vi.fn();
      const showToast = vi.fn();
      const content = { ...baseContent, difficultyTarget: '{"E":1,"M":0,"D":0}' };
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service: serviceWithSkill(), saveMetadata, showToast, content });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save & Generate/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('must add up to at least 2'), 'error'));
      expect(saveMetadata).not.toHaveBeenCalled();
    });

    it("checks the pool with the content's own multiplier, not the default (positive)", async () => {
      const saveMetadata = vi.fn();
      const showToast = vi.fn();
      // 9 Easy items cover 2 at the default x3, but not at this content's x5.
      const service = serviceWithSkill({ searchAssessmentItemBucketCounts: vi.fn().mockResolvedValue({ physics: { E: 9, M: 0, D: 0 } }) });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, saveMetadata, showToast, content: { ...baseContent, multiplier: 5 } });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save & Generate/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Easy: requested 2 needs 10, available 5'), 'error'));
      expect(saveMetadata).not.toHaveBeenCalled();
    });

    it("applies the content's own minCriteria to the target and the per-skill floor (positive)", async () => {
      const showToast = vi.fn();
      const content = { ...baseContent, difficultyTarget: '{"E":4,"M":0,"D":0}', minCriteria: '4', multiplier: 2 };
      const service = serviceWithSkill({ searchSkillPoolCounts: vi.fn().mockResolvedValue({ physics: 7 }) });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, showToast, content });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save & Generate/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith('Each skill needs at least 8 Live questions. Too few for: physics', 'error'));
    });

    it('saves only once when Save & Generate is clicked twice during the pool check (negative)', async () => {
      const saveMetadata = vi.fn();
      let release: () => void = () => {};
      const slow = vi.fn(() => new Promise((resolve) => { release = () => resolve({ physics: { E: 9, M: 9, D: 9 } }); }));
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service: serviceWithSkill({ searchAssessmentItemBucketCounts: slow }), saveMetadata, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      const button = screen.getByRole('button', { name: /Save & Generate/ });
      fireEvent.click(button);
      fireEvent.click(button);
      release();
      await waitFor(() => expect(saveMetadata).toHaveBeenCalledTimes(1));
      expect(slow).toHaveBeenCalledTimes(1);
    });

    it('disables Save while questions are generating, so a save cannot skip its own generation (positive)', async () => {
      const saveMetadata = vi.fn();
      const ed = makeEd({ isDynamicAssess: true, dynamicAssessRefreshing: true, drawer: 'metadata', service: serviceWithSkill(), saveMetadata, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      const button = screen.getByRole('button', { name: /Save/ });
      expect(button).toBeDisabled();
      fireEvent.click(button);
      expect(saveMetadata).not.toHaveBeenCalled();
    });

    it('refuses Save & Submit with changed settings instead of submitting stale questions (positive)', async () => {
      const saveMetadataAndSubmit = vi.fn();
      const showToast = vi.fn();
      const searchAssessmentItemBucketCounts = vi.fn();
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', reviewSubmitMode: true, service: serviceWithSkill({ searchAssessmentItemBucketCounts }), saveMetadataAndSubmit, showToast, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      await selectPhysicsSkill();
      fireEvent.click(screen.getByRole('button', { name: /Save/ }));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringContaining('use Save & Generate'), 'error'));
      expect(saveMetadataAndSubmit).not.toHaveBeenCalled();
      expect(searchAssessmentItemBucketCounts).not.toHaveBeenCalled();
    });

    it('labels the button Save & Generate only when this save will generate (positive)', async () => {
      const service = serviceWithSkill();
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      expect(screen.getByRole('button', { name: /Save changes/ })).toBeInTheDocument();
      await selectPhysicsSkill();
      expect(await screen.findByRole('button', { name: /Save & Generate/ })).toBeInTheDocument();
    });

    it('skips the pool searches for a save that will not generate (negative)', async () => {
      const searchAssessmentItemBucketCounts = vi.fn();
      const saveMetadata = vi.fn();
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service: serviceWithSkill({ searchAssessmentItemBucketCounts }), saveMetadata, content: baseContent });
      render(<MetadataDrawer ed={ed} />);
      await screen.findByText('Difficulty Target');
      fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
      await waitFor(() => expect(saveMetadata).toHaveBeenCalled());
      expect(searchAssessmentItemBucketCounts).not.toHaveBeenCalled();
    });
  });

  describe('minimum questions per skill panel (Dynamic Assess)', () => {
    const service = () => mockService({
      readFormFields: vi.fn().mockResolvedValue([
        { code: 'name', inputType: 'text', label: 'Title', required: true, visible: true, editable: true },
        { code: 'skill', inputType: 'multiSelect', label: 'Skill', required: true, visible: true, editable: true },
        { code: 'difficultyTarget', label: 'Difficulty Target', required: true, visible: true, editable: true },
      ]),
      readFramework: vi.fn().mockResolvedValue([
        { code: 'skill', name: 'Skill', index: 1, terms: [{ code: 'physics', name: 'physics' }, { code: 'chemistry', name: 'chemistry' }] },
      ]),
    });
    const dynamic = { ...mockContent, primaryCategory: 'Dynamic Course Assessment', difficultyTarget: '{"E":1,"M":1,"D":1}', dynamicSkills: ['physics'] };

    it("shows the content's minimum against the live total and flags it when too low (positive)", async () => {
      render(<MetadataDrawer ed={makeEd({ isDynamicAssess: true, drawer: 'metadata', service: service(), content: { ...dynamic, minCriteria: 4 } })} />);
      expect(await screen.findByText('Minimum questions per skill')).toBeInTheDocument();
      expect(screen.getByText('Total: 3 · Minimum: 4')).toBeInTheDocument();
      expect(screen.getByText('Each selected skill needs at least 4 questions; increase the total to at least 4.')).toBeInTheDocument();
      expect(screen.getByText('Needs adjustment')).toBeInTheDocument();
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Easy' }), { target: { value: '2' } });
      expect(screen.getByText('Total: 4 · Minimum: 4')).toBeInTheDocument();
      expect(screen.queryByText('Needs adjustment')).toBeNull();
      expect(screen.getByText('Each selected skill needs at least 4 questions.')).toBeInTheDocument();
    });

    it('multiplies the minimum by the number of selected skills, defaulting minCriteria to 2 (positive)', async () => {
      render(<MetadataDrawer ed={makeEd({ isDynamicAssess: true, drawer: 'metadata', service: service(), content: { ...dynamic, dynamicSkills: ['physics', 'chemistry'] } })} />);
      expect(await screen.findByText('Total: 3 · Minimum: 4')).toBeInTheDocument();
      expect(screen.getByText('Needs adjustment')).toBeInTheDocument();
    });

    it('is hidden until a skill is selected (negative)', async () => {
      render(<MetadataDrawer ed={makeEd({ isDynamicAssess: true, drawer: 'metadata', service: service(), content: { ...dynamic, dynamicSkills: [] } })} />);
      await screen.findByText('Difficulty Target');
      expect(screen.queryByText('Minimum questions per skill')).toBeNull();
    });

    it('is never shown for non-Dynamic content (negative)', async () => {
      const content = { ...mockContent, primaryCategory: 'Learning Resource', difficultyTarget: '{"E":1,"M":0,"D":0}', skill: ['physics'] };
      render(<MetadataDrawer ed={makeEd({ isDynamicAssess: false, drawer: 'metadata', service: service(), content })} />);
      await screen.findByText('Difficulty Target');
      expect(screen.queryByText('Minimum questions per skill')).toBeNull();
    });
  });

  describe('skills are selected in the framework\'s deepest category (Dynamic Assess)', () => {
    // Deepest category is 'topic' and there is no category coded 'skill', like a non-USF framework.
    const nonUsfService = (over: Record<string, unknown> = {}) => mockService({
      readFormFields: vi.fn().mockResolvedValue([
        { code: 'name', inputType: 'text', label: 'Title', required: true, visible: true, editable: true },
        { code: 'skill', inputType: 'multiSelect', label: 'Skill', required: true, visible: true, editable: true },
        { code: 'difficultyTarget', label: 'Difficulty Target', required: true, visible: true, editable: true },
      ]),
      readFramework: vi.fn().mockResolvedValue([
        { code: 'topic', name: 'Topic', index: 2, terms: [{ code: 't1', name: 'Algebra' }, { code: 't2', name: 'Geometry' }] },
        { code: 'subject', name: 'Subject', index: 1, terms: [{ code: 's1', name: 'Maths' }] },
      ]),
      ...over,
    });
    const content = { ...mockContent, primaryCategory: 'Dynamic Course Assessment', difficultyTarget: '{"E":2,"M":0,"D":0}' };

    it('offers the deepest category\'s terms under its own name, saves them in that category and checks the pool on it (positive)', async () => {
      const saveMetadata = vi.fn();
      const pool = vi.fn().mockResolvedValue({ Algebra: { E: 9, M: 9, D: 9 } });
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service: nonUsfService({ searchAssessmentItemBucketCounts: pool }), saveMetadata, content });
      render(<MetadataDrawer ed={ed} />);
      fireEvent.click(await screen.findByRole('button', { name: /Select Topic/ }));
      expect(await screen.findByText('Algebra')).toBeInTheDocument();
      expect(screen.getByText('Geometry')).toBeInTheDocument();
      expect(screen.queryByText('Maths')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Algebra'));
      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining({ topic: ['Algebra'] }), { skillField: 'topic' }));
      expect(saveMetadata.mock.calls[0][0]).not.toHaveProperty('skill');
      expect(pool).toHaveBeenCalledWith(['Algebra'], expect.anything(), 'topic');
    });

    it('lets the author switch framework, reloading skill options from the new framework\'s deepest category (positive)', async () => {
      const saveMetadata = vi.fn();
      const readFramework = vi.fn(async (fw: string) => (fw === 'USF'
        ? [{ code: 'skill', name: 'Skill', index: 3, terms: [{ code: 'ph', name: 'Physics' }] }]
        : [{ code: 'topic', name: 'Topic', index: 2, terms: [{ code: 't1', name: 'Algebra' }] }]));
      const service = nonUsfService({
        readFramework,
        searchFrameworks: vi.fn().mockResolvedValue([{ identifier: 'BMGS', name: 'BMGS' }, { identifier: 'USF', name: 'Universal Skills' }]),
      });
      const ed = makeEd({ drawer: 'metadata', service, saveMetadata, isDynamicAssess: true, content: { ...content, framework: 'BMGS' } });
      render(<MetadataDrawer ed={ed} />);

      const picker = await screen.findByLabelText('Framework') as HTMLSelectElement;
      await waitFor(() => expect(picker.value).toBe('BMGS'));
      fireEvent.click(await screen.findByRole('button', { name: /Select Topic/ }));
      fireEvent.click(await screen.findByText('Algebra'));
      fireEvent.mouseDown(document.body); // close the skill dropdown, as clicking elsewhere does

      fireEvent.change(picker, { target: { value: 'USF' } });
      await waitFor(() => expect(readFramework).toHaveBeenCalledWith('USF'));
      fireEvent.click(await screen.findByRole('button', { name: /Select Skill/ })); // previous pick was cleared
      fireEvent.click(await screen.findByText('Physics'));
      expect(screen.queryByText('Algebra')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /Save (changes|& Generate)/ }));
      await waitFor(() => expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining({ framework: 'USF', skill: ['Physics'] }), { skillField: 'skill' }));
    });

    it('reloads the categories when the author picks the placeholder and then the same framework again (positive)', async () => {
      const readFramework = vi.fn().mockResolvedValue([{ code: 'topic', name: 'Topic', index: 2, terms: [{ code: 't1', name: 'Algebra' }] }]);
      const service = nonUsfService({ readFramework, searchFrameworks: vi.fn().mockResolvedValue([{ identifier: 'BMGS', name: 'BMGS' }]) });
      const ed = makeEd({ drawer: 'metadata', service, isDynamicAssess: true, content: { ...content, framework: 'BMGS' } });
      render(<MetadataDrawer ed={ed} />);
      const picker = await screen.findByLabelText('Framework') as HTMLSelectElement;
      await waitFor(() => expect(picker.value).toBe('BMGS'));
      const callsBefore = readFramework.mock.calls.length;
      fireEvent.change(picker, { target: { value: '' } });
      fireEvent.change(picker, { target: { value: 'BMGS' } });
      await waitFor(() => expect(readFramework.mock.calls.length).toBeGreaterThan(callsBefore));
      fireEvent.click(await screen.findByRole('button', { name: /Select Topic/ }));
      expect(await screen.findByText('Algebra')).toBeInTheDocument();
    });

    it('keeps skill disabled until a framework is chosen (negative)', async () => {
      const service = nonUsfService({ readFramework: vi.fn().mockResolvedValue([]) });
      const ed = makeEd({ drawer: 'metadata', service, isDynamicAssess: true, framework: '', content: { ...content, framework: undefined } });
      render(<MetadataDrawer ed={ed} />);
      const skill = await screen.findByRole('button', { name: /Select a framework first/ });
      expect(skill).toBeDisabled();
    });

    it('does not fall back to a free-text box when no category is literally named skill (negative)', async () => {
      const ed = makeEd({ isDynamicAssess: true, drawer: 'metadata', service: nonUsfService(), content });
      render(<MetadataDrawer ed={ed} />);
      // The selection is a dropdown of the deepest category, never a plain text input.
      expect(await screen.findByRole('button', { name: /Select Topic/ })).toBeInTheDocument();
    });
  });
});
