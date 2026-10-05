import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Editor } from '@tiptap/react';
import {
  getAllPages,
  createPage,
  createPortalChild,
  getBreadcrumbPath,
  deleteNode,
  deleteNodes,
  ensureFirstChild,
  expandAncestors,
  flattenVisible,
  getNode,
  isSelfOrDescendant,
  indentNodes,
  outdentNodes,
} from './db/repository';
import { applyRowClick } from './db/selection';
import { copyRemsAsMarkdown } from './db/clipboard';
import { undoLast } from './db/undo';
import { getCardStats } from './db/cardRepository';
import { seedLatexTutorial } from './db/seedLatexTutorial';
import { openDailyNote } from './db/dailyNotes';
import { OutlinerNode } from './components/OutlinerNode';
import { BacklinksPanel } from './components/BacklinksPanel';
import { UnlinkedReferences } from './components/UnlinkedReferences';
import { Breadcrumbs } from './components/Breadcrumbs';
import { SearchOmnibar } from './components/SearchOmnibar';
import { FormattingBubble } from './components/FormattingBubble';
import { EditorMenus } from './components/EditorMenus';
import { SyncPanel } from './components/SyncPanel';
import { BackupPanel } from './components/BackupPanel';
import { PageSidebar } from './components/PageSidebar';
import { DictionaryEntryModal } from './components/DictionaryEntryModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SelectionBar } from './components/SelectionBar';
import { UndoToast } from './components/UndoToast';
import { Shortcuts } from './components/Shortcuts';
import { DailyNav } from './components/DailyNav';
import { VersionHistory } from './components/VersionHistory';
import { TemplatePicker } from './components/TemplatePicker';
import { TableOfContents } from './components/TableOfContents';
import { SplitPane } from './components/SplitPane';
import { onOpenPdfRequest } from './pdf/pdfEvents';
import { setFocusIntent } from './editor/focusIntent';
import { SidebarResizer } from './components/SidebarResizer';
import { countWords } from './db/outline';
import { NEXT_THEME, loadTheme, onThemeChange, setTheme, type ThemePreference } from './theme';
import { SelectionContext } from './context/SelectionContext';
import { NavigationContext } from './context/NavigationContext';
import { DictionaryProvider, useDictionary } from './context/DictionaryContext';
import { ActiveEditorContext } from './context/ActiveEditorContext';
import { useRoute } from './router/useRoute';
import type { AppTab, Route } from './router/route';
import { isSyncConfigured } from './sync/supabaseClient';
import { purgeLocalTombstones } from './db/tombstones';
import { logEvent } from './diagnostics';
import './App.css';

// The flashcard and dictionary tabs load on first visit (#63): most sessions
// are writing, and neither view is needed to write.
const ReviewView = lazy(() => import('./components/ReviewView').then((m) => ({ default: m.ReviewView })));
const DictionaryView = lazy(() => import('./components/DictionaryView').then((m) => ({ default: m.DictionaryView })));
const CoursesView = lazy(() => import('./components/CoursesView').then((m) => ({ default: m.CoursesView })));
// The PDF reader (#53) and pdf.js behind it load only when a PDF is opened.
const PdfPane = lazy(() => import('./components/PdfPane').then((m) => ({ default: m.PdfPane })));

const SIDEBAR_KEY = 'clemnotes:sidebar-open';
const SIDEBAR_WIDTH_KEY = 'clemnotes:sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 262;
const MIN_SIDEBAR_WIDTH = 190;
const MAX_SIDEBAR_WIDTH = 520;

function loadSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return raw >= MIN_SIDEBAR_WIDTH && raw <= MAX_SIDEBAR_WIDTH ? raw : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

interface WorkspaceProps {
  route: Route;
  navigate: (next: Route, options?: { replace?: boolean }) => void;
}

function Workspace({ route, navigate }: WorkspaceProps) {
  const pages = useLiveQuery(() => getAllPages(), []) ?? [];
  const stats = useLiveQuery(() => getCardStats(), []) ?? null;
  const { entries, activeTab, setActiveTab } = useDictionary();

  // The zoomed rem — a top-level page or any nested rem — comes from the URL,
  // so back, forward, reload and a shared link all mean the same thing.
  const viewNodeId = route.nodeId;
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  /** Closed, or open in one of its two scopes (⌘K everywhere, ⌘⇧F this page). */
  const [searchOpen, setSearchOpen] = useState<false | 'all' | 'page'>(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [templateAt, setTemplateAt] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  /** The rows on screen, in display order — what a shift-click range spans. */
  const visibleOrderRef = useRef<string[]>([]);
  const [embedTargetId, setEmbedTargetId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [theme, setThemeState] = useState<ThemePreference>(loadTheme);
  const [focusMode, setFocusMode] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const setActive = useCallback((editor: Editor | null, nodeId: string | null) => {
    setActiveEditor(editor);
    setActiveNodeId(nodeId);
  }, []);

  // #24: a notebook that doesn't sync drops its own deletions after 90 days.
  // (With sync on, the cloud decides during the daily reconcile.)
  useEffect(() => {
    if (isSyncConfigured) return;
    void purgeLocalTombstones().then((purged) => {
      if (purged > 0) logEvent('maintenance', 'Purged old deletions', { rows: purged });
    });
  }, []);

  const activeRootId = viewNodeId ?? pages[0]?.id ?? null;

  /**
   * #58: zooming replaces the part of the page that had focus — the bullet you
   * clicked is gone — which drops keyboard and screen-reader users on <body>,
   * at the top of the page. Put them on the new document instead, unless
   * something (the first bullet of a new page, say) has already taken focus.
   */
  const documentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body) documentRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeRootId]);
  const breadcrumbQueryRootRef = useRef<string | null>(activeRootId);
  useEffect(() => {
    breadcrumbQueryRootRef.current = activeRootId;
  }, [activeRootId]);
  // The result carries the id it was asked about. Without that, a result that
  // arrived for the *previous* rem looks like an answer about the current one —
  // and since the answer for "no rem at all" is an empty path, zooming into a
  // freshly created page read as "that rem does not exist" and bounced straight
  // back out again.
  const breadcrumbQuery = useLiveQuery(
    async () => ({
      forId: activeRootId,
      path: activeRootId ? await getBreadcrumbPath(activeRootId) : [],
    }),
    [activeRootId]
  );
  const breadcrumbPath = breadcrumbQuery?.forId === activeRootId ? breadcrumbQuery.path : [];

  // Live, so it counts as you type; tagged with the rem it counted for the
  // same reason as the breadcrumbs above.
  const wordQuery = useLiveQuery(
    async () => ({ forId: activeRootId, words: activeRootId ? await countWords(activeRootId) : 0 }),
    [activeRootId]
  );
  const wordCount = wordQuery?.forId === activeRootId ? wordQuery.words : undefined;

  useEffect(() => onThemeChange(setThemeState), []);

  // The second pane (#43) rides along in the URL; the main pane navigating
  // leaves it where it is.
  const splitId = route.tab === 'notes' ? (route.splitId ?? null) : null;
  const splitRef = useRef<string | null>(splitId);
  useEffect(() => {
    splitRef.current = splitId;
  }, [splitId]);

  // A PDF open beside the outline (#53) rides along the same way.
  const pdfRoute = route.tab === 'notes' ? (route.pdf ?? null) : null;
  const pdfRef = useRef(pdfRoute);
  useEffect(() => {
    pdfRef.current = pdfRoute;
  }, [pdfRoute]);

  const handleZoomTo = useCallback(
    (nodeId: string) => {
      setFocusedNodeId(null);
      navigate({
        tab: 'notes',
        nodeId,
        ...(splitRef.current ? { splitId: splitRef.current } : {}),
        ...(pdfRef.current ? { pdf: pdfRef.current } : {}),
      });
    },
    [navigate]
  );

  /** Open a rem beside the current document. */
  const openInSplit = useCallback(
    (nodeId: string) => {
      const main = route.nodeId ?? breadcrumbQueryRootRef.current;
      if (!main) {
        handleZoomTo(nodeId);
        return;
      }
      navigate({ tab: 'notes', nodeId: main, splitId: nodeId });
    },
    [navigate, route.nodeId, handleZoomTo]
  );

  const closeSplit = useCallback(() => {
    if (route.nodeId) navigate({ tab: 'notes', nodeId: route.nodeId });
  }, [navigate, route.nodeId]);

  // A PDF block, a page chip or a dropped file asks for a PDF: open it beside
  // whatever the main pane shows, in place of a second document.
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);
  useEffect(
    () =>
      onOpenPdfRequest((fileId, target) => {
        const current = routeRef.current;
        const main = current.nodeId ?? breadcrumbQueryRootRef.current;
        if (!main) return;
        if (current.pdf?.fileId === fileId && !target) return;
        navigate({ tab: 'notes', nodeId: main, pdf: { fileId, ...(target ? { page: target.page } : current.pdf?.fileId === fileId && current.pdf.page ? { page: current.pdf.page } : {}) } });
      }),
    [navigate]
  );

  const swapSplit = useCallback(() => {
    if (route.nodeId && splitId) navigate({ tab: 'notes', nodeId: splitId, splitId: route.nodeId });
  }, [navigate, route.nodeId, splitId]);

  /**
   * A link to a rem that has since been deleted — or that belongs to a
   * notebook this browser doesn't have — leaves the URL pointing at nothing.
   * `getBreadcrumbPath` comes back empty for a rem that isn't there, so drop
   * to the first page and *replace* the entry, because a route that was never
   * valid should not be somewhere `back` can return to.
   */
  useEffect(() => {
    if (!route.nodeId || breadcrumbQuery === undefined) return;
    if (breadcrumbQuery.forId !== route.nodeId) return;
    if (breadcrumbQuery.path.length === 0) {
      navigate({ tab: 'notes', nodeId: null }, { replace: true });
    }
  }, [route.nodeId, breadcrumbQuery, navigate]);

  /**
   * Find-in-page: show a rem where it sits rather than zooming into it —
   * unfold anything collapsed above it and put the cursor in it. A rem outside
   * the part of the page on screen is zoomed to instead.
   */
  const revealInPage = useCallback(
    async (nodeId: string) => {
      if (!activeRootId || !(await isSelfOrDescendant(nodeId, activeRootId)) || nodeId === activeRootId) {
        handleZoomTo(nodeId);
        return;
      }
      await expandAncestors(nodeId, activeRootId);
      setFocusedNodeId(null);
      requestAnimationFrame(() => setFocusedNodeId(nodeId));
    },
    [activeRootId, handleZoomTo]
  );

  /**
   * Show a rem from the PDF pane — a highlight clicked on the page, or a card
   * just made. In the page on screen if it is there; otherwise the main pane
   * moves to the rem it sits under, so it is seen in context.
   */
  const showRemFromPdf = useCallback(
    async (nodeId: string) => {
      const row = await getNode(nodeId);
      if (!row) return;
      if (activeRootId && nodeId !== activeRootId && (await isSelfOrDescendant(nodeId, activeRootId))) {
        await expandAncestors(nodeId, activeRootId);
        setFocusedNodeId(null);
        requestAnimationFrame(() => setFocusedNodeId(nodeId));
        return;
      }
      handleZoomTo(row.parentId ?? nodeId);
      window.setTimeout(() => setFocusedNodeId(nodeId), 200);
    },
    [activeRootId, handleZoomTo]
  );

  const handleEmbed = useCallback((nodeId: string) => setEmbedTargetId(nodeId), []);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, []);

  /**
   * Selecting a row. The visible order is read fresh on each click rather than
   * kept in state: it changes whenever anything is collapsed, moved or typed,
   * and a stale copy would silently select the wrong range.
   */
  const handleSelectRow = useCallback(
    async (nodeId: string, mode: 'toggle' | 'range') => {
      const order = activeRootId ? await flattenVisible(activeRootId) : [];
      visibleOrderRef.current = order;
      const next = applyRowClick(selected, anchorRef.current, nodeId, order, mode);
      anchorRef.current = next.anchor;
      setSelected(next.selected);
    },
    [activeRootId, selected]
  );

  const selectionValue = useMemo(
    () => ({
      selected,
      onSelectRow: (nodeId: string, mode: 'toggle' | 'range') => void handleSelectRow(nodeId, mode),
      clear: clearSelection,
    }),
    [selected, handleSelectRow, clearSelection]
  );

  /**
   * The keydown listener is registered once, so it cannot close over state.
   * These refs are what it reads instead.
   */
  const selectedRef = useRef<ReadonlySet<string>>(selected);
  /** The focused editor, for deciding who owns ⌘Z. */
  const activeEditorRef = useRef<Editor | null>(null);
  const indentSelectionRef = useRef<() => Promise<void>>(async () => {});
  const openTodayRef = useRef<() => void>(() => {});
  const outdentSelectionRef = useRef<() => Promise<void>>(async () => {});

  /** Run a bulk operation over the selection, then let it go. */
  const runOnSelection = useCallback(
    async (op: (ids: string[], order: string[]) => Promise<unknown>) => {
      const ids = [...selected];
      if (ids.length === 0) return;
      const order = activeRootId ? await flattenVisible(activeRootId) : visibleOrderRef.current;
      await op(ids, order);
      clearSelection();
    },
    [selected, activeRootId, clearSelection]
  );

  const indentSelection = useCallback(() => runOnSelection(indentNodes), [runOnSelection]);
  const outdentSelection = useCallback(() => runOnSelection(outdentNodes), [runOnSelection]);
  const deleteSelection = useCallback(() => runOnSelection(deleteNodes), [runOnSelection]);
  const copySelection = useCallback(() => copyRemsAsMarkdown([...selected]), [selected]);

  useEffect(() => {
    activeEditorRef.current = activeEditor;
  }, [activeEditor]);

  const openToday = useCallback(() => {
    void openDailyNote().then(async (id) => {
      handleZoomTo(id);
      // Straight into the first bullet: you opened today to write something.
      const first = await ensureFirstChild(id);
      if (first) setFocusedNodeId(first.id);
    });
  }, [handleZoomTo]);

  useEffect(() => {
    openTodayRef.current = openToday;
  }, [openToday]);

  useEffect(() => {
    selectedRef.current = selected;
    indentSelectionRef.current = indentSelection;
    outdentSelectionRef.current = outdentSelection;
  }, [selected, indentSelection, outdentSelection]);

  // A selection belongs to the document you were looking at; carrying it to
  // another one would act on rows that are no longer on screen.
  useEffect(() => {
    clearSelection();
  }, [activeRootId, clearSelection]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_KEY);
      if (stored !== null) setSidebarOpen(stored === 'true');
    } catch {
      // Private windows and blocked site data both throw here; the default is fine.
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      // Non-fatal: the sidebar just won't remember its state next time.
    }
  }, [sidebarOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen('all');
      }
      if (meta && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen('page');
      }
      if (meta && e.key === '\\') {
        e.preventDefault();
        setSidebarOpen((open) => !open);
      }
      // Alt+Shift+D — today's daily note. Matched on `code`, because on a Mac
      // Alt+Shift turns the key into a different character ("Î").
      if (e.altKey && e.shiftKey && !meta && e.code === 'KeyF') {
        e.preventDefault();
        setFocusMode((v) => !v);
      }
      if (e.altKey && e.shiftKey && !meta && e.code === 'KeyD') {
        e.preventDefault();
        openTodayRef.current();
      }
      if (meta && e.key === '/') {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
      }
      /**
       * ⌘Z belongs to the focused editor while it still has typing to undo —
       * that is the more common intent and the one you would be surprised to
       * lose. Once its history is spent, the structural stack takes over.
       */
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        const editor = activeEditorRef.current;
        if (!editor || !editor.can().undo()) {
          e.preventDefault();
          void undoLast();
        }
      }
      if (e.key === 'Escape') {
        setShortcutsOpen(false);
        setSelected((current) => (current.size === 0 ? current : new Set()));
      }
      // Tab and Shift+Tab already indent the focused rem; with a selection
      // they act on all of it instead, and the editor must not also handle it.
      if (e.key === 'Tab' && selectedRef.current.size > 0) {
        e.preventDefault();
        void (e.shiftKey ? outdentSelectionRef.current() : indentSelectionRef.current());
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function handleNewPage() {
    const page = await createPage('Untitled');
    handleZoomTo(page.id);
    setFocusedNodeId(page.id);
  }

  /**
   * Install the built-in LaTeX course, or just open it when it's already
   * there — re-adding it would leave two copies with two sets of cards, which
   * is never what the button meant. Deleting the page and pressing it again
   * does give you a fresh copy, since a soft-deleted page stops counting.
   */
  async function handleAddLatexCourse() {
    const result = await seedLatexTutorial();
    handleZoomTo(result.pageId);
  }

  async function handleDeletePage(pageId: string, event: React.MouseEvent) {
    event.stopPropagation();
    const page = pages.find((p) => p.id === pageId);
    const label = page?.plainText.trim() || 'Untitled';
    if (!window.confirm(`Delete "${label}" and everything in it?`)) return;

    const viewingThisPage = breadcrumbPath[0]?.id === pageId || activeRootId === pageId;
    await deleteNode(pageId);

    if (viewingThisPage) {
      const remaining = pages.filter((p) => p.id !== pageId);
      setFocusedNodeId(null);
      // Replace, not push: going "back" to a page you just deleted is not a
      // useful place to end up.
      navigate({ tab: 'notes', nodeId: remaining[0]?.id ?? null }, { replace: true });
    }
  }

  const dueCount = stats?.due ?? 0;
  const parentOfView = breadcrumbPath.length > 1 ? breadcrumbPath[breadcrumbPath.length - 2] : null;

  return (
    <NavigationContext.Provider value={{ onZoomTo: handleZoomTo, onOpenInSplit: openInSplit }}>
      <SelectionContext.Provider value={selectionValue}>
      <ActiveEditorContext.Provider value={{ activeEditor, activeNodeId, setActive }}>
        <div
          className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${focusMode ? 'focus-mode' : ''}`}
          style={{ '--sidebar-w': `${sidebarWidth}px` } as CSSProperties}
        >
          <aside className="sidebar">
            <div className="sidebar-head">
              <span className="sidebar-brand">Clemnotes</span>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setTheme(NEXT_THEME[theme])}
                title={`Theme: ${theme} — click for ${NEXT_THEME[theme]}`}
                aria-label={`Theme: ${theme}`}
              >
                {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSidebarOpen(false)}
                title="Hide sidebar  ⌘\"
                aria-label="Hide sidebar"
              >
                ⇤
              </button>
            </div>

            <div className="sidebar-nav">
              <button type="button" className="nav-item nav-search" onClick={() => setSearchOpen('all')}>
                <span className="nav-icon">⌕</span>
                <span className="nav-label">Search</span>
                <kbd>⌘K</kbd>
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'notes' ? 'active' : ''}`}
                onClick={() => setActiveTab('notes')}
              >
                <span className="nav-icon">▤</span>
                <span className="nav-label">Notes</span>
              </button>
              <button type="button" className="nav-item" onClick={openToday} title="Today's daily note  Alt+Shift+D">
                <span className="nav-icon">◷</span>
                <span className="nav-label">Today</span>
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'review' ? 'active' : ''}`}
                onClick={() => setActiveTab('review')}
              >
                <span className="nav-icon">🂠</span>
                <span className="nav-label">Flashcards</span>
                {dueCount > 0 && <span className="nav-badge nav-badge-due">{dueCount}</span>}
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'courses' ? 'active' : ''}`}
                onClick={() => setActiveTab('courses')}
              >
                <span className="nav-icon">⛰</span>
                <span className="nav-label">Courses</span>
              </button>
              <button
                type="button"
                className={`nav-item ${activeTab === 'dictionary' ? 'active' : ''}`}
                onClick={() => setActiveTab('dictionary')}
              >
                <span className="nav-icon">⌸</span>
                <span className="nav-label">Definitions</span>
                {entries.length > 0 && <span className="nav-badge">{entries.length}</span>}
              </button>
            </div>

            <PageSidebar
              pages={pages}
              activeNodeId={activeRootId}
              breadcrumbRootId={breadcrumbPath[0]?.id}
              onSelectPage={(pageId, beside) => (beside ? openInSplit(pageId) : handleZoomTo(pageId))}
              onDeletePage={handleDeletePage}
              onNewPage={handleNewPage}
              onAddLatexCourse={() => void handleAddLatexCourse()}
            />

            <SyncPanel />
            <BackupPanel />
          </aside>
          {/* Outside the sidebar, whose overflow would clip all but a sliver of it. */}
          {sidebarOpen && (
            <SidebarResizer
              width={sidebarWidth}
              min={MIN_SIDEBAR_WIDTH}
              max={MAX_SIDEBAR_WIDTH}
              defaultWidth={DEFAULT_SIDEBAR_WIDTH}
              onResize={setSidebarWidth}
              onCommit={(width) => {
                try {
                  localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
                } catch {
                  // Not remembered; still applied for this visit.
                }
              }}
            />
          )}

          <div className="main">
            <header className="topbar">
              {!sidebarOpen && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setSidebarOpen(true)}
                  title="Show sidebar  ⌘\"
                  aria-label="Show sidebar"
                >
                  ⇥
                </button>
              )}
              {activeTab === 'notes' && (
                <>
                  {parentOfView && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => handleZoomTo(parentOfView.id)}
                      title="Zoom out one level"
                      aria-label="Zoom out"
                    >
                      ↰
                    </button>
                  )}
                  <Breadcrumbs path={breadcrumbPath} onNavigate={handleZoomTo} />
                </>
              )}
              <div className="topbar-spacer" />
              {activeTab === 'notes' && activeRootId && (
                <>
                  {wordCount !== undefined && (
                    <span className="topbar-words" title="Words in this rem and everything under it">
                      {wordCount.toLocaleString()} word{wordCount === 1 ? '' : 's'}
                    </span>
                  )}
                  <div className="toc-anchor">
                    <button
                      type="button"
                      className={`icon-btn ${tocOpen ? 'active' : ''}`}
                      onClick={() => setTocOpen((v) => !v)}
                      title="Contents — the headings on this page"
                      aria-label="Contents"
                      aria-expanded={tocOpen}
                    >
                      ☰
                    </button>
                    {tocOpen && (
                      <TableOfContents
                        rootId={activeRootId}
                        onPick={(id) => {
                          setTocOpen(false);
                          void revealInPage(id);
                        }}
                        onClose={() => setTocOpen(false)}
                      />
                    )}
                  </div>
                  <button
                    type="button"
                    className={`icon-btn ${splitId || pdfRoute ? 'active' : ''}`}
                    onClick={() => (splitId || pdfRoute ? closeSplit() : openInSplit(activeRootId))}
                    title={splitId ? 'Close the second pane' : 'Split view — open a second document beside this one (or shift-click a page or link)'}
                    aria-label="Split view"
                    aria-pressed={Boolean(splitId || pdfRoute)}
                  >
                    ◫
                  </button>
                  <button
                    type="button"
                    className={`icon-btn ${focusMode ? 'active' : ''}`}
                    onClick={() => setFocusMode((v) => !v)}
                    title="Focus mode — dim everything but the rem you're writing  Alt+Shift+F"
                    aria-label="Focus mode"
                    aria-pressed={focusMode}
                  >
                    ◎
                  </button>
                </>
              )}
              {activeTab === 'notes' && activeRootId && (
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setHistoryFor(activeRootId)}
                  title="Version history of this rem"
                  aria-label="Version history"
                >
                  ⟲
                </button>
              )}
              <button type="button" className="ghost-btn" onClick={handleNewPage}>+ New page</button>
            </header>

            <div className={`panes ${splitId || pdfRoute ? 'is-split' : ''}`}>
            <main className="content">
              {/* Scoped to the document, so a bad rem leaves the sidebar, the
                  tabs and the URL working — something to walk away with. */}
              <ErrorBoundary
                key={`${activeTab}:${activeRootId ?? ''}`}
                onEscape={() => navigate({ tab: 'notes', nodeId: null }, { replace: true })}
              >
              {activeTab === 'notes' && (
                activeRootId ? (
                  <div
                    className="document"
                    ref={documentRef}
                    tabIndex={-1}
                    aria-label={breadcrumbPath[breadcrumbPath.length - 1]?.plainText.trim() || 'Untitled'}
                  >
                    {breadcrumbPath.length === 1 && breadcrumbPath[0]?.id === activeRootId && (
                      <DailyNav title={breadcrumbPath[0].plainText} onOpen={handleZoomTo} />
                    )}
                    <OutlinerNode
                      key={activeRootId}
                      nodeId={activeRootId}
                      depth={0}
                      onFocusRequest={setFocusedNodeId}
                      focusedNodeId={focusedNodeId}
                      onZoomTo={handleZoomTo}
                      isRoot
                    />
                    <BacklinksPanel nodeId={activeRootId} onZoomTo={handleZoomTo} />
                    {/* Not the bare id: the outline above already has that key, and two
                        siblings sharing one made React leave stale copies of the zoomed
                        rem's title on screen (seen zooming into a rem with no children). */}
                    <UnlinkedReferences key={`unlinked:${activeRootId}`} nodeId={activeRootId} onZoomTo={handleZoomTo} />
                  </div>
                ) : (
                  <div className="empty-state">
                    <h2>Nothing here yet</h2>
                    <p>Pages are just rems with no parent. Make one and start typing.</p>
                    <button type="button" className="primary-btn" onClick={handleNewPage}>
                      Create your first page
                    </button>
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() => void handleAddLatexCourse()}
                    >
                      Or add the LaTeX course
                    </button>
                  </div>
                )
              )}
              <Suspense fallback={<div className="view-loading">Loading…</div>}>
                {activeTab === 'review' && (
                  <ReviewView
                    onZoomTo={handleZoomTo}
                    scope={route.scope ?? null}
                    onScopeChange={(scope) =>
                      navigate({ tab: 'review', nodeId: null, ...(scope ? { scope } : {}) }, { replace: true })
                    }
                  />
                )}
                {activeTab === 'courses' && (
                  <CoursesView
                    courseId={route.courseId ?? null}
                    courseItem={route.courseItem ?? null}
                    onOpenCourse={(courseId, item) =>
                      navigate({ tab: 'courses', nodeId: null, ...(courseId ? { courseId } : {}), ...(courseId && item ? { courseItem: item } : {}) })
                    }
                    onStudy={(scope) => navigate({ tab: 'review', nodeId: null, scope })}
                    onZoomTo={handleZoomTo}
                  />
                )}
                {activeTab === 'dictionary' && <DictionaryView />}
              </Suspense>
              </ErrorBoundary>
            </main>
            {pdfRoute && route.nodeId && (
              <Suspense fallback={<section className="split-pane pdf-pane"><p className="pdf-status">Opening…</p></section>}>
              <PdfPane
                key={pdfRoute.fileId}
                fileId={pdfRoute.fileId}
                page={pdfRoute.page}
                fallbackParentId={activeRootId}
                onClose={closeSplit}
                onPageSeen={(page) => {
                  const current = routeRef.current;
                  if (current.nodeId && current.pdf) {
                    navigate({ tab: 'notes', nodeId: current.nodeId, pdf: { fileId: current.pdf.fileId, page } }, { replace: true });
                  }
                }}
                onShowRem={(nodeId) => void showRemFromPdf(nodeId)}
                onEditRem={(nodeId, cursor) => {
                  setFocusIntent(nodeId, cursor);
                  void showRemFromPdf(nodeId);
                }}
              />
              </Suspense>
            )}
            {splitId && !pdfRoute && (
              <SplitPane
                nodeId={splitId}
                onNavigate={openInSplit}
                onOpenInMain={handleZoomTo}
                onSwap={swapSplit}
                onClose={closeSplit}
              />
            )}
            </div>
          </div>

          {searchOpen && (
            <SearchOmnibar
              onClose={() => setSearchOpen(false)}
              onSelect={handleZoomTo}
              filters
              pageId={breadcrumbPath[0]?.id ?? activeRootId}
              initialScope={searchOpen}
              onReveal={(nodeId) => void revealInPage(nodeId)}
            />
          )}
          {embedTargetId && (
            <SearchOmnibar
              placeholder="Embed a page or rem..."
              onClose={() => setEmbedTargetId(null)}
              onSelect={(targetId) => {
                const parentId = embedTargetId;
                setEmbedTargetId(null);
                void createPortalChild(parentId, targetId).then((created) => {
                  if (!created) {
                    window.alert("A rem can't embed itself or anything it already sits inside.");
                  }
                });
              }}
            />
          )}
          <EditorMenus onEmbed={handleEmbed} onTemplate={setTemplateAt} onZoomTo={handleZoomTo} />
          {templateAt && (
            <TemplatePicker
              atId={templateAt}
              onClose={() => setTemplateAt(null)}
              onInserted={(firstId) => {
                if (firstId) setFocusedNodeId(firstId);
              }}
              onOpenPage={handleZoomTo}
            />
          )}
          <FormattingBubble />
          <DictionaryEntryModal />
          <SelectionBar
            count={selected.size}
            onIndent={indentSelection}
            onOutdent={outdentSelection}
            onCopy={copySelection}
            onDelete={deleteSelection}
            onClear={clearSelection}
          />
          <UndoToast />
          {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
          {historyFor && <VersionHistory nodeId={historyFor} onClose={() => setHistoryFor(null)} />}
        </div>
      </ActiveEditorContext.Provider>
      </SelectionContext.Provider>
    </NavigationContext.Provider>
  );
}

export default function App() {
  const { route, navigate } = useRoute();

  // Switching to Flashcards and back should return you to the rem you were
  // reading, not to the top of the first page. The URL for a non-notes tab
  // carries no rem, so the last one is remembered here instead.
  const lastNoteRef = useRef<string | null>(null);
  useEffect(() => {
    if (route.tab === 'notes') lastNoteRef.current = route.nodeId;
  }, [route.tab, route.nodeId]);

  const setActiveTab = useCallback(
    (tab: AppTab) => navigate({ tab, nodeId: tab === 'notes' ? lastNoteRef.current : null }),
    [navigate]
  );

  return (
    <DictionaryProvider activeTab={route.tab} setActiveTab={setActiveTab}>
      <Workspace route={route} navigate={navigate} />
    </DictionaryProvider>
  );
}
