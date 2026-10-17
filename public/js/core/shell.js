/**
 * Loaded on every page (layouts/public.ejs and layouts/workspace.ejs): toast after navigation,
 * mobile navigation menu (focus trap, Escape to close), business switcher, sign-out, and the
 * synthetic-preview link guard.
 */

import { api, sendJson, showToast, setBusy } from './api.js';
import { getPageData } from './page.js';
import { clearWorkspaceStorage } from './optional-storage.js';
import { installPreviewNavigationGuard } from './preview-navigation.js';

const data = getPageData();

// The synthetic preview blocks links that leave this origin; server guards still disable integrations.
const previewNotice = document.querySelector('[data-preview-notice]');
if (previewNotice) {
  installPreviewNavigationGuard(() => {
    previewNotice.querySelector('[data-preview-link-status]').hidden = false;
  });
}
try {
  const savedToast = sessionStorage.getItem('vc:toast');
  if (savedToast) {
    sessionStorage.removeItem('vc:toast');
    showToast(savedToast);
  }
} catch {
  /* Navigation remains usable when browser storage is unavailable. */
}

const sidebar = document.querySelector('#workspace-navigation');
const menuToggle = document.querySelector('[data-toggle-sidebar]');
const menuClose = document.querySelector('[data-close-sidebar]');
const mainWorkspace = document.querySelector('.workspace-main');
const skipLink = document.querySelector('.skip-link');
const mobileNavigation = window.matchMedia('(max-width: 820px)');
let menuOpen = false;
let scrollBeforeMenu = { x: 0, y: 0 };

function menuFocusableItems() {
  return [...sidebar.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(
    (element) =>
      !element.disabled && element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.hidden,
  );
}

/** One transition owns visual state, accessibility state, focus and scrolling. */
function setMenuOpen(open) {
  if (!sidebar || !menuToggle) return;
  const nextOpen = mobileNavigation.matches && open;
  const wasOpen = menuOpen;
  const focusInside = sidebar.contains(document.activeElement);
  if (nextOpen && !wasOpen) {
    scrollBeforeMenu = { x: window.scrollX, y: window.scrollY };
    document.body.style.setProperty('--navigation-scroll-top', `${-scrollBeforeMenu.y}px`);
  }
  menuOpen = nextOpen;
  mainWorkspace.inert = nextOpen;
  if (skipLink) skipLink.inert = nextOpen;
  menuToggle.setAttribute('aria-expanded', String(nextOpen));
  menuToggle.setAttribute('aria-label', nextOpen ? 'Close navigation' : 'Open navigation');
  if (nextOpen) {
    sidebar.inert = false;
    sidebar.removeAttribute('aria-hidden');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    document.body.classList.add('sidebar-open');
    if (!wasOpen) menuClose.focus({ preventScroll: true });
    return;
  }

  document.body.classList.remove('sidebar-open');
  document.body.style.removeProperty('--navigation-scroll-top');
  if (wasOpen) window.scrollTo({ left: scrollBeforeMenu.x, top: scrollBeforeMenu.y, behavior: 'instant' });
  // Move focus before making a mobile sidebar inaccessible to assistive technology.
  if (mobileNavigation.matches && (wasOpen || focusInside)) menuToggle.focus({ preventScroll: true });
  sidebar.inert = mobileNavigation.matches;
  if (mobileNavigation.matches) sidebar.setAttribute('aria-hidden', 'true');
  else sidebar.removeAttribute('aria-hidden');
  sidebar.removeAttribute('role');
  sidebar.removeAttribute('aria-modal');
  if (
    !mobileNavigation.matches &&
    (document.activeElement === menuToggle || document.activeElement === menuClose)
  )
    sidebar.querySelector('[aria-current="page"]')?.focus({ preventScroll: true });
}

menuToggle?.addEventListener('click', () => setMenuOpen(!menuOpen));
menuClose?.addEventListener('click', () => setMenuOpen(false));
document.querySelector('[data-sidebar-overlay]')?.addEventListener('click', () => setMenuOpen(false));
document.addEventListener('keydown', (event) => {
  if (!menuOpen) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    setMenuOpen(false);
  } else if (event.key === 'Tab') {
    const items = menuFocusableItems();
    const first = items[0];
    const last = items.at(-1);
    if (!first) return;
    if (event.shiftKey && (document.activeElement === first || !sidebar.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || !sidebar.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  }
});
sidebar?.addEventListener('click', (event) => {
  if (menuOpen && event.target.closest('a[href]')) setMenuOpen(false);
});
mobileNavigation.addEventListener('change', () => setMenuOpen(false));
window.addEventListener('pageshow', () => setMenuOpen(false));
setMenuOpen(false);

document.querySelector('[data-organization-switch]')?.addEventListener('change', (event) => {
  const id = event.target.value;
  try {
    localStorage.setItem('vc-organization', id);
  } catch {
    /* The cookie and destination still select the requested business. */
  }
  document.cookie = `vc_organization=${encodeURIComponent(id)}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
  setMenuOpen(false);
  location.assign(`/workspace/${encodeURIComponent(id)}/overview`);
});
document.querySelector('[data-logout]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  setBusy(button, true, 'Signing out…');
  try {
    await api('/auth/logout', sendJson('POST'));
    clearWorkspaceStorage();
    location.replace('/login');
  } catch (error) {
    showToast(error.message, 'error');
    setBusy(button, false);
  }
});
window.addEventListener('vc-session-expired', () => {
  const returnTo = location.pathname.startsWith('/workspace/') ? location.pathname + location.search : '';
  location.assign(`/login${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}`);
});

// Old bookmarked auth hash links continue to reach the equivalent full EJS page.
if (/^#(?:login|signup|forgot-password|reset-password)(?:\?|$)/.test(location.hash)) {
  location.replace(`/${location.hash.slice(1)}`);
}

try {
  if (data.route?.organizationId) localStorage.setItem('vc-organization', data.route.organizationId);
} catch {
  /* The current route already identifies the selected organization. */
}
