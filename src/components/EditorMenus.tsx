import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useActiveEditor } from '../context/ActiveEditorContext';
import { setMenuKeyHandler } from '../editor/menuStore';
import { createPage, searchNodesByTitle } from '../db/repository';
import type { OutlinerNode } from '../db/schema';

type MenuKind = 'slash' | 'wiki';

interface Trigger {
  kind: MenuKind;
  query: string;
  /** Doc position where the trigger text (`/` or `[[`) starts. */
  from: number;
  /** Doc position of the cursor. */
  to: number;
}

interface Coords {
  left: number;
  top: number;
  bottom: number;
}

interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void | Promise<void>;
}

interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  icon: string;
  keywords: string[];
  run: (editor: Editor, ctx: SlashContext) => void;
}

interface SlashContext {
  nodeId: string | null;
  onEmbed: (nodeId: string) => void;
}

/**
 * Everything reachable from `/`. Each command receives the editor with the
 * trigger text already deleted, so it can just insert or toggle.
 */
const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'h1', label: 'Heading 1', hint: 'Big section title', icon: 'H1',
    keywords: ['heading', 'title', 'h1', 'big'],
    run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2', label: 'Heading 2', hint: 'Medium section title', icon: 'H2',
    keywords: ['heading', 'h2', 'subtitle'],
    run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3', label: 'Heading 3', hint: 'Small section title', icon: 'H3',
    keywords: ['heading', 'h3'],
    run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
  },
  {
    id: 'text', label: 'Normal text', hint: 'Plain paragraph', icon: '¶',
    keywords: ['paragraph', 'normal', 'plain', 'body'],
    run: (e) => e.chain().focus().setParagraph().run(),
  },
  {
    id: 'todo', label: 'To-do', hint: 'Checkbox you can tick off', icon: '☑',
    keywords: ['todo', 'task', 'checkbox', 'check'],
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  {
    id: 'flashcard', label: 'Flashcard', hint: 'Concept :: Descriptor — makes a card', icon: '🂠',
    keywords: ['card', 'flashcard', 'rem', 'answer', 'question', 'srs'],
    run: (e) => e.chain().focus().insertContent(' :: ').run(),
  },
  {
    id: 'cloze', label: 'Cloze blank', hint: 'Type {{the hidden bit}}', icon: '⌷',
    keywords: ['cloze', 'blank', 'occlusion', 'hide', 'fill'],
    run: (e) => e.chain().focus().insertContent('{{').run(),
  },
  {
    id: 'link', label: 'Link to rem', hint: 'Type [[ to search', icon: '⧉',
    keywords: ['link', 'reference', 'wiki', 'mention'],
    run: (e) => e.chain().focus().insertContent('[[').run(),
  },
  {
    id: 'embed', label: 'Embed rem', hint: 'Live, editable copy of another rem', icon: '⧈',
    keywords: ['embed', 'portal', 'transclude', 'include'],
    run: (_e, ctx) => { if (ctx.nodeId) ctx.onEmbed(ctx.nodeId); },
  },
  {
    id: 'math', label: 'Math', hint: 'Type $ then LaTeX then $', icon: '∑',
    keywords: ['math', 'latex', 'formula', 'equation', 'katex'],
    run: (e) => e.chain().focus().insertContent('$').run(),
  },
  {
    id: 'bullets', label: 'Bullet list', hint: 'Nested list inside this rem', icon: '•',
    keywords: ['bullet', 'list', 'unordered'],
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  {
    id: 'numbers', label: 'Numbered list', hint: 'Ordered list inside this rem', icon: '1.',
    keywords: ['number', 'ordered', 'list'],
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  {
    id: 'quote', label: 'Quote', hint: 'Indented block quote', icon: '❝',
    keywords: ['quote', 'blockquote', 'citation'],
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  {
    id: 'code', label: 'Code block', hint: 'Monospaced block', icon: '{ }',
    keywords: ['code', 'snippet', 'pre', 'monospace'],
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  {
    id: 'table', label: 'Table', hint: '3 × 3 with a header row', icon: '⊞',
    keywords: ['table', 'grid', 'rows', 'columns'],
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'divider', label: 'Divider', hint: 'Horizontal rule', icon: '—',
    keywords: ['divider', 'rule', 'separator', 'hr', 'line'],
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
];

/** Find a `/command` or `[[link` trigger immediately before the cursor. */
function detectTrigger(editor: Editor): Trigger | null {
  const { state } = editor;
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if ($from.parent.type.name === 'codeBlock') return null;

  const blockStart = $from.start();
  if (selection.from < blockStart) return null;
  // Inline atoms (wiki links, math, clozes) each count as one character here,
  // so string offsets line up with document positions.
  const textBefore = state.doc.textBetween(blockStart, selection.from, '\n', '\0');

  const wiki = /\[\[([^[\]\n]*)$/.exec(textBefore);
  if (wiki) {
    return { kind: 'wiki', query: wiki[1] ?? '', from: selection.from - wiki[0].length, to: selection.from };
  }

  const slash = /(?:^|\s)(\/[a-zA-Z]*)$/.exec(textBefore);
  if (slash) {
    const token = slash[1]!;
    return { kind: 'slash', query: token.slice(1), from: selection.from - token.length, to: selection.from };
  }

  return null;
}

function matchCommands(query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (cmd) => cmd.label.toLowerCase().includes(q) || cmd.keywords.some((k) => k.startsWith(q))
  );
}

interface EditorMenusProps {
  onEmbed: (nodeId: string) => void;
  onZoomTo: (nodeId: string) => void;
}

/**
 * The single app-level popup shared by every rem editor. One instance rather
 * than one per bullet: there is only ever one menu on screen, and each editor
 * routes its arrow/Enter keys here through the menu store.
 */
export function EditorMenus({ onEmbed, onZoomTo }: EditorMenusProps) {
  const { activeEditor, activeNodeId } = useActiveEditor();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [matches, setMatches] = useState<OutlinerNode[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const dismissedAt = useRef<number | null>(null);
  const triggerRef = useRef<Trigger | null>(null);

  // Track the trigger under the cursor on every transaction.
  useEffect(() => {
    if (!activeEditor) {
      setTrigger(null);
      return;
    }

    function sync() {
      const editor = activeEditor;
      if (!editor || editor.isDestroyed) return;
      const next = detectTrigger(editor);
      if (!next) {
        dismissedAt.current = null;
        triggerRef.current = null;
        setTrigger(null);
        setCoords(null);
        return;
      }
      if (dismissedAt.current === next.from) {
        triggerRef.current = null;
        setTrigger(null);
        return;
      }
      const box = editor.view.coordsAtPos(next.to);
      setCoords({ left: box.left, top: box.top, bottom: box.bottom });

      // Compare against a ref rather than inside a state updater: React may
      // call an updater more than once, and resetting the highlighted row from
      // inside one is a side effect that can get replayed or dropped.
      const prev = triggerRef.current;
      const changed =
        !prev || prev.kind !== next.kind || prev.from !== next.from || prev.query !== next.query;
      if (changed) {
        triggerRef.current = next;
        setTrigger(next);
        setActiveIndex(0);
      }
    }

    sync();
    activeEditor.on('transaction', sync);
    activeEditor.on('focus', sync);
    return () => {
      activeEditor.off('transaction', sync);
      activeEditor.off('focus', sync);
    };
  }, [activeEditor]);

  // Live search for the [[ link picker.
  useEffect(() => {
    if (trigger?.kind !== 'wiki') {
      setMatches([]);
      return;
    }
    let cancelled = false;
    searchNodesByTitle(trigger.query).then((results) => {
      if (!cancelled) setMatches(results);
    });
    return () => {
      cancelled = true;
    };
  }, [trigger?.kind, trigger?.query]);

  const close = useCallback(() => {
    dismissedAt.current = trigger?.from ?? null;
    triggerRef.current = null;
    setTrigger(null);
  }, [trigger?.from]);

  const items: MenuItem[] = useMemo(() => {
    if (!trigger || !activeEditor) return [];

    const range = { from: trigger.from, to: trigger.to };

    if (trigger.kind === 'slash') {
      return matchCommands(trigger.query).map((cmd) => ({
        id: cmd.id,
        label: cmd.label,
        hint: cmd.hint,
        icon: cmd.icon,
        run: () => {
          activeEditor.chain().focus().deleteRange(range).run();
          cmd.run(activeEditor, { nodeId: activeNodeId, onEmbed });
        },
      }));
    }

    const insertLink = (title: string) => {
      activeEditor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: 'wikiLink', attrs: { title } })
        .run();
    };

    const results: MenuItem[] = matches.map((node) => ({
      id: node.id,
      label: node.plainText || 'Untitled',
      hint: node.isPage ? 'Page' : 'Rem',
      icon: node.isPage ? '▤' : '•',
      run: () => insertLink(node.plainText.trim() || 'Untitled'),
    }));

    const typed = trigger.query.trim();
    const hasExact = matches.some((n) => n.plainText.trim().toLowerCase() === typed.toLowerCase());
    if (typed && !hasExact) {
      results.push({
        id: '__create__',
        label: `Create "${typed}"`,
        hint: 'New page',
        icon: '+',
        run: async () => {
          const page = await createPage(typed);
          insertLink(typed);
          onZoomTo(page.id);
        },
      });
    }

    return results;
  }, [trigger, activeEditor, activeNodeId, matches, onEmbed, onZoomTo]);

  const select = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return;
      dismissedAt.current = null;
      triggerRef.current = null;
      setTrigger(null);
      void item.run();
    },
    [items]
  );

  // Claim the arrow keys / Enter / Escape from the focused rem editor while open.
  useEffect(() => {
    if (!trigger || items.length === 0) {
      setMenuKeyHandler(null);
      return;
    }
    setMenuKeyHandler((event) => {
      if (event.key === 'ArrowDown') {
        setActiveIndex((i) => (i + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        select(activeIndex);
        return true;
      }
      if (event.key === 'Escape') {
        close();
        return true;
      }
      return false;
    });
    return () => setMenuKeyHandler(null);
  }, [trigger, items, activeIndex, select, close]);

  if (!trigger || !coords || items.length === 0) return null;

  const maxHeight = 320;
  const spaceBelow = window.innerHeight - coords.bottom;
  const flip = spaceBelow < maxHeight + 24;

  return (
    <div
      className="editor-menu"
      style={{
        left: Math.min(coords.left, window.innerWidth - 300),
        top: flip ? undefined : coords.bottom + 8,
        bottom: flip ? window.innerHeight - coords.top + 8 : undefined,
      }}
    >
      <div className="editor-menu-label">
        {trigger.kind === 'slash' ? 'Insert' : 'Link to rem'}
      </div>
      <ul className="editor-menu-list">
        {items.map((item, i) => (
          <li key={item.id}>
            <button
              type="button"
              className={`editor-menu-item ${i === activeIndex ? 'active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                select(i);
              }}
            >
              <span className="editor-menu-icon">{item.icon}</span>
              <span className="editor-menu-text">
                <span className="editor-menu-title">{item.label}</span>
                {item.hint && <span className="editor-menu-hint">{item.hint}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
