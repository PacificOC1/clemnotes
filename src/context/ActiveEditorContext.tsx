import { createContext, useContext } from 'react';
import type { Editor } from '@tiptap/react';

interface ActiveEditorContextValue {
  activeEditor: Editor | null;
  /** The rem whose editor currently has focus — app-level menus need it for rem-scoped commands. */
  activeNodeId: string | null;
  setActive: (editor: Editor | null, nodeId: string | null) => void;
}

export const ActiveEditorContext = createContext<ActiveEditorContextValue>({
  activeEditor: null,
  activeNodeId: null,
  setActive: () => {},
});

export function useActiveEditor() {
  return useContext(ActiveEditorContext);
}
