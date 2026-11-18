import React, { useState } from 'react';
import {
  Download,
  ExternalLink,
  FolderOpen,
  Pause,
  Play,
  Trash2,
  X,
} from 'lucide-react';
import type { KinexIntent, KinexStateSnapshot } from '../../shared/types';

interface DownloadsViewProps {
  state: KinexStateSnapshot;
  dispatch: (intent: KinexIntent) => void;
  onClose?: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatEta(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s left`;
}

/** Searchable download list with pause/resume/cancel/open/Finder controls. */
export const DownloadsView: React.FC<DownloadsViewProps> = ({ state, dispatch, onClose }) => {
  const [query, setQuery] = useState('');
  const close = () => (onClose ? onClose() : dispatch({ type: 'set-overlay', overlay: { mode: 'none' } }));
  const q = query.trim().toLowerCase();
  const downloads = state.downloads.filter(
    (item) => !q || item.filename.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)
  );
  const finishedCount = state.downloads.filter((item) => item.state !== 'progressing').length;

  return (
    <div className="modal-card" role="dialog" aria-modal="true" aria-label="Downloads" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <span style={{ fontWeight: 600 }}>Downloads</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            className="text-input"
            type="search"
            style={{ width: 220 }}
            aria-label="Search downloads"
            placeholder="Search downloads..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {finishedCount > 0 && (
            <button
              className="btn-secondary"
              onClick={() => dispatch({ type: 'clear-completed-downloads' })}
            >
              <Trash2 size={12} /> Clear Finished
            </button>
          )}
          <button className="icon-btn" aria-label="Close Downloads" onClick={close}><X size={16} /></button>
        </div>
      </div>
      <div className="modal-body" style={{ overflowY: 'auto', maxHeight: '65vh' }}>
        {downloads.length === 0 ? (
          <div className="empty-state">
            <Download size={22} style={{ opacity: 0.65 }} />
            <div className="empty-state-title">{q ? 'No matching downloads' : 'No Recent Downloads'}</div>
            <div className="empty-state-sub">Files downloaded during this session appear here with progress and controls.</div>
          </div>
        ) : (
          downloads.map((dl) => {
            const pct = dl.totalBytes > 0 ? Math.min(100, Math.round((dl.receivedBytes / dl.totalBytes) * 100)) : 0;
            const statusParts = [
              dl.isPaused ? 'Paused' : dl.state,
              dl.totalBytes > 0
                ? `${formatBytes(dl.receivedBytes)} / ${formatBytes(dl.totalBytes)}`
                : formatBytes(dl.receivedBytes),
            ];
            if (dl.state === 'progressing' && !dl.isPaused && dl.speedBytesPerSec) {
              statusParts.push(`${formatBytes(dl.speedBytesPerSec)}/s`);
            }
            const eta = formatEta(dl.etaSeconds);
            if (dl.state === 'progressing' && !dl.isPaused && eta) statusParts.push(eta);
            return (
              <div
                key={dl.id}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px',
                  borderRadius: 10, background: 'var(--surface-card)', border: '1px solid var(--border-hairline)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {dl.filename}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {statusParts.join(' · ')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    {dl.state === 'progressing' && !dl.isPaused && (
                      <button className="icon-btn" title="Pause Download" aria-label="Pause Download" onClick={() => dispatch({ type: 'pause-download', downloadId: dl.id })}>
                        <Pause size={13} />
                      </button>
                    )}
                    {(dl.isPaused || dl.state === 'interrupted') && dl.canResume && (
                      <button className="icon-btn" title="Resume Download" aria-label="Resume Download" onClick={() => dispatch({ type: 'resume-download', downloadId: dl.id })}>
                        <Play size={13} />
                      </button>
                    )}
                    {dl.state === 'progressing' && (
                      <button className="icon-btn" title="Cancel Download" aria-label="Cancel Download" onClick={() => dispatch({ type: 'cancel-download', downloadId: dl.id })}>
                        <X size={13} />
                      </button>
                    )}
                    {dl.state === 'completed' && (
                      <button className="btn-secondary" onClick={() => dispatch({ type: 'open-download', downloadId: dl.id })}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ExternalLink size={12} /> Open</span>
                      </button>
                    )}
                    {dl.savePath && dl.state !== 'cancelled' && (
                      <button className="btn-secondary" onClick={() => dispatch({ type: 'show-download-in-finder', savePath: dl.savePath })}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><FolderOpen size={12} /> Finder</span>
                      </button>
                    )}
                  </div>
                </div>
                {dl.state === 'progressing' && dl.totalBytes > 0 && (
                  <div className="dl-progress-track"><div className="dl-progress-fill" style={{ width: `${pct}%` }} /></div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
