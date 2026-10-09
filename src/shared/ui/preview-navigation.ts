/** Browser navigation has no role in contacting live services in this preview. */
export function isAllowedPreviewLink(href: string, currentUrl: string, download = false): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(href, current);
    if (target.origin !== current.origin || target.username || target.password) return false;
    if (target.protocol === 'blob:') {
      // Blob URLs retain the creator origin, but their outer URL has no userinfo.
      // Reject credentials in the embedded URL too; only local exports belong here.
      const source = new URL(target.pathname);
      return download && !source.username && !source.password;
    }
    return target.protocol === 'https:' || target.protocol === 'http:';
  } catch {
    return false;
  }
}

export function installPreviewNavigationGuard(onBlocked: () => void): () => void {
  const blockExternalAnchor = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href], area[href]');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (href !== null && isAllowedPreviewLink(href, window.location.href, anchor.hasAttribute('download')))
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onBlocked();
  };
  const events = ['click', 'auxclick', 'contextmenu'] as const;
  for (const event of events) document.addEventListener(event, blockExternalAnchor, true);
  return () => {
    for (const event of events) document.removeEventListener(event, blockExternalAnchor, true);
  };
}
