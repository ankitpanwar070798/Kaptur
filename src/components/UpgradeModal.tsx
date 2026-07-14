import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './UpgradeModal.css';

interface UpgradeModalProps {
  onClose: () => void;
  onSuccess: () => void;
}

export function UpgradeModal({ onClose, onSuccess }: UpgradeModalProps) {
  const [licenseKey, setLicenseKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleActivate = async () => {
    if (!licenseKey.trim()) {
      setError('Please enter a license key.');
      return;
    }
    
    setIsLoading(true);
    setError(null);
    
    try {
      const isValid = await invoke<boolean>('activate_license_key', { key: licenseKey.trim() });
      if (isValid) {
        onSuccess();
      } else {
        setError('Invalid license key. Please check and try again.');
      }
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-content upgrade-modal">
        <button className="modal-close" onClick={onClose} title="Close">✕</button>
        
        <h2>Upgrade to Pixaan Pro</h2>
        
        <div className="upgrade-features">
          <p>Pixaan Pro unlocks advanced power-user capabilities while keeping everything local and private.</p>
          <ul>
            <li><strong>Multiple Watched Folders:</strong> Index screenshots from custom local folders, downloads, or external local drives simultaneously.</li>
            <li><strong>Custom Redaction Patterns:</strong> Define your own Regex rules to automatically detect and blur company-specific IDs or project codes.</li>
            <li><strong>Bulk Export / Backup:</strong> Package your entire indexed history (images and extracted text) into a single zip file for safekeeping.</li>
          </ul>
        </div>

        <div className="license-entry">
          <label htmlFor="license-key">Activate License</label>
          <div className="license-input-group">
            <input 
              id="license-key"
              type="text" 
              placeholder="Enter your license key (or 'pixaan_pro_test')" 
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
            />
            <button 
              className="activate-btn" 
              onClick={handleActivate}
              disabled={isLoading}
            >
              {isLoading ? 'Activating...' : 'Activate'}
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
        </div>
      </div>
    </div>
  );
}
