import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { SPACE_THEME_PRESETS } from '../../shared/domain';
import type { KinexIntent, KinexStateSnapshot } from '../../shared/types';

interface SpaceEditorProps {
  state: KinexStateSnapshot;
  spaceId?: string;
  dispatch: (intent: KinexIntent) => void;
}

const ICONS = ['✦', '⌘', '⚡', '🌿', '🎧', '🧪', '🚀', '📚'];

export const SpaceEditor: React.FC<SpaceEditorProps> = ({ state, spaceId, dispatch }) => {
  const existing = spaceId ? state.spaces.find((s) => s.id === spaceId) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [icon, setIcon] = useState(existing?.icon ?? '✦');
  const [themeId, setThemeId] = useState(existing?.theme.id ?? SPACE_THEME_PRESETS[0].id);
  const [profilePartition, setProfilePartition] = useState(
    existing?.profilePartition ?? state.profiles[0]?.partition ?? 'persist:nook-default'
  );
  const [newProfileName, setNewProfileName] = useState('');

  const selectedTheme =
    SPACE_THEME_PRESETS.find((t) => t.id === themeId) ?? SPACE_THEME_PRESETS[0];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (existing) {
      dispatch({
        type: 'update-space',
        spaceId: existing.id,
        name: name || existing.name,
        icon,
        theme: selectedTheme,
        profilePartition,
      });
    } else {
      dispatch({
        type: 'create-space',
        name: name || 'New Space',
        icon,
        theme: selectedTheme,
        profilePartition,
      });
    }
  };

  return (
    <div className="modal-card" role="dialog" aria-modal="true" aria-label={existing ? 'Edit Space' : 'New Space'} onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <span style={{ fontWeight: 600 }}>{existing ? 'Edit Space' : 'New Space'}</span>
        <button
          className="icon-btn"
          aria-label="Close Space Editor"
          onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
        >
          <X size={16} />
        </button>
      </div>
      <form className="modal-body" onSubmit={submit}>
        <div>
          <label className="field-label" htmlFor="space-name">Space Name</label>
          <input
            className="text-input"
            id="space-name"
            aria-label="Space Name"
            data-initial-focus
            placeholder="e.g. Research, Work, Chill"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div>
          <label className="field-label">Cookie &amp; Login Profile</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {state.profiles.map((p) => (
              <button
                type="button"
                key={p.id}
                aria-pressed={p.partition === profilePartition}
                className={`btn-secondary ${p.partition === profilePartition ? 'selected' : ''}`}
                onClick={() => setProfilePartition(p.partition)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              className="text-input"
              placeholder="New isolated profile name..."
              aria-label="New Profile Name"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                if (newProfileName.trim()) {
                  dispatch({ type: 'create-profile', name: newProfileName });
                  setNewProfileName('');
                }
              }}
            >
              Add Profile
            </button>
          </div>
        </div>

        <div>
          <label className="field-label">Icon</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ICONS.map((ic) => (
              <button
                type="button"
                key={ic}
                aria-label={`Space icon ${ic}`}
                aria-pressed={ic === icon}
                className={`btn-secondary ${ic === icon ? 'selected' : ''}`}
                style={{ fontSize: 15 }}
                onClick={() => setIcon(ic)}
              >
                {ic}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="field-label">Space Theme</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            {SPACE_THEME_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                aria-pressed={preset.id === themeId}
                onClick={() => setThemeId(preset.id)}
                style={{
                  padding: '10px 8px',
                  borderRadius: 10,
                  background: `linear-gradient(135deg, ${preset.gradientFrom}, ${preset.gradientTo})`,
                  color: preset.isDark ? '#fff' : '#161822',
                  border:
                    preset.id === themeId ? '2px solid var(--accent)' : '1px solid var(--border-hairline)',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          {existing && state.spaces.length > 1 ? (
            <button
              type="button"
              className="btn-danger"
              onClick={() => dispatch({ type: 'delete-space', spaceId: existing.id })}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Trash2 size={13} /> Delete Space
              </span>
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="btn-primary">
            {existing ? 'Save Changes' : 'Create Space'}
          </button>
        </div>
      </form>
    </div>
  );
};
