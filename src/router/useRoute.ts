import { useCallback, useEffect, useState } from 'react';
import { formatRoute, parseRoute, sameRoute, type Route } from './route';

/**
 * The route, kept in the address bar.
 *
 * `pushState` fires neither `popstate` nor `hashchange`, so navigating from
 * inside the app updates React state directly and the listeners below are
 * purely for navigation that happens *to* us: the back and forward buttons,
 * and someone editing the hash by hand.
 */
export interface Navigator {
  route: Route;
  /**
   * Go somewhere. `replace` swaps the current history entry instead of adding
   * one — for corrections (a deleted page, a rem that no longer exists) that
   * should not become a back target.
   */
  navigate: (next: Route, options?: { replace?: boolean }) => void;
}

function currentRoute(): Route {
  return parseRoute(typeof window === 'undefined' ? '' : window.location.hash);
}

export function useRoute(): Navigator {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const sync = () => setRoute(currentRoute());
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  /**
   * Keep the address bar canonical, without adding to the history.
   *
   * On first load this gives the entry a copyable address. It also has to run
   * on every change: typing `#/nonsense` is a same-document navigation, so
   * React never remounts, the route parses to the notes tab, and without this
   * the URL would keep claiming to be somewhere that does not exist. A no-op
   * whenever `navigate` has already written the same hash.
   */
  useEffect(() => {
    const canonical = formatRoute(route);
    if (window.location.hash !== canonical) {
      window.history.replaceState(null, '', canonical);
    }
  }, [route]);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const url = formatRoute(next);
    // Compared against the address bar rather than against React state: under
    // StrictMode a state updater can run twice, and pushing history from
    // inside one would leave a duplicate entry every time you navigated.
    if (window.location.hash !== url) {
      // Zooming into twenty rems should leave twenty back steps; correcting a
      // route that pointed at something deleted should leave none.
      if (options?.replace) window.history.replaceState(null, '', url);
      else window.history.pushState(null, '', url);
    }
    setRoute((current) => (sameRoute(current, next) ? current : next));
  }, []);

  return { route, navigate };
}
