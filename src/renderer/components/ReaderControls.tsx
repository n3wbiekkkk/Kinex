import React, { useId } from 'react';
import { BookOpen, ListCheck, ListPlus, Minus, Plus, Type, X } from 'lucide-react';
import type { ReaderOptions, ReaderTheme } from '../../shared/types';

export interface ReaderControlsProps {
  active: boolean;
  options: ReaderOptions;
  inReadingList: boolean;
  reducedMotion?: boolean;
  onToggleReader: () => void;
  onFontSizeChange: (fontSize: number) => void;
  onThemeChange: (theme: ReaderTheme) => void;
  onToggleReadingList: () => void;
  onClose: () => void;
}

const MIN_FONT = 12;
const MAX_FONT = 28;
const THEMES: ReaderTheme[] = ['light', 'sepia', 'dark'];

export const ReaderControls: React.FC<ReaderControlsProps> = ({
  active,
  options,
  inReadingList,
  reducedMotion = false,
  onToggleReader,
  onFontSizeChange,
  onThemeChange,
  onToggleReadingList,
  onClose,
}) => {
  const themeId = useId();
  const motionStyle: React.CSSProperties = reducedMotion ? { transition: 'none', animation: 'none' } : {};
  const fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(options.fontSize)));

  return (
    <div
      className="reader-controls"
      role="toolbar"
      aria-label="Reader Mode controls"
      data-low-power={reducedMotion || undefined}
      style={motionStyle}
    >
      <button
        className="icon-btn"
        aria-label={active ? 'Exit Reader Mode' : 'Enter Reader Mode'}
        aria-pressed={active}
        onClick={onToggleReader}
      >
        <BookOpen size={16} />
      </button>

      <div className="reader-font-control" role="group" aria-label="Reader font size">
        <Type size={14} aria-hidden="true" />
        <button
          className="icon-btn"
          aria-label="Decrease reader font size"
          disabled={fontSize <= MIN_FONT}
          onClick={() => onFontSizeChange(Math.max(MIN_FONT, fontSize - 1))}
        >
          <Minus size={14} />
        </button>
        <span aria-live="polite" aria-label={`Font size ${fontSize}`}>
          {fontSize}
        </span>
        <button
          className="icon-btn"
          aria-label="Increase reader font size"
          disabled={fontSize >= MAX_FONT}
          onClick={() => onFontSizeChange(Math.min(MAX_FONT, fontSize + 1))}
        >
          <Plus size={14} />
        </button>
      </div>

      <label className="sr-only" htmlFor={themeId}>
        Reader theme
      </label>
      <select
        id={themeId}
        className="select"
        aria-label="Reader theme"
        value={options.theme}
        onChange={(event) => onThemeChange(event.target.value as ReaderTheme)}
      >
        {THEMES.map((theme) => (
          <option key={theme} value={theme}>
            {theme[0]!.toUpperCase() + theme.slice(1)}
          </option>
        ))}
      </select>

      <button
        className="icon-btn"
        aria-label={inReadingList ? 'Remove from Reading List' : 'Add to Reading List'}
        aria-pressed={inReadingList}
        onClick={onToggleReadingList}
      >
        {inReadingList ? <ListCheck size={16} /> : <ListPlus size={16} />}
      </button>

      <button className="icon-btn" aria-label="Close Reader controls" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
};
