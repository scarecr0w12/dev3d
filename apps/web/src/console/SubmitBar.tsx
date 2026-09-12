/**
 * The brief composer, docked at the bottom of the office.
 *
 * This is how work enters the office: which project it belongs to, a brief, the
 * pipeline that should carry it, and an optional spend ceiling. It stays small
 * by default - the 3D view is the point - and expands on request to show the
 * workspace the agents will be confined to and the pipeline's stage list, so the
 * shape of the work is visible before it is commissioned.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';

import type { ClientCommand, Pipeline } from '@dev3d/core';

import { formatUsd } from '../app/format';
import { useStoredState } from '../app/hooks';
import { useOffice, useStore } from '../app/StoreContext';
import { Badge, cx } from './ui';

const EXAMPLES: readonly string[] = [
  'Add a dark-mode toggle to the settings page and remember the choice per user.',
  '/api/orders returns 500 under concurrent writes. Find the race and fix it with a test.',
  'Research whether we should move session storage from Redis to signed cookies, then recommend one.',
];

export function SubmitBar() {
  const store = useStore();
  const office = useOffice();
  const [brief, setBrief] = useStoredState('dev3d.brief', '');
  const [pipelineId, setPipelineId] = useStoredState('dev3d.pipeline', '');
  const [workspaceId, setWorkspaceId] = useStoredState('dev3d.workspace', '');
  const [expandedRaw, setExpanded] = useStoredState('dev3d.composerExpanded', 'false');
  const [budget, setBudget] = useState('');
  const [sentAt, setSentAt] = useState<number | null>(null);

  const expanded = expandedRaw === 'true';
  const pipelines = office?.pipelines ?? [];
  const workspaces = office?.workspaces ?? [];
  const activePipeline: Pipeline | null = useMemo(() => {
    if (pipelines.length === 0) return null;
    return pipelines.find((pipeline) => pipeline.id === pipelineId) ?? pipelines[0] ?? null;
  }, [pipelines, pipelineId]);

  // The chosen project, or the office default when the stored id is stale - a
  // workspace that was removed, or a first visit after a config change.
  const activeWorkspace = useMemo(() => {
    if (workspaces.length === 0) return null;
    return (
      workspaces.find((entry) => entry.id === workspaceId) ??
      workspaces.find((entry) => entry.isDefault === true) ??
      workspaces[0] ??
      null
    );
  }, [workspaces, workspaceId]);

  // The dock follows the floor you are looking at, so work commissioned from a
  // floor does not silently target a different one. A deliberate choice in the
  // picker survives until the active floor changes again.
  const activeId = office?.activeWorkspaceId ?? '';
  const followedFloor = useRef('');
  useEffect(() => {
    if (activeId === '' || activeId === followedFloor.current) return;
    followedFloor.current = activeId;
    setWorkspaceId(activeId);
  }, [activeId, setWorkspaceId]);

  const defaultBudget = office?.budget.defaultRunUsd ?? 0;
  const trimmed = brief.trim();
  const canSubmit = trimmed.length > 0 && workspaces.length > 0;

  const submit = useCallback(() => {
    const text = brief.trim();
    if (text.length === 0) return;
    const parsedBudget = Number.parseFloat(budget);
    const command: ClientCommand = {
      type: 'submit',
      brief: text,
      ...(activePipeline ? { pipelineId: activePipeline.id } : {}),
      ...(activeWorkspace ? { workspaceId: activeWorkspace.id } : {}),
      ...(Number.isFinite(parsedBudget) && parsedBudget > 0 ? { budgetUsd: parsedBudget } : {}),
    };
    if (store.send(command)) {
      setBrief('');
      setSentAt(Date.now());
    }
  }, [activePipeline, activeWorkspace, brief, budget, setBrief, store]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className={cx('dock', expanded && 'dock-expanded')}>
      <textarea
        className="brief-input dock-input"
        value={brief}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setBrief(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Describe the outcome you want. The CEO turns it into an objective, staffs it, and reports back."
        rows={expanded ? 3 : 1}
        aria-label="Brief"
        spellCheck={false}
      />

      <div className="dock-row">
        <label className="field field-project">
          <span className="field-label">Project</span>
          <select
            value={activeWorkspace?.id ?? ''}
            onChange={(event) => setWorkspaceId(event.target.value)}
            disabled={workspaces.length === 0}
            aria-label="Project workspace"
            title={activeWorkspace?.path ?? undefined}
          >
            {workspaces.length === 0 && <option value="">no workspaces available</option>}
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
                {workspace.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="field field-narrow">
          <span className="field-label">Pipeline</span>
          <select
            value={activePipeline?.id ?? ''}
            onChange={(event) => setPipelineId(event.target.value)}
            disabled={pipelines.length === 0}
            aria-label="Pipeline"
          >
            {pipelines.length === 0 && <option value="">no pipelines available</option>}
            {pipelines.map((pipeline) => (
              <option key={pipeline.id} value={pipeline.id}>
                {pipeline.name} · {pipeline.stages.length} stages
              </option>
            ))}
          </select>
        </label>

        <label className="field field-budget">
          <span className="field-label">Budget</span>
          <input
            type="number"
            min={0}
            step={0.5}
            value={budget}
            placeholder={defaultBudget > 0 ? String(defaultBudget) : 'default'}
            onChange={(event) => setBudget(event.target.value)}
            aria-label="Budget in USD"
          />
        </label>

        <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
          Submit brief
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(expanded ? 'false' : 'true')}
          title={expanded ? 'Hide pipeline detail' : 'Show pipeline detail'}
        >
          {expanded ? 'less' : 'more'}
        </button>

        <span className="stage-spacer" />

        <span className="dock-meta dim small mono">
          {office && office.llmMode === 'mock' && (
            <Badge
              tone={typeof office.configStale === 'string' && office.configStale !== '' ? 'danger' : 'warn'}
              title={office.llmModeReason ?? 'The scripted provider: nothing reaches a real model and nothing is billed'}
            >
              mock
            </Badge>
          )}
          {sentAt !== null && <span className="ok">brief submitted</span>}
          <span>{trimmed.length} chars</span>
          <span className="dock-hint">⌘/ctrl + ↵</span>
        </span>
      </div>

      {expanded && activeWorkspace && (
        <div className="dock-workspace dim small">
          <span className="field-label">Agents will be confined to</span>
          <span className="mono dock-path" title={activeWorkspace.path}>
            {activeWorkspace.path}
          </span>
        </div>
      )}

      {expanded && activePipeline && (
        <div className="dock-detail">
          <div className="dim small">{activePipeline.description}</div>
          <ol className="stage-strip">
            {activePipeline.stages.map((stage) => (
              <li key={`${activePipeline.id}-${stage.kind}-${stage.name}`} className="stage-strip-item">
                <span className="strong">{stage.name}</span>
                <Badge tone={stage.mode === 'parallel' ? 'info' : stage.mode === 'debate' ? 'accent' : 'neutral'}>
                  {stage.kind} · {stage.mode}
                </Badge>
                {stage.optional && <Badge tone="warn">optional</Badge>}
              </li>
            ))}
          </ol>
          <div className="example-row">
            <span className="dim small">examples</span>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setBrief(example)}
                title={example}
              >
                {example.length > 42 ? `${example.slice(0, 41)}…` : example}
              </button>
            ))}
          </div>
          {defaultBudget > 0 && (
            <div className="dim small mono">default budget {formatUsd(defaultBudget)} per run</div>
          )}
        </div>
      )}
    </div>
  );
}
