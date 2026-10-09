import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import ErrorBoundary from './shared/ui/ErrorBoundary';
import AuthShell from './features/auth/AuthShell';
import PreviewNotice from './shared/ui/PreviewNotice';
import './shared/styles/styles.css';
import './shared/ui/preview-notice.css';

// Only the explicit preview server injects this marker. An ordinary production
// index keeps the existing UI and makes no deployment-mode network request.
const isSyntheticPreview =
  document.querySelector<HTMLMetaElement>('meta[name="iv-deployment-mode"]')?.content ===
  'disposable-synthetic-preview';
if (isSyntheticPreview) {
  document.documentElement.dataset.ivDeploymentMode = 'disposable-synthetic-preview';
  document.title = `TEMPORARY PREVIEW — ${document.title}`;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isSyntheticPreview ? <PreviewNotice /> : null}
    <ErrorBoundary>
      <AuthShell>{(user, onLogout) => <App key={user.id} user={user} onLogout={onLogout} />}</AuthShell>
    </ErrorBoundary>
  </React.StrictMode>,
);
