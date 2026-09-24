import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { applyTemplate, createTemplate, getTemplates, TEMPLATES_FOLDER_NAME } from '../db/templates';

interface Props {
  /** The rem `/template` was typed into. */
  atId: string;
  onClose: () => void;
  onInserted: (firstId: string | null) => void;
  onOpenPage: (pageId: string) => void;
}

/** `/template`: pick one of the pages in the Templates folder and stamp it in. */
export function TemplatePicker({ atId, onClose, onInserted, onOpenPage }: Props) {
  const templates = useLiveQuery(() => getTemplates(), []);
  const [active, setActive] = useState(0);

  async function choose(templateId: string) {
    const ids = await applyTemplate(templateId, atId);
    onClose();
    onInserted(ids[0] ?? null);
  }

  async function newTemplate() {
    const id = await createTemplate();
    onClose();
    onOpenPage(id);
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      const count = templates?.length ?? 0;
      if (count === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((i) => (i + 1) % count);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((i) => (i - 1 + count) % count);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = templates?.[active];
        if (chosen) void choose(chosen.id);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="omnibar-overlay" onClick={onClose}>
      <div className="omnibar template-picker" onClick={(e) => e.stopPropagation()}>
        <div className="template-head">Insert a template</div>
        {templates && templates.length > 0 ? (
          <ul className="omnibar-results">
            {templates.map((template, i) => (
              <li
                key={template.id}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  void choose(template.id);
                }}
              >
                {template.plainText.trim() || 'Untitled'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="template-empty">
            No templates yet. Any page in the <b>{TEMPLATES_FOLDER_NAME}</b> folder is one — write
            it like a normal page. <code>%date%</code>, <code>%time%</code> and{' '}
            <code>%weekday%</code> are filled in when it's inserted.
          </p>
        )}
        <div className="template-foot">
          <button type="button" className="link-btn" onClick={() => void newTemplate()}>
            + New template
          </button>
        </div>
      </div>
    </div>
  );
}
