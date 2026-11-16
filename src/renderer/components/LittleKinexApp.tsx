import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Lock, RotateCw, Shield } from 'lucide-react';
import type { LittleKinexInfo } from '../../shared/types';

interface LittleKinexAppProps {
  isPrivateMode?: boolean;
}

export const LittleKinexApp: React.FC<LittleKinexAppProps> = ({ isPrivateMode = false }) => {
  const [info, setInfo] = useState<LittleKinexInfo>({
    url: '',
    title: isPrivateMode ? 'Private Window' : 'Little Kinex',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    isPrivate: isPrivateMode,
    securityState: 'internal',
  });
  const [urlInput, setUrlInput] = useState('');
  const headerRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  useEffect(() => window.kinexAPI.onFocusRequested((region) => {
    if (region === 'address') {
      addressRef.current?.focus();
      addressRef.current?.select();
    } else if (region === 'toolbar' || region === 'sidebar' || region === 'restore') {
      const previous = lastFocused.current;
      const target = previous?.isConnected ? previous : headerRef.current?.querySelector<HTMLElement>('button:not(:disabled), input');
      target?.focus({ preventScroll: true });
    }
  }), []);

  useEffect(() => {
    void window.kinexAPI.getLittleKinexInfo().then((initial) => {
      setInfo(initial);
      setUrlInput(initial.url);
    });
    return window.kinexAPI.onLittleKinexUpdated((next) => {
      setInfo(next);
      setUrlInput(next.url);
    });
  }, []);

  const privateSession = isPrivateMode || Boolean(info.isPrivate);

  return (
    <header className="little-header" ref={headerRef} aria-label={privateSession ? 'Private Browser Controls' : 'Little Kinex Controls'} onFocusCapture={(event) => {
      if (event.target instanceof HTMLElement) lastFocused.current = event.target;
    }}>
      <button
        className="icon-btn"
        title="Back"
        aria-label="Back"
        disabled={!info.canGoBack}
        style={{ opacity: info.canGoBack ? 1 : 0.35 }}
        onClick={() => void window.kinexAPI.littleKinexAction('back')}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        className="icon-btn"
        title="Forward"
        aria-label="Forward"
        disabled={!info.canGoForward}
        style={{ opacity: info.canGoForward ? 1 : 0.35 }}
        onClick={() => void window.kinexAPI.littleKinexAction('forward')}
      >
        <ArrowRight size={14} />
      </button>
      <button
        className="icon-btn"
        title="Reload"
        aria-label="Reload"
        onClick={() => void window.kinexAPI.littleKinexAction('reload')}
      >
        <RotateCw size={13} />
      </button>

      {privateSession && (
        <span className="private-badge" title="Isolated private session">
          <Shield size={11} />
          Private
        </span>
      )}

      {!privateSession && info.securityState === 'secure' && (
        <Lock size={12} style={{ opacity: 0.65, flexShrink: 0 }} />
      )}

      <form
        style={{ flex: 1, display: 'flex' }}
        onSubmit={(e) => {
          e.preventDefault();
          void window.kinexAPI.littleKinexAction('navigate', urlInput).then(() => window.kinexAPI.littleKinexAction('focus-content'));
        }}
      >
        <input
          ref={addressRef}
          className="little-url-input"
          aria-label="Address bar"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setUrlInput(info.url);
              void window.kinexAPI.littleKinexAction('focus-content');
            }
          }}
        />
      </form>

      {!privateSession && (
        <button
          className="btn-primary"
          style={{ padding: '4px 10px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}
          onClick={() => void window.kinexAPI.littleKinexAction('promote')}
        >
          <ExternalLink size={12} /> Open in Kinex
        </button>
      )}
    </header>
  );
};
