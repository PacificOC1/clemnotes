import { createContext, useContext } from 'react';

interface NavigationContextValue {
  onZoomTo: (nodeId: string) => void;
}

export const NavigationContext = createContext<NavigationContextValue>({
  onZoomTo: () => {},
});

export function useNavigation() {
  return useContext(NavigationContext);
}
