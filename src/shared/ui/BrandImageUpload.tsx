import { useRef, useState } from 'react';
import { ImagePlus, Upload, X } from 'lucide-react';

export default function BrandImageUpload({
  label,
  value,
  onChange,
  disabled = false,
  onBusyChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="org-field">
      {label}
      <div className="org-logo-upload">
        <div className={`org-upload-preview ${label.includes('Signature') ? 'org-signature-preview' : ''}`}>
          {value ? <img src={value} alt={label} /> : <ImagePlus size={25} />}
        </div>
        <div className="org-upload-description">
          <strong>{value ? `${label} added` : `Add ${label.toLowerCase()}`}</strong>
          <span>PNG, JPG or WebP · Up to 500 KB</span>
          <div className="org-upload-actions">
            <button
              className="org-small-button"
              type="button"
              disabled={busy || disabled}
              onClick={() => input.current?.click()}
            >
              <Upload size={14} />
              {busy ? 'Reading…' : `Upload ${label.toLowerCase()}`}
            </button>
            {value && (
              <button
                className="org-text-button"
                type="button"
                disabled={busy || disabled}
                onClick={() => onChange('')}
              >
                <X size={13} /> Remove
              </button>
            )}
          </div>
        </div>
        <input
          ref={input}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 500 * 1024) {
              setError('Choose a PNG, JPG or WebP image up to 500 KB.');
              return;
            }
            setBusy(true);
            onBusyChange?.(true);
            setError('');
            try {
              const value = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(new Error('Image could not be read.'));
                reader.readAsDataURL(file);
              });
              await new Promise<void>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve();
                image.onerror = () => reject(new Error('Choose a valid image file.'));
                image.src = value;
              });
              onChange(value);
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Unable to read the image.');
            } finally {
              setBusy(false);
              onBusyChange?.(false);
            }
          }}
        />
      </div>
      {error && (
        <span className="org-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
