import { createContext, useContext } from 'react';

interface NavigationContextValue {
  onZoomTo: (nodeId: string) => void;
  /** Open a rem in the other pane (shift-click on a link) — see SplitPane. */
  onOpenInSplit?: (nodeId: string) => void;
}

export const NavigationContext = createContext<NavigationContextValue>({
  onZoomTo: () => {},
});

export function useNavigation() {
  return useContext(NavigationContext);
}
