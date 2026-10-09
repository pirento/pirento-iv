import { useLayoutEffect, useRef, useState } from 'react';
import { installPreviewNavigationGuard } from './preview-navigation';

/** Deployment notice only; backend guards enforce the integration restrictions. */
export default function PreviewNotice() {
  const notice = useRef<HTMLElement>(null);
  const [navigationBlocked, setNavigationBlocked] = useState(false);

  useLayoutEffect(() => installPreviewNavigationGuard(() => setNavigationBlocked(true)), []);

  useLayoutEffect(() => {
    const element = notice.current;
    if (!element) return;

    const measure = () => {
      document.documentElement.style.setProperty(
        '--iv-preview-notice-height',
        `${Math.ceil(element.getBoundingClientRect().height)}px`,
      );
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      document.documentElement.style.removeProperty('--iv-preview-notice-height');
    };
  }, []);

  return (
    <aside ref={notice} className="iv-preview-notice" aria-label="Temporary synthetic preview">
      <span className="iv-preview-print-watermark" aria-hidden="true">
        TEST PREVIEW — NOT A VALID INVOICE
      </span>
      <strong>TEMPORARY SYNTHETIC PREVIEW</strong>
      <p>
        Test data only. Do not enter real invoices, customer data or integration credentials. Data may be lost
        on restart or redeploy.
      </p>
      <p>GST, payment, email, broker and other external integrations are disabled.</p>
      {navigationBlocked ? <p role="status">External links are disabled in this test preview.</p> : null}
    </aside>
  );
}
