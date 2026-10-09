import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app/App';
import ErrorBoundary from './shared/ui/ErrorBoundary';
import AuthShell from './features/auth/AuthShell';
import './shared/styles/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthShell>{(user, onLogout) => <App key={user.id} user={user} onLogout={onLogout} />}</AuthShell>
    </ErrorBoundary>
  </React.StrictMode>,
);
