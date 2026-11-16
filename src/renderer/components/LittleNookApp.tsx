import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from 'lucide-react';

export const LittleNookApp: React.FC = () => {
  const [info, setInfo] = useState({
    url: '',
    title: 'Little Kinex',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  });
  const [urlInput, setUrlInput] = useState('');

  useEffect(() => {
    void window.nookAPI.getLittleNookInfo().then((initial) => {
      setInfo(initial);
      setUrlInput(initial.url);
    });
    return window.nookAPI.onLittleNookUpdated((next) => {
      setInfo(next);
      setUrlInput(next.url);
    });
  }, []);

  return (
    <header className="little-header">
      <button
        className="icon-btn"
        disabled={!info.canGoBack}
        style={{ opacity: info.canGoBack ? 1 : 0.35 }}
        onClick={() => void window.nookAPI.littleNookAction('back')}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        className="icon-btn"
        disabled={!info.canGoForward}
        style={{ opacity: info.canGoForward ? 1 : 0.35 }}
        onClick={() => void window.nookAPI.littleNookAction('forward')}
      >
        <ArrowRight size={14} />
      </button>
      <button
        className="icon-btn"
        onClick={() => void window.nookAPI.littleNookAction('reload')}
      >
        <RotateCw size={13} />
      </button>
      <form
        style={{ flex: 1, display: 'flex' }}
        onSubmit={(e) => {
          e.preventDefault();
          void window.nookAPI.littleNookAction('navigate', urlInput);
        }}
      >
        <input
          className="little-url-input"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
      </form>
      <button
        className="btn-primary"
        style={{ padding: '4px 10px', fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5 }}
        onClick={() => void window.nookAPI.littleNookAction('promote')}
      >
        <ExternalLink size={12} /> Open in Kinex
      </button>
    </header>
  );
};
