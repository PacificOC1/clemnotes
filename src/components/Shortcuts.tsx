/**
 * Every shortcut, in one place.
 *
 * Alt+arrow, ⌘\, the grading number keys, the middle-band drop zone and now
 * the selection modifiers are all invisible unless someone tells you. In six
 * months that someone is not going to be around.
 */

interface Shortcut {
  keys: string[];
  what: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

const GROUPS: Group[] = [
  {
    title: 'Everywhere',
    items: [
      { keys: ['⌘', 'K'], what: 'Search rems and pages' },
      { keys: ['⌘', '\\'], what: 'Show or hide the sidebar' },
      { keys: ['⌘', '/'], what: 'This list' },
      { keys: ['⌘', 'Z'], what: 'Undo — typing first, then the last structural change' },
      { keys: ['Esc'], what: 'Close a menu, or clear the selection' },
    ],
  },
  {
    title: 'Writing',
    items: [
      { keys: ['Enter'], what: 'New rem below' },
      { keys: ['Tab'], what: 'Indent' },
      { keys: ['Shift', 'Tab'], what: 'Outdent' },
      { keys: ['Alt', '↑ ↓'], what: 'Move a rem among its siblings' },
      { keys: ['Backspace'], what: 'At the start of a rem, merge into the one above' },
      { keys: ['/'], what: 'Command menu' },
      { keys: ['[', '['], what: 'Link to another rem' },
      { keys: ['[[x', '|', 'y]]'], what: 'Link to x, but read as y' },
      { keys: ['::'], what: 'Turn a rem into a flashcard' },
      { keys: ['{{', '}}'], what: 'Wrap words to make a fill-in-the-blank' },
    ],
  },
  {
    title: 'Selecting',
    items: [
      { keys: ['⌘', 'click'], what: "Add or remove a rem, on its bullet" },
      { keys: ['Shift', 'click'], what: 'Extend the selection to that rem' },
      { keys: ['Tab'], what: 'Indent everything selected' },
      { keys: ['Shift', 'Tab'], what: 'Outdent everything selected' },
    ],
  },
  {
    title: 'Reviewing',
    items: [
      { keys: ['Space'], what: 'Show the answer' },
      { keys: ['1'], what: 'Again' },
      { keys: ['2'], what: 'Hard' },
      { keys: ['3'], what: 'Good' },
      { keys: ['4'], what: 'Easy' },
    ],
  },
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <div className="shortcuts-backdrop" onClick={onClose} role="presentation">
      <div
        className="shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h2>Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="shortcuts-groups">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={`${group.title}-${item.what}`}>
                    <dt>
                      {item.keys.map((key, i) => (
                        <kbd key={`${key}-${i}`}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{item.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <footer>On Windows and Linux, ⌘ is Ctrl.</footer>
      </div>
    </div>
  );
}
