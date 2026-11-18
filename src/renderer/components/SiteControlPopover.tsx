import React, { useId } from 'react';
import { Cookie, Lock, LockOpen, ShieldAlert, ShieldCheck, ShieldOff, X } from 'lucide-react';
import type { ShieldsMode } from '../../shared/types';

/** Locally-declared view contract; structural-compatible with the main-process model. */
export type SiteCookiePolicy = 'allow' | 'block-third-party' | 'block-all';

export interface SiteControlPermissionView {
  permission: string;
  status: 'allowed' | 'denied';
  origin: string;
}

export interface SiteControlViewModel {
  url: string;
  origin: string;
  host: string;
  isInternal: boolean;
  tls: { state: string; secure: boolean; label: 'secure' | 'insecure' | 'warning' | 'internal' };
  shields: { mode: ShieldsMode; source: string; domainKey: string };
  cookiePolicy: { effective: SiteCookiePolicy; source: string; origin: string };
  permissions: SiteControlPermissionView[];
}

export interface SiteControlPopoverProps {
  model: SiteControlViewModel | null;
  reducedMotion?: boolean;
  onClose: () => void;
  onShieldsModeChange: (mode: ShieldsMode | 'inherit') => void;
  onCookiePolicyChange: (policy: SiteCookiePolicy) => void;
  onPermissionChange: (permission: string, decision: 'allow' | 'deny') => void;
}

const COOKIE_LABELS: Record<SiteCookiePolicy, string> = {
  allow: 'Allow all cookies',
  'block-third-party': 'Block third-party cookies',
  'block-all': 'Block all cookies',
};

export const SiteControlPopover: React.FC<SiteControlPopoverProps> = ({
  model,
  reducedMotion = false,
  onClose,
  onShieldsModeChange,
  onCookiePolicyChange,
  onPermissionChange,
}) => {
  const selectId = useId();
  const motionStyle: React.CSSProperties = reducedMotion ? { transition: 'none', animation: 'none' } : {};

  if (!model) return null;

  const tlsIcon = model.tls.secure ? <Lock size={14} /> : <LockOpen size={14} />;
  const shieldIcon =
    model.shields.mode === 'disabled' ? (
      <ShieldOff size={14} />
    ) : model.shields.mode === 'aggressive' ? (
      <ShieldAlert size={14} />
    ) : (
      <ShieldCheck size={14} />
    );

  return (
    <div
      className="site-control-popover"
      role="dialog"
      aria-label="Site controls"
      data-low-power={reducedMotion || undefined}
      style={motionStyle}
    >
      <div className="modal-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
          {tlsIcon}
          <span>Site controls</span>
          <span className="command-kind-tag">{model.host || 'Internal page'}</span>
        </div>
        <button className="icon-btn" aria-label="Close site controls" onClick={onClose}>
          <X size={15} />
        </button>
      </div>

      {model.isInternal ? (
        <p className="settings-row-desc" role="status">
          Internal Kinex pages are protected and cannot be modified here.
        </p>
      ) : (
        <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
          <section aria-label="Connection security">
            <div className="settings-row-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {tlsIcon} Connection
            </div>
            <div className="settings-row-desc" role="status">
              {model.tls.label === 'warning'
                ? 'Certificate warning — connection may be unsafe.'
                : model.tls.secure
                  ? 'Secure connection (HTTPS).'
                  : 'Insecure connection (HTTP).'}
            </div>
          </section>

          <section aria-label="Kinex Shields">
            <div className="settings-row-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {shieldIcon} Shields
            </div>
            <div className="segmented" role="group" aria-label="Shields mode">
              {(['standard', 'aggressive', 'disabled'] as ShieldsMode[]).map((mode) => (
                <button
                  key={mode}
                  className="segment"
                  aria-pressed={model.shields.mode === mode}
                  onClick={() => onShieldsModeChange(mode)}
                >
                  {mode[0]!.toUpperCase() + mode.slice(1)}
                </button>
              ))}
              {model.shields.source !== 'global' && (
                <button className="segment" onClick={() => onShieldsModeChange('inherit')}>
                  Inherit
                </button>
              )}
            </div>
          </section>

          <section aria-label="Cookie policy">
            <label className="settings-row-title" htmlFor={selectId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Cookie size={14} /> Cookies
            </label>
            <select
              id={selectId}
              className="select"
              value={model.cookiePolicy.effective}
              onChange={(event) => onCookiePolicyChange(event.target.value as SiteCookiePolicy)}
            >
              {(Object.keys(COOKIE_LABELS) as SiteCookiePolicy[]).map((policy) => (
                <option key={policy} value={policy}>
                  {COOKIE_LABELS[policy]}
                </option>
              ))}
            </select>
          </section>

          {model.permissions.length > 0 && (
            <section aria-label="Site permissions">
              <div className="settings-row-title">Permissions</div>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 6 }}>
                {model.permissions.map((permission) => (
                  <li key={permission.permission} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1 }}>{permission.permission}</span>
                    <span className="command-kind-tag">{permission.status}</span>
                    <button
                      className="text-btn"
                      aria-label={`${permission.status === 'allowed' ? 'Deny' : 'Allow'} ${permission.permission} for ${model.host}`}
                      onClick={() =>
                        onPermissionChange(
                          permission.permission,
                          permission.status === 'allowed' ? 'deny' : 'allow'
                        )
                      }
                    >
                      {permission.status === 'allowed' ? 'Deny' : 'Allow'}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
};
