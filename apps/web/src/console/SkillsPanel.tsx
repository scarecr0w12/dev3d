/**
 * The skill index.
 *
 * Skills are markdown documents the office loads at boot; each employee gets the
 * index and pulls full bodies in per turn. The console shows the catalogue from
 * `/api/skills`, and falls back to the skill ids the org chart references when
 * that endpoint is unavailable - so the panel is never empty, and never claims
 * to know more than it does.
 */

import { useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';

import { humaniseToken } from '../app/format';
import { useOffice, useSkills, useStore } from '../app/StoreContext';
import { Badge, Empty, Loading, Panel } from './ui';

export function SkillsPanel() {
  const store = useStore();
  const office = useOffice();
  const skills = useSkills();
  const [tag, setTag] = useState<string>('all');
  const [query, setQuery] = useState('');

  const catalogue = skills.skills;
  const roles = office?.roles ?? [];

  /** Ids the org chart refers to, with the roles that hold them. */
  const referenced = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const role of roles) {
      for (const skillId of role.skillIds) {
        const holders = map.get(skillId);
        if (holders) holders.push(role.displayName);
        else map.set(skillId, [role.displayName]);
      }
    }
    return map;
  }, [roles]);

  const entries = useMemo(() => {
    if (catalogue) {
      return catalogue.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        holders: referenced.get(skill.id) ?? [],
      }));
    }
    return [...referenced.entries()].map(([id, holders]) => ({
      id,
      name: humaniseToken(id),
      description: 'referenced by the org chart — the skill catalogue is unavailable',
      tags: [] as string[],
      holders,
    }));
  }, [catalogue, referenced]);

  const tags = useMemo(() => {
    const seen = new Map<string, number>();
    for (const entry of entries) for (const entryTag of entry.tags) seen.set(entryTag, (seen.get(entryTag) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries
      .filter((entry) => (tag === 'all' ? true : entry.tags.includes(tag)))
      .filter((entry) =>
        needle.length === 0
          ? true
          : `${entry.id} ${entry.name} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [entries, tag, query]);

  return (
    <Panel
      title="Skills"
      subtitle={
        catalogue
          ? `${catalogue.length} loaded from /api/skills`
          : `${referenced.size} referenced by roles · catalogue unavailable`
      }
      flush
      actions={
        <>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => store.notify('info', 'skills are loaded from /api/skills at startup')}>
            how?
          </button>
          <input
            className="input input-sm"
            type="search"
            value={query}
            placeholder="search skills"
            aria-label="Search skills"
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
          />
        </>
      }
    >
      {skills.loading && <Loading label="loading the skill catalogue…" />}
      {!skills.loading && skills.error !== null && (
        <div className="alert alert-warn small">
          <span className="strong">Skill catalogue unavailable</span>
          <span className="mono small">{skills.error}</span>
          <span className="dim small">
            Showing the skill ids the org chart references instead. Skills still work: the engine loads them from disk.
          </span>
        </div>
      )}

      {tags.length > 0 && (
        <div className="filter-row">
          <button type="button" className={tag === 'all' ? 'chip chip-active' : 'chip'} onClick={() => setTag('all')}>
            all · {entries.length}
          </button>
          {tags.map(([entryTag, count]) => (
            <button
              key={entryTag}
              type="button"
              className={tag === entryTag ? 'chip chip-active' : 'chip'}
              onClick={() => setTag(entryTag)}
            >
              {entryTag} · {count}
            </button>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <Empty
          title={entries.length === 0 ? 'No skills' : 'Nothing matches'}
          hint={entries.length === 0 ? 'The orchestrator has not reported skills and no roles reference any.' : 'Clear the search or pick another tag.'}
        />
      ) : (
        <ul className="skill-list">
          {visible.map((entry) => (
            <li key={entry.id} className="skill">
              <div className="skill-head">
                <span className="strong">{entry.name}</span>
                <span className="mono small dim">{entry.id}</span>
                <span className="stage-spacer" />
                {entry.tags.map((entryTag) => (
                  <Badge key={entryTag} tone="neutral">
                    {entryTag}
                  </Badge>
                ))}
              </div>
              <div className="small">{entry.description}</div>
              {entry.holders.length > 0 && (
                <div className="dim small">
                  held by{' '}
                  {entry.holders.map((holder, index) => (
                    <span key={holder}>
                      {index > 0 && ', '}
                      <button type="button" className="link" onClick={() => store.selectEmployee(holderId(roles, holder))}>
                        {holder}
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Maps a display name back to a role id, for the "held by" links. */
function holderId(roles: readonly { id: string; displayName: string }[], displayName: string): string | null {
  return roles.find((role) => role.displayName === displayName)?.id ?? null;
}
