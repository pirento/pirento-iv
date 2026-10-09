import { useState } from 'react';
import { ArrowLeft, Building2, ImagePlus, LoaderCircle, Save } from 'lucide-react';
import type { Organization, WorkspaceSettings } from '../../../shared/types';
import BrandImageUpload from '../../shared/ui/BrandImageUpload';
import './organization.css';
import '../../shared/styles/page-editors.css';

interface Props {
  settings: WorkspaceSettings;
  organization: Organization;
  onEditOrganization: () => void;
  onSave: (input: WorkspaceSettings) => Promise<void>;
  onClose: () => void;
}

export default function WorkspaceSettingsEditor({
  settings,
  organization,
  onEditOrganization,
  onSave,
  onClose,
}: Props) {
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [failedLogoUrl, setFailedLogoUrl] = useState('');
  const initials = organization.name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();

  return (
    <section
      className="workspace-page editor-page workspace-settings-page"
      aria-labelledby="workspace-settings-title"
    >
      <nav className="editor-page-navigation" aria-label="Dashboard branding navigation">
        <button type="button" className="button secondary" disabled={busy || uploading} onClick={onClose}>
          <ArrowLeft size={16} />
          Back
        </button>
      </nav>
      <div className="editor-page-panel">
        <header className="editor-page-heading">
          <div className="editor-page-title-icon">
            <Building2 size={22} />
          </div>
          <div>
            <h1 id="workspace-settings-title">Dashboard branding</h1>
            <p>The dashboard follows the name and logo of the organization you select.</p>
          </div>
        </header>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || uploading) return;
            setBusy(true);
            setError('');
            try {
              await onSave(form);
              onClose();
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="editor-page-body">
            <section className="workspace-organization-brand" aria-labelledby="selected-organization-brand">
              <div className="workspace-organization-brand-mark">
                {organization.logoUrl && organization.logoUrl !== failedLogoUrl ? (
                  <img
                    src={organization.logoUrl}
                    alt={`${organization.name} logo`}
                    onError={() => setFailedLogoUrl(organization.logoUrl)}
                  />
                ) : (
                  <span aria-hidden="true">{initials}</span>
                )}
              </div>
              <div className="workspace-organization-brand-details">
                <span className="workspace-brand-eyebrow">SELECTED ORGANIZATION</span>
                <h2 id="selected-organization-brand">{organization.name}</h2>
                <p>
                  This organization’s name and logo identify its dashboard. Upload a logo in Business
                  settings; until then, its initials appear here.
                </p>
                <button
                  className="button secondary"
                  type="button"
                  disabled={busy || uploading}
                  onClick={onEditOrganization}
                >
                  <ImagePlus size={16} />
                  Edit organization logo
                </button>
              </div>
            </section>
            <label className="org-field">
              Workspace company name
              <input value={form.companyName} readOnly />
            </label>
            <BrandImageUpload
              label="Workspace logo"
              value={form.dashboardLogoUrl}
              onChange={(value) => setForm((current) => ({ ...current, dashboardLogoUrl: value }))}
              disabled={busy || uploading}
              onBusyChange={setUploading}
            />
            <p className="field-hint">
              This shared logo represents the company on the Organizations overview. Each organization’s
              dashboard uses its own name and logo. Draft documents can have a custom invoice logo.
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="editor-page-footer">
            <button className="button secondary" type="button" disabled={busy || uploading} onClick={onClose}>
              Cancel
            </button>
            <button className="button primary" type="submit" disabled={busy || uploading}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}Save workspace branding
            </button>
          </footer>
        </form>
      </div>
    </section>
  );
}
