import { DEFAULT_SETTINGS, type ReviewSettings } from '../srs/settings';

/**
 * The four numbers that decide what a session looks like.
 *
 * Daily limits exist for one reason: coming back after three weeks away and
 * being told 400 cards are waiting is the single most common way people give
 * up on spaced repetition — not the reviewing, the dread. A limit turns that
 * into a normal day's work and lets the backlog drain over a week.
 *
 * Every field accepts a blank value meaning "no limit", because a cap you
 * cannot switch off is its own kind of nuisance.
 */

interface LimitFieldProps {
  label: string;
  hint: string;
  value: number | null;
  onChange: (value: number | null) => void;
}

function LimitField({ label, hint, value, onChange }: LimitFieldProps) {
  return (
    <label className="session-field">
      <span className="session-field-label">{label}</span>
      <input
        type="number"
        min={0}
        step={1}
        value={value ?? ''}
        placeholder="none"
        onChange={(event) => {
          const next = event.target.value.trim();
          const parsed = Number(next);
          onChange(next === '' || !Number.isFinite(parsed) || parsed <= 0 ? null : Math.floor(parsed));
        }}
      />
      <span className="session-field-hint">{hint}</span>
    </label>
  );
}

interface SessionSettingsProps {
  settings: ReviewSettings;
  onChange: (settings: ReviewSettings) => void;
}

export function SessionSettings({ settings, onChange }: SessionSettingsProps) {
  const set = <K extends keyof ReviewSettings>(key: K, value: ReviewSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const isDefault =
    settings.newPerDay === DEFAULT_SETTINGS.newPerDay &&
    settings.reviewsPerDay === DEFAULT_SETTINGS.reviewsPerDay &&
    settings.leechThreshold === DEFAULT_SETTINGS.leechThreshold &&
    settings.burySiblings === DEFAULT_SETTINGS.burySiblings;

  return (
    <section className="session-settings">
      <div className="session-settings-head">
        <h2>Session settings</h2>
        {!isDefault && (
          <button type="button" onClick={() => onChange({ ...DEFAULT_SETTINGS })}>
            Reset to defaults
          </button>
        )}
      </div>

      <div className="session-fields">
        <LimitField
          label="New cards per day"
          hint="Leave blank for no limit"
          value={settings.newPerDay}
          onChange={(value) => set('newPerDay', value)}
        />
        <LimitField
          label="Reviews per day"
          hint="Counts cards you have seen before"
          value={settings.reviewsPerDay}
          onChange={(value) => set('reviewsPerDay', value)}
        />
        <LimitField
          label="Leech after"
          hint="Lapses before a card is flagged"
          value={settings.leechThreshold}
          onChange={(value) => set('leechThreshold', value)}
        />
      </div>

      <label className="session-toggle">
        <input
          type="checkbox"
          checked={settings.burySiblings}
          onChange={(event) => set('burySiblings', event.target.checked)}
        />
        <span>
          <strong>Show one card per rem in a session</strong>
          Three blanks in one sentence make three cards. Answering the first gives away the
          context for the other two, so the rest wait for another day.
        </span>
      </label>

      <p className="session-note">
        Limits apply to everything reviewed today, not just this session, and they are kept on
        this device rather than synced.
      </p>
    </section>
  );
}
