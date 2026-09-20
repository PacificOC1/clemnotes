/**
 * KaTeX, fetched the first time a rem actually contains maths.
 *
 * KaTeX and its font files are the single biggest thing in the bundle, and a
 * static import put all of it — plus the stylesheet, plus the fonts the
 * stylesheet pulls in — on the critical path of every first paint, whether or
 * not the notebook contains a single formula. A dynamic import moves it into
 * its own chunk that most sessions never ask for.
 *
 * One module-level promise, so a page with forty formulas fetches it once.
 */

/** The default export, not the module namespace — that is what `katex.renderToString` lives on. */
type Katex = (typeof import('katex'))['default'];

let loading: Promise<Katex> | null = null;
let loaded: Katex | null = null;

/** The renderer, if it is already here. Lets the first paint skip a tick. */
export function katexIfLoaded(): Katex | null {
  return loaded;
}

export function loadKatex(): Promise<Katex> {
  if (!loading) {
    loading = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([mod]) => {
      loaded = mod.default;
      return mod.default;
    });
  }
  return loading;
}

/**
 * Render one expression, falling back to the source.
 *
 * `throwOnError: false` already makes KaTeX render bad input as a red error
 * rather than throwing, so the catch here is for the genuinely unexpected —
 * and showing the LaTeX you typed is a better failure than showing nothing.
 */
export function renderMath(katex: Katex, latex: string): string {
  try {
    return katex.renderToString(latex, { throwOnError: false, displayMode: false });
  } catch {
    return latex;
  }
}
