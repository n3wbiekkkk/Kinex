import React, { useState } from 'react';
import { Sparkles, Trash2, X, Zap } from 'lucide-react';
import type { BoostRule, NookIntent, NookStateSnapshot } from '../../shared/types';

interface BoostPanelProps {
  state: NookStateSnapshot;
  initialDomain: string;
  dispatch: (intent: NookIntent) => void;
}

export const BoostPanel: React.FC<BoostPanelProps> = ({ state, initialDomain, dispatch }) => {
  const existing =
    state.boosts.find((b) => b.domainPattern.toLowerCase() === initialDomain.toLowerCase()) ??
    state.boosts[0];

  const [editingId, setEditingId] = useState<string>(existing?.id ?? `boost-${Date.now()}`);
  const [name, setName] = useState(existing?.name ?? `${initialDomain} Boost`);
  const [domainPattern, setDomainPattern] = useState(existing?.domainPattern ?? initialDomain);
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [filterInvert, setFilterInvert] = useState(existing?.filterInvert ?? false);
  const [fontFamily, setFontFamily] = useState(existing?.fontFamily ?? '');
  const [css, setCss] = useState(existing?.css ?? '');
  const [js, setJs] = useState(existing?.js ?? '');
  const [zappedSelectors, setZappedSelectors] = useState<string[]>(existing?.zappedSelectors ?? []);

  const loadBoost = (b: BoostRule) => {
    setEditingId(b.id);
    setName(b.name);
    setDomainPattern(b.domainPattern);
    setEnabled(b.enabled);
    setFilterInvert(Boolean(b.filterInvert));
    setFontFamily(b.fontFamily ?? '');
    setCss(b.css);
    setJs(b.js);
    setZappedSelectors(b.zappedSelectors);
  };

  const startNew = () => {
    setEditingId(`boost-${Date.now()}`);
    setName(`${initialDomain} Boost`);
    setDomainPattern(initialDomain);
    setEnabled(true);
    setFilterInvert(false);
    setFontFamily('');
    setCss('');
    setJs('');
    setZappedSelectors([]);
  };

  const save = () => {
    dispatch({
      type: 'save-boost',
      boost: {
        id: editingId,
        name: name.trim() || `${domainPattern} Boost`,
        domainPattern: domainPattern.trim() || '*',
        enabled,
        filterInvert,
        fontFamily: fontFamily.trim() || undefined,
        css,
        js,
        zappedSelectors,
      },
    });
  };

  return (
    <div className="modal-card" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          <Sparkles size={16} style={{ color: '#a78bfa' }} />
          <span>Boosts Studio</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-secondary" onClick={() => dispatch({ type: 'start-zapper' })}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Zap size={13} /> Zap Element
            </span>
          </button>
          <button
            className="icon-btn"
            onClick={() => dispatch({ type: 'set-overlay', overlay: { mode: 'none' } })}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="modal-body">
        {state.boosts.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {state.boosts.map((b) => (
              <button
                key={b.id}
                className="btn-secondary"
                style={{
                  border: b.id === editingId ? '1px solid #8b7cf8' : '1px solid transparent',
                  opacity: b.enabled ? 1 : 0.55,
                }}
                onClick={() => loadBoost(b)}
              >
                {b.domainPattern}
              </button>
            ))}
            <button className="btn-secondary" onClick={startNew}>
              + New Boost
            </button>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <label className="field-label">Name</label>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="field-label">Domain Pattern (e.g. github.com or *)</label>
            <input
              className="text-input"
              value={domainPattern}
              onChange={(e) => setDomainPattern(e.target.value)}
            />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={filterInvert}
              onChange={(e) => setFilterInvert(e.target.checked)}
            />
            Smart Dark Invert
          </label>
        </div>

        <div>
          <label className="field-label">Font Override (optional)</label>
          <input
            className="text-input"
            placeholder="e.g. Georgia, JetBrains Mono, Inter"
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
          />
        </div>

        {zappedSelectors.length > 0 && (
          <div>
            <label className="field-label">Zapped Selectors</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {zappedSelectors.map((sel) => (
                <span
                  key={sel}
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    background: 'rgba(255,255,255,0.08)',
                    padding: '4px 8px',
                    borderRadius: 6,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {sel}
                  <button
                    onClick={() => setZappedSelectors((prev) => prev.filter((x) => x !== sel))}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="field-label">Custom CSS</label>
          <textarea
            className="code-area"
            placeholder="body { max-width: 960px; margin: 0 auto; }"
            value={css}
            onChange={(e) => setCss(e.target.value)}
          />
        </div>

        <div>
          <label className="field-label">Custom JS (runs on page load)</label>
          <textarea
            className="code-area"
            placeholder="console.log('NOOK Boost active');"
            value={js}
            onChange={(e) => setJs(e.target.value)}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          {state.boosts.some((b) => b.id === editingId) ? (
            <button
              className="btn-danger"
              onClick={() => dispatch({ type: 'delete-boost', boostId: editingId })}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Trash2 size={13} /> Delete
              </span>
            </button>
          ) : (
            <span />
          )}
          <button className="btn-primary" onClick={save}>
            Save & Apply Boost
          </button>
        </div>
      </div>
    </div>
  );
};
