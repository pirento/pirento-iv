import { useEffect, useState } from 'react';
import {
  readWorkspaceRoute,
  ROUTE_EVENT,
  changeLocation,
  workspaceUrl,
  type WorkspaceRoute,
} from './workspace-route';

export function useWorkspaceRoute() {
  const read = () => readWorkspaceRoute(window.location.pathname, window.location.search);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => {
      setRoute(read());
      window.scrollTo({ top: 0, behavior: 'auto' });
    };
    window.addEventListener('popstate', update);
    window.addEventListener(ROUTE_EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return {
    route,
    navigate: (next: WorkspaceRoute, replace = false) => changeLocation(workspaceUrl(next), replace),
  };
}
