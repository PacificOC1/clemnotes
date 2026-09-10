/**
 * Content for the built-in "LaTeX in Clemnotes" course.
 *
 * This file is pure data — `seedLatexTutorial.ts` turns it into rems. It is
 * kept separate so the course can be rewritten without touching the seeding
 * mechanics (and so the mechanics stay readable next to a 100-item outline).
 *
 * ## The little markup used in `text`
 *
 * | Written    | Becomes                                                    |
 * |------------|------------------------------------------------------------|
 * | `` `x` ``  | inline code — raw source, shown but not rendered            |
 * | `$x$`      | a rendered math node, exactly as typing `$x$` would         |
 * | `%x%`      | shorthand for code + " → " + math, the workhorse of the file |
 * | `~x~`      | a cloze blank, numbered in document order                   |
 * | ` :: `     | nothing special here — but the rem becomes a two-sided card  |
 *
 * Cloze is written `~…~` rather than `{{…}}` on purpose: the blanks in this
 * course are usually LaTeX source, which is full of braces, and a brace-
 * delimited marker cannot hold them.
 *
 * Three rules the content has to respect, the first two inherited from the app:
 *
 * 1. A rem containing a cloze is a *cloze* rem — `cardRepository` prefers cloze
 *    over `::`, so a rem with both silently loses the split. Never mix them.
 *    `assertCourseIsValid()` in the seeder enforces this.
 * 2. `%…%` and `$…$` must hold valid KaTeX. A typo ships as red error text in
 *    the user's notes rather than failing here.
 * 3. `%`, `` ` `` and `~` are markup: don't use them as literal characters.
 *
 * Backslashes are doubled because these are ordinary quoted strings: LaTeX
 * `\frac` is written `\\frac`, and a LaTeX row break `\\` is `\\\\`.
 */

export interface SeedRem {
  /** Row text in the markup described above. */
  text: string;
  /** Render this rem as a heading of the given level instead of a paragraph. */
  heading?: 1 | 2 | 3 | 4 | 5 | 6;
  /** For a `::` rem — also generate the reverse card. */
  both?: boolean;
  /** Start this rem collapsed in the outline. */
  collapsed?: boolean;
  children?: SeedRem[];
}

export const LATEX_COURSE_TITLE = 'LaTeX in Clemnotes';

export const LATEX_COURSE: SeedRem[] = [
  {
    text:
      'A course on writing maths in these notes. Work top to bottom, or collapse a section and come back to it. ' +
      'Every rem with a card badge is already scheduled — open Flashcards when you want to test yourself.',
  },
  {
    text:
      'Everything below renders with KaTeX, which covers the maths half of LaTeX. Document commands — packages, ' +
      '`\\newcommand`, environments like `figure` — are not part of it.',
  },

  // ---------------------------------------------------------------------------
  {
    text: '1 · How maths works here',
    heading: 3,
    children: [
      { text: 'Type a dollar sign, the LaTeX, then a closing dollar sign. The instant the second one lands it becomes a formula: %x^2 + y^2 = z^2%' },
      { text: 'The `/math` command is only a shortcut for the opening `$`. You still type the LaTeX and close it yourself.' },
      { text: 'Click any rendered formula to reopen its source in a prompt box, edit it, and press OK.' },
      { text: 'A formula counts as one character. One Backspace beside it removes the whole thing, not the last symbol.' },
      { text: 'Broken LaTeX renders as red text in place instead of breaking the rem. Compare $\\frac{a}{b}$ with what a mistyped `\\fra{a}{b}` would leave you.' },
      { text: 'There is no display mode. Everything is inline, and `$$…$$` does not do what it does elsewhere — section 6 has the way around that.' },
      { text: 'A formula cannot contain a `$`. The rule stops at the first closing dollar it finds.' },
      { text: 'Empty delimiters do nothing at all — `$$` on its own stays as two literal dollar signs.' },
      { text: 'Formulas survive into review, so a card front or back can be as mathematical as you like.' },
      { text: 'Search matches the LaTeX source rather than the rendered output. Searching for `frac` finds every fraction you have written.' },
      { text: 'What wraps text into a rendered formula? :: A pair of single dollar signs — the closing one is what triggers it.', both: true },
      { text: 'How do you edit a formula you already made? :: Click it. A prompt opens with the raw LaTeX.' },
      { text: 'What does a single Backspace next to a formula delete? :: All of it. A formula is one atom.' },
      { text: 'Invalid LaTeX shows up as ~red error text~ in the rem rather than ~breaking the note~.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '2 · Superscripts and subscripts',
    heading: 3,
    children: [
      { text: '`^` raises, `_` lowers. Each takes exactly one character unless you group with braces.' },
      { text: 'One character needs no braces: %x^2% and %a_i%' },
      { text: 'More than one does: %x^{10}% — without them `x^10` gives you $x^10$, which is almost never what you meant.' },
      { text: 'Both at once, in either order: %x_i^2%' },
      { text: 'They nest as deep as you like: %e^{-x^2}%' },
      { text: 'Braces group without printing anything, so an empty one makes a leading superscript: %{}^{14}\\text{C}%' },
      { text: 'Primes have their own shorthand: %f\'(x)% and %f\'\'(x)%' },
      { text: 'Raise and lower a character in LaTeX :: `^` raises, `_` lowers.', both: true },
      { text: '`^` and `_` apply to ~exactly one character~, so anything longer has to be wrapped in ~braces~.' },
      { text: 'Why does `x^10` render as $x^10$? :: `^` grabs only the 1 and the 0 lands beside it. Write `x^{10}`.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '3 · Fractions and roots',
    heading: 3,
    children: [
      { text: 'The workhorse takes two arguments, top then bottom: %\\frac{a}{b}%' },
      { text: 'They nest, and the inner one shrinks: %\\frac{1}{1 + \\frac{1}{x}}%' },
      { text: 'Inline fractions are small by default. `\\dfrac` forces the big form: %\\dfrac{a}{b}%' },
      { text: '`\\tfrac` forces the small form even where the big one would be used: %\\tfrac{1}{2}%' },
      { text: 'Continued fractions keep their size all the way down: %\\cfrac{1}{2 + \\cfrac{1}{3}}%' },
      { text: 'Square roots take one argument: %\\sqrt{x + 1}%' },
      { text: 'Other roots take the degree in square brackets first: %\\sqrt[3]{x}%' },
      { text: 'Binomial coefficients are a fraction without the bar: %\\binom{n}{k}%' },
      { text: 'Write "a over b" :: `\\frac{a}{b}` → $\\frac{a}{b}$', both: true },
      { text: 'Write a cube root of x :: `\\sqrt[3]{x}` → $\\sqrt[3]{x}$', both: true },
      { text: 'A fraction inline comes out small; ~\\dfrac~ forces the full-size version.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '4 · Greek letters',
    heading: 3,
    children: [
      { text: 'Lowercase is the command name: %\\alpha \\beta \\gamma \\delta \\epsilon \\zeta \\eta \\theta%' },
      { text: 'Continuing: %\\iota \\kappa \\lambda \\mu \\nu \\xi \\pi \\rho \\sigma \\tau%' },
      { text: 'And the rest: %\\upsilon \\phi \\chi \\psi \\omega%' },
      { text: 'Uppercase is the capitalised command: %\\Gamma \\Delta \\Theta \\Lambda \\Xi \\Pi \\Sigma \\Phi \\Psi \\Omega%' },
      { text: 'There is no `\\Alpha`. Greek capitals that look like Latin letters are typed as Latin letters — capital alpha is simply `A`.' },
      { text: 'Several letters have a second shape, prefixed `var`: %\\epsilon \\varepsilon%' },
      { text: 'The others worth knowing: %\\theta \\vartheta \\phi \\varphi \\rho \\varrho \\sigma \\varsigma%' },
      { text: 'The physics-flavoured phi most people mean is %\\varphi%, not `\\phi`.' },
      { text: 'Uppercase Greek in LaTeX :: Capitalise the command — `\\gamma` becomes `\\Gamma` → $\\Gamma$' },
      { text: 'Why is there no `\\Alpha` command? :: Capital alpha is identical to a Latin A, so you type `A`.' },
      { text: 'The curly alternative letter shapes are prefixed with ~var~, as in `\\varepsilon` and `\\varphi`.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '5 · Operators and relations',
    heading: 3,
    children: [
      { text: 'Arithmetic: %a \\times b \\quad a \\div b \\quad a \\cdot b \\quad a \\pm b \\quad a \\mp b%' },
      { text: 'Comparisons: %a \\leq b \\quad a \\geq b \\quad a \\neq b \\quad a \\approx b \\quad a \\equiv b%' },
      { text: 'More of them: %a \\ll b \\quad a \\gg b \\quad a \\sim b \\quad a \\propto b%' },
      { text: 'Sets: %x \\in A \\quad x \\notin A \\quad A \\subset B \\quad A \\subseteq B%' },
      { text: 'Set operations: %A \\cup B \\quad A \\cap B \\quad A \\setminus B \\quad \\emptyset%' },
      { text: 'Arrows: %a \\to b \\quad a \\mapsto b \\quad a \\Rightarrow b \\quad a \\iff b%' },
      { text: 'Logic: %\\forall x \\quad \\exists y \\quad \\neg p \\quad p \\land q \\quad p \\lor q%' },
      { text: 'Odds and ends: %\\infty \\quad \\partial \\quad \\nabla \\quad \\ldots \\quad \\cdots%' },
      { text: 'Less than or equal to :: `\\leq` → $\\leq$', both: true },
      { text: 'Not equal to :: `\\neq` → $\\neq$', both: true },
      { text: '"Is an element of" is ~\\in~ and "is a subset of" is ~\\subset~.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '6 · Sums, integrals and the display-mode trick',
    heading: 3,
    children: [
      { text: 'Limits ride on `_` and `^`: %\\sum_{i=1}^{n} i%' },
      { text: 'Inline, they sit to the side to keep the line height sane. `\\limits` overrides that: %\\sum\\limits_{i=1}^{n} i%' },
      { text: 'Better still, `\\displaystyle` switches the whole formula to the big layout. This is how you get display maths in a tool with no display mode: %\\displaystyle\\sum_{i=1}^{n} i%' },
      { text: 'Products work identically: %\\displaystyle\\prod_{i=1}^{n} x_i%' },
      { text: 'Integrals: %\\int_a^b f(x)\\,dx% and %\\displaystyle\\int_0^\\infty e^{-x}\\,dx%' },
      { text: 'Multiple and closed integrals: %\\iint_D f \\quad \\iiint_V f \\quad \\oint_C f%' },
      { text: 'Limits of sequences and functions: %\\lim_{x \\to 0} \\frac{\\sin x}{x}% and %\\displaystyle\\lim_{n \\to \\infty} a_n%' },
      { text: 'Big set operators: %\\bigcup_{i=1}^{n} A_i \\quad \\bigcap_{i=1}^{n} A_i%' },
      { text: 'Stack two conditions under an operator with `\\substack`: %\\displaystyle\\sum_{\\substack{i=1 \\\\ i \\neq j}}^{n} a_i%' },
      { text: 'A sum from i=1 to n :: `\\sum_{i=1}^{n}` → $\\sum_{i=1}^{n}$', both: true },
      { text: 'How do you get full-size display maths when the app has no display mode? :: Start the formula with `\\displaystyle`.' },
      { text: 'To push limits above and below one operator, append ~\\limits~ to it; to switch a whole formula to the big layout, start it with ~\\displaystyle~.' },
      { text: 'A definite integral from a to b :: `\\int_a^b f(x)\\,dx` → $\\int_a^b f(x)\\,dx$' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '7 · Function names and words inside maths',
    heading: 3,
    children: [
      { text: 'Letters in maths mode are italic because they are variables. `sin x` therefore reads as s·i·n·x and renders as $sin x$ — wrong.' },
      { text: 'Named functions have upright commands: %\\sin x \\quad \\cos x \\quad \\tan x \\quad \\log x \\quad \\ln x%' },
      { text: 'More of them: %\\exp x \\quad \\min \\quad \\max \\quad \\gcd \\quad \\det \\quad \\dim \\quad \\arg%' },
      { text: 'They take limits like any operator: %\\max_{x \\in A} f(x)%' },
      { text: 'For a name with no built-in command, use `\\operatorname`: %\\operatorname{sgn}(x)%' },
      { text: 'For actual prose inside a formula, `\\text` keeps the spaces and the upright type: %x > 0 \\text{ if and only if } x = |x|%' },
      { text: 'Modular arithmetic has two forms: %a \\bmod n% and %a \\equiv b \\pmod n%' },
      { text: 'Why write `\\sin x` rather than `sin x`? :: Bare letters are italic variables, so `sin x` renders as four letters multiplied together.' },
      { text: 'Typeset a function name that has no command of its own :: `\\operatorname{name}`' },
      { text: 'Ordinary words inside a formula belong in ~\\text{…}~, which preserves both spaces and upright type.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '8 · Brackets that grow',
    heading: 3,
    children: [
      { text: 'Plain brackets stay one size, which looks wrong around tall content: $(\\frac{a}{b})$' },
      { text: '`\\left` and `\\right` make them fit: %\\left(\\frac{a}{b}\\right)%' },
      { text: 'They work on every bracket type: %\\left[\\frac{a}{b}\\right] \\quad \\left|\\frac{a}{b}\\right|%' },
      { text: 'Curly braces have to be escaped, since bare ones group instead of printing: %\\left\\{\\frac{a}{b}\\right\\}%' },
      { text: 'Every `\\left` needs a `\\right`. Use `\\right.` for an invisible one: %\\left.\\frac{dy}{dx}\\right|_{x=0}%' },
      { text: 'Other pairs: %\\langle x, y \\rangle \\quad \\lceil x \\rceil \\quad \\lfloor x \\rfloor%' },
      { text: 'Norms use a doubled bar: %\\left\\|x\\right\\|%' },
      { text: 'For a fixed size rather than an automatic one: %\\bigl( x \\bigr) \\quad \\Bigl( x \\Bigr) \\quad \\biggl( x \\biggr)%' },
      { text: 'Make a bracket grow to fit its contents :: Put `\\left` before it and `\\right` before the closing one.' },
      { text: 'Why does a curly bracket need `\\left\\{` rather than `\\left{`? :: A bare brace groups instead of printing, so it has to be escaped.' },
      { text: 'An unmatched `\\left` is an error. When you want only one visible bracket, close it with ~\\right.~ — a right delimiter that prints nothing.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '9 · Matrices, cases and aligned rows',
    heading: 3,
    children: [
      { text: 'Inside an environment, `&` separates columns and `\\\\` starts a new row.' },
      { text: 'Bare, with no brackets: %\\begin{matrix} a & b \\\\ c & d \\end{matrix}%' },
      { text: 'Round brackets, the common one: %\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}%' },
      { text: 'Square brackets: %\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}%' },
      { text: 'Single bars for a determinant: %\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}%' },
      { text: 'Piecewise definitions get their own environment: %f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\leq 0 \\end{cases}%' },
      { text: 'For several lines aligned on a symbol, put `&` immediately before the thing to line up: %\\begin{aligned} a &= b + c \\\\ &= d \\end{aligned}%' },
      { text: 'Ellipses for the general case: %\\begin{pmatrix} a_{11} & \\cdots & a_{1n} \\\\ \\vdots & \\ddots & \\vdots \\\\ a_{m1} & \\cdots & a_{mn} \\end{pmatrix}%' },
      { text: 'Separate matrix columns and rows :: `&` between columns, `\\\\` between rows.', both: true },
      { text: 'Round-bracket and square-bracket matrix environments :: `pmatrix` and `bmatrix`' },
      { text: 'A piecewise-defined function uses the ~cases~ environment, and multi-line working uses ~aligned~.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '10 · Hats, bars and braces',
    heading: 3,
    children: [
      { text: 'One character at a time: %\\hat{x} \\quad \\bar{x} \\quad \\vec{x} \\quad \\dot{x} \\quad \\ddot{x} \\quad \\tilde{x}%' },
      { text: 'The wide versions stretch over a whole expression: %\\widehat{xyz} \\quad \\overline{xyz} \\quad \\overrightarrow{AB}%' },
      { text: 'A bar over an expression is how you write a conjugate or a mean: %\\overline{z} \\quad \\bar{x} = \\frac{1}{n}\\sum x_i%' },
      { text: 'Braces annotate a group from underneath: %\\underbrace{a + b + c}_{n \\text{ terms}}%' },
      { text: 'And from above: %\\overbrace{x + \\cdots + x}^{k}%' },
      { text: 'Stack anything over anything: %\\overset{?}{=} \\quad \\underset{n \\to \\infty}{\\lim}%' },
      { text: 'A hat over one letter, and over a whole expression :: `\\hat{x}` → $\\hat{x}$ and `\\widehat{xyz}` → $\\widehat{xyz}$' },
      { text: 'Label a group of terms from underneath with ~\\underbrace~, attaching the label as a ~subscript~ after it.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '11 · Spacing',
    heading: 3,
    children: [
      { text: 'Spaces you type are ignored. `a b` and `ab` both render as $a b$ — spacing comes from commands instead.' },
      { text: 'From thin to wide: %a\\,b \\quad a\\;b \\quad a\\quad b \\quad a\\qquad b%' },
      { text: '`\\!` is a negative space, pulling things together: %\\int\\!\\!\\int f%' },
      { text: 'The thin space before a differential is the convention worth keeping: %\\int f(x)\\,dx%' },
      { text: '`\\phantom` reserves the width of something invisible, which is how you line two formulas up by hand: %a + \\phantom{bbb} + c%' },
      { text: 'Why does typing extra spaces inside a formula change nothing? :: Maths mode ignores literal whitespace and spaces by command instead.' },
      { text: 'The conventional thin space before `dx` in an integral is ~\\,~.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '12 · Fonts and colour',
    heading: 3,
    children: [
      { text: 'Blackboard bold for number sets: %\\mathbb{R} \\quad \\mathbb{N} \\quad \\mathbb{Z} \\quad \\mathbb{Q} \\quad \\mathbb{C}%' },
      { text: 'Script, for transforms and families: %\\mathcal{L} \\quad \\mathcal{F} \\quad \\mathcal{O}%' },
      { text: 'Fraktur, mostly for algebras and ideals: %\\mathfrak{g} \\quad \\mathfrak{p}%' },
      { text: 'Upright roman, for a label that is not a variable: %\\mathrm{d}x \\quad \\mathrm{const}%' },
      { text: 'Bold, including bold Greek: %\\mathbf{v} \\quad \\boldsymbol{\\alpha}%' },
      { text: 'Colour one piece: %\\textcolor{red}{x} + y%' },
      { text: 'Or everything from a point onward: %\\color{blue} x + y%' },
      { text: 'The real numbers, typeset properly :: `\\mathbb{R}` → $\\mathbb{R}$', both: true },
      { text: 'Bold a Greek letter with ~\\boldsymbol~, because ~\\mathbf~ leaves Greek unchanged.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '13 · When it goes wrong',
    heading: 3,
    children: [
      { text: 'Red text means KaTeX could not parse it. Click the formula and the prompt shows you the source that failed.' },
      { text: 'Most common cause by far — a missing brace. `\\frac{a}{b` leaves a group open.' },
      { text: 'Second — a command KaTeX does not implement. It covers maths, not the whole of LaTeX.' },
      { text: 'Third — an unmatched `\\left`. Every one needs a `\\right`, even an invisible `\\right.`' },
      { text: 'A `$` cannot appear inside a formula at all. For a literal dollar sign in ordinary text, type it and leave it unpaired.' },
      { text: 'To rescue a formula you can no longer read, click it and copy the source out of the prompt before you edit.' },
      { text: 'To remove one cleanly, put the caret just after it and press Backspace once.' },
      { text: 'There is no separate re-render step. Editing the source updates the display the moment you accept the prompt.' },
      { text: 'A formula renders in red. What are the three things to check? :: An unclosed brace, a command KaTeX does not support, an unmatched `\\left`.' },
      { text: 'You cannot see a formula\'s source without ~clicking it~, which reopens the LaTeX in a prompt.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '14 · Worth knowing by heart',
    heading: 3,
    collapsed: true,
    children: [
      { text: 'The quadratic formula $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$ is written ~\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}~.' },
      { text: 'Euler\'s identity $e^{i\\pi} + 1 = 0$ is written ~e^{i\\pi} + 1 = 0~.' },
      { text: 'The derivative $f\'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}$ takes its limit part from ~\\lim_{h \\to 0}~.' },
      { text: 'Bayes\' theorem $P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}$ uses ~\\mid~ for the conditioning bar.' },
      { text: 'The Gaussian integral $\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$ takes its infinite limits from ~\\int_{-\\infty}^{\\infty}~.' },
      { text: 'The sum $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ carries both its limits in ~\\sum_{i=1}^{n}~.' },
      { text: 'A 2×2 matrix in round brackets uses the ~pmatrix~ environment, with ~&~ between the columns.' },
    ],
  },

  // ---------------------------------------------------------------------------
  {
    text: '15 · Where to go next',
    heading: 3,
    children: [
      { text: 'The full list of what KaTeX supports lives at `katex.org/docs/supported.html` — worth opening whenever a command comes out red.' },
      { text: 'Anything on that page works here. Anything absent from it will not, however standard it is in LaTeX proper.' },
      { text: 'Delete this page whenever you are done with it. The cards go with it.' },
    ],
  },
];
