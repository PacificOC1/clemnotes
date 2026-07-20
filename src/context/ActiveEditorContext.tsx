import { createContext, useContext } from 'react';
import type { Editor } from '@tiptap/react';

interface ActiveEditorContextValue {
  activeEditor: Editor | null;
  setActiveEditor: (editor: Editor | null) => void;
}

export const ActiveEditorContext = createContext<ActiveEditorContextValue>({
  activeEditor: null,
  setActiveEditor: () => {},
});

export function useActiveEditor() {
  return useContext(ActiveEditorContext);
}
