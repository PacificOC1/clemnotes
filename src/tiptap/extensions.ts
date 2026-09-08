import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TextStyle } from '@tiptap/extension-text-style';
import FontFamily from '@tiptap/extension-font-family';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { WikiLink } from './WikiLinkNode';
import { Math } from './MathNode';
import { Cloze } from './ClozeNode';
import { DictionaryHighlight } from './DictionaryHighlight';
import { FontSize } from './FontSize';

/** Everything shared between the editable rem rows and the read-only review renderer. */
const baseExtensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
  TableKit.configure({ table: { resizable: true, lastColumnResizable: true } }),
  TaskList,
  TaskItem.configure({ nested: false }),
  TextStyle,
  FontFamily,
  FontSize,
  Color,
  Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Underline,
  WikiLink,
  Math,
  Cloze,
];

/** Extensions for an editable rem row. */
export const rowExtensions = [
  ...baseExtensions,
  Placeholder.configure({
    placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : "Type '/' for commands"),
  }),
  DictionaryHighlight,
];

/**
 * Extensions for rendering a rem read-only (flashcard fronts and backs).
 * Deliberately drops the placeholder and the dictionary highlighter — during
 * a review you want to read the card, not be offered click-to-define on every
 * word in it.
 */
export const readOnlyExtensions = baseExtensions;
