import { backupFromTables, serializeBackup } from '../export/backup';
import { downloadText, timestampSlug } from '../export/download';
import type { PrepareOutcome } from '../db/migrationSafety';

type Failed = Extract<PrepareOutcome, { status: 'snapshot-failed' }>;

interface Props {
  outcome: Failed;
  onContinue: () => void;
}

/**
 * Shown instead of the app when an upgrade is due and the snapshot that should
 * precede it could not be written.
 *
 * Carrying on silently is the one thing this must not do — it is precisely the
 * situation the snapshot exists to prevent — but refusing outright would leave
 * the notebook unopenable. So the rows that were read are offered as an
 * ordinary backup file first, and upgrading is a decision you make with that
 * in hand.
 */
export function UpgradeBlocked({ outcome, onContinue }: Props) {
  async function handleDownload() {
    const backup = await backupFromTables(outcome.tables, outcome.fromVersion, Date.now());
    downloadText(
      `clemnotes-before-v${outcome.toVersion}-${timestampSlug()}.json`,
      serializeBackup(backup),
      'application/json'
    );
  }

  return (
    <div className="upgrade-blocked">
      <h1>Clemnotes needs to upgrade your notebook</h1>
      <p>
        This version stores notes slightly differently (schema v{outcome.fromVersion} → v
        {outcome.toVersion}). Before any upgrade a copy of everything is saved in this browser, but
        that copy couldn’t be written this time:
      </p>
      <pre className="crash-message">{outcome.error}</pre>
      <p>
        Download a backup first. It restores through <b>Export &amp; backup → Restore from a
        backup</b> like any other.
      </p>
      <div className="crash-actions">
        <button type="button" className="primary-btn" onClick={() => void handleDownload()}>
          Download a backup
        </button>
        <button type="button" className="ghost-btn" onClick={onContinue}>
          Upgrade anyway
        </button>
      </div>
    </div>
  );
}
