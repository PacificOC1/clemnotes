import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { readOnlyExtensions } from '../tiptap/extensions';
import { StaticDoc, docNeedsEditor } from '../tiptap/StaticDoc';
import type { DocNode } from '../tiptap/docUtils';

/**
 * A rem's document drawn without any editing affordances — a card face, or a
 * past version in the history view.
 *
 * Drawn by `StaticDoc`, the same renderer an outline row uses until you click
 * into it, so links, maths, clozes, tags and images look exactly as they do in
 * the outline — without building a ProseMirror editor for every card of a
 * review session. A document holding something only an editor can draw (a
 * query block) still gets a read-only editor.
 */
export function ReadOnlyDoc({ doc, className }: { doc: DocNode; className?: string }) {
  if (docNeedsEditor(doc)) return <ReadOnlyEditor doc={doc} className={className} />;
  return (
    <div className={className}>
      <StaticDoc doc={doc} />
    </div>
  );
}

function ReadOnlyEditor({ doc, className }: { doc: DocNode; className?: string }) {
  const serialized = JSON.stringify(doc);
  const editor = useEditor({ extensions: readOnlyExtensions, content: doc, editable: false }, []);

  useEffect(() => {
    if (editor) editor.commands.setContent(JSON.parse(serialized), { emitUpdate: false });
  }, [editor, serialized]);

  return (
    <div className={className}>
      <EditorContent editor={editor} />
    </div>
  );
}
