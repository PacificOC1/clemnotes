import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import {
  DICTIONARY_UPDATED_EVENT,
  getDictionaryEntries,
  navigateToDictionaryEntry,
} from '../db/dictionaryStore';
import type { DictionaryEntry } from '../db/schema';
import { compileMatcher } from './dictionaryMatcher';

const pluginKey = new PluginKey('dictionaryHighlight');

/**
 * One listener for the whole app, not one per editor. Each editor's plugin
 * used to re-broadcast a refresh on every dictionary change, and every editor
 * answered every broadcast — n editors rebuilt their decorations n times.
 */
if (typeof window !== 'undefined') {
  window.addEventListener(DICTIONARY_UPDATED_EVENT, () => {
    window.dispatchEvent(new CustomEvent('dictionary-highlight-refresh'));
  });
}

function buildDecorations(doc: ProseMirrorNode, entries: Map<string, DictionaryEntry>): DecorationSet {
  if (entries.size === 0) return DecorationSet.empty;

  const matcher = compileMatcher(entries);
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    if (node.marks.some((mark) => mark.type.name === 'code')) return;

    for (const match of matcher.find(node.text)) {
      decorations.push(
        Decoration.inline(pos + match.from, pos + match.to, {
          class: 'dict-word',
          'data-entry-id': match.entry.id,
          'data-definition': match.entry.definition,
          'data-word': match.entry.displayWord,
          title: 'Click to replace with definition · Shift+click to edit in Dictionary',
        })
      );
    }
  });

  return DecorationSet.create(doc, decorations);
}

let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'dict-tooltip';
    tooltipEl.hidden = true;
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

export function showTooltip(target: HTMLElement): void {
  const word = target.getAttribute('data-word') ?? '';
  const definition = target.getAttribute('data-definition') ?? '';
  const tooltip = ensureTooltip();

  tooltip.innerHTML = `<strong>${escapeHtml(word)}</strong><span>${escapeHtml(definition)}</span>`;
  tooltip.hidden = false;

  const rect = target.getBoundingClientRect();
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.top = `${rect.bottom + 6}px`;

  requestAnimationFrame(() => {
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = rect.left;
    if (left + tooltipRect.width > window.innerWidth - 8) {
      left = window.innerWidth - tooltipRect.width - 8;
    }
    tooltip.style.left = `${Math.max(8, left)}px`;
    if (rect.bottom + tooltipRect.height + 6 > window.innerHeight) {
      tooltip.style.top = `${rect.top - tooltipRect.height - 6}px`;
    }
  });
}

export function hideTooltip(): void {
  if (tooltipEl) tooltipEl.hidden = true;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findDictWordTarget(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;
  return target.closest('.dict-word');
}

export function replaceWordWithDefinition(view: EditorView, target: HTMLElement, definition: string): boolean {
  try {
    const from = view.posAtDOM(target, 0);
    const to = view.posAtDOM(target, target.childNodes.length);
    if (from < 0 || to <= from) return false;
    view.dispatch(view.state.tr.insertText(definition, from, to));
    return true;
  } catch {
    return false;
  }
}

export const DictionaryHighlight = Extension.create({
  name: 'dictionaryHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init(_, { doc }) {
            return buildDecorations(doc, getDictionaryEntries());
          },
          apply(tr, set, _oldState, newState) {
            if (tr.docChanged || tr.getMeta('dictionaryUpdated')) {
              return buildDecorations(newState.doc, getDictionaryEntries());
            }
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
          handleDOMEvents: {
            mouseover(_view, event) {
              const target = findDictWordTarget(event);
              if (target) {
                showTooltip(target);
              } else {
                hideTooltip();
              }
              return false;
            },
            mouseout(_view, event) {
              const related = event.relatedTarget;
              if (related instanceof HTMLElement && related.closest('.dict-word')) return false;
              hideTooltip();
              return false;
            },
            click(view, event) {
              const target = findDictWordTarget(event);
              if (!target) return false;
              event.preventDefault();
              hideTooltip();

              const entryId = target.getAttribute('data-entry-id');
              const definition = target.getAttribute('data-definition') ?? '';

              // Shift+click opens the dictionary entry editor.
              if (event.shiftKey && entryId) {
                navigateToDictionaryEntry(entryId);
                return true;
              }

              if (definition && replaceWordWithDefinition(view, target, definition)) {
                return true;
              }

              if (entryId) navigateToDictionaryEntry(entryId);
              return true;
            },
          },
        },
        view() {
          return {
            destroy() {
              hideTooltip();
            },
          };
        },
      }),
      new Plugin({
        key: new PluginKey('dictionaryHighlightRefresh'),
        view(editorView) {
          function refresh() {
            const tr = editorView.state.tr.setMeta('dictionaryUpdated', true);
            editorView.dispatch(tr);
          }
          window.addEventListener('dictionary-highlight-refresh', refresh);
          return {
            destroy() {
              window.removeEventListener('dictionary-highlight-refresh', refresh);
            },
          };
        },
      }),
    ];
  },
});
