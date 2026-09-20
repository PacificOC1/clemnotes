import { useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { loadStatistics, type DayPoint, type ForecastDay, type IntervalBucket } from '../db/statistics';

/**
 * What the review log is for.
 *
 * Four figures, in the order they change what you do: retention says whether
 * the reviewing is working, the daily bars say whether you are turning up, the
 * forecast warns you about a spike before you walk into it, and the interval
 * spread says whether anything is reaching long-term memory.
 *
 * Every chart is one series, so every chart is one colour and needs no legend —
 * its heading already says what is plotted. Each has a table twin behind the
 * toggle, because a bar you can only read by hovering it is a bar some people
 * cannot read at all.
 */

const WINDOW_DAYS = 30;

function formatDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

interface Point {
  key: string;
  label: string;
  value: number;
  title: string;
}

interface ColumnsProps {
  points: Point[];
  /** Noun for the values, used in the peak label and the plot's description. */
  unit: string;
  /** `all` labels every bar — only legible for a handful of them. */
  labels: 'ends' | 'all';
}

/**
 * A single-series column chart.
 *
 * Bars are capped rather than stretched to fill their slot, separated by a gap
 * in the surface colour rather than by a border, and rounded only at the data
 * end so the baseline still reads as a line. One series means one colour and
 * no legend — the figure's heading already says what is plotted — and only the
 * peak is directly labelled, because a number on every bar goes unread.
 */
function Columns({ points, unit, labels }: ColumnsProps) {
  if (points.length === 0) return null;

  const max = Math.max(1, ...points.map((p) => p.value));
  const peak = points.reduce((best, p) => (p.value > best.value ? p : best), points[0]!);
  const total = points.reduce((sum, p) => sum + p.value, 0);

  return (
    <div className={`chart chart-${labels}`}>
      <div
        className="chart-plot"
        role="img"
        aria-label={`Column chart, ${points.length} bars, ${total} ${unit} in total, peak ${peak.value} on ${peak.label}.`}
      >
        <span className="chart-gridline chart-gridline-top" aria-hidden="true" />
        <span className="chart-gridline chart-gridline-mid" aria-hidden="true" />
        {points.map((point) => (
          <span className="chart-slot" key={point.key} title={point.title}>
            <span
              className={`chart-bar${point.value === 0 ? ' chart-bar-empty' : ''}`}
              style={{ height: `${(point.value / max) * 100}%` }}
            >
              {/* Anchored to the bar, not the slot, so it rides the cap at any height. */}
              {(labels === 'all' || point.key === peak.key) && point.value > 0 && (
                <span className="chart-value">{point.value}</span>
              )}
            </span>
          </span>
        ))}
        <span className="chart-baseline" aria-hidden="true" />
      </div>
      {labels === 'all' ? (
        <div className="chart-axis chart-axis-all">
          {points.map((point) => (
            <span key={point.key}>{point.label}</span>
          ))}
        </div>
      ) : (
        <div className="chart-axis">
          <span>{points[0]?.label}</span>
          <span>{points[points.length - 1]?.label}</span>
        </div>
      )}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <table className="chart-table">
      <thead>
        <tr>{head.map((h) => <th key={h}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])}>
            {row.map((cell, i) => (
              <td key={i}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Figure({
  title,
  note,
  asTable,
  chart,
  table,
}: {
  title: string;
  note: string;
  asTable: boolean;
  chart: ReactNode;
  table: ReactNode;
}) {
  return (
    <section className="chart-figure">
      <header>
        <h3>{title}</h3>
        <p>{note}</p>
      </header>
      {asTable ? table : chart}
    </section>
  );
}

function reviewRows(series: DayPoint[]): Array<Array<string | number>> {
  return series.map((p) => [formatDay(p.at), p.count]);
}

function forecastRows(series: ForecastDay[]): Array<Array<string | number>> {
  return series.map((p) => [formatDay(p.at), p.count, p.cumulative]);
}

function intervalRows(buckets: IntervalBucket[]): Array<Array<string | number>> {
  return buckets.map((b) => [b.label, b.count]);
}

export function StatsPanel() {
  const [asTable, setAsTable] = useState(false);
  const stats = useLiveQuery(() => loadStatistics(WINDOW_DAYS, WINDOW_DAYS), []);

  const reviewPoints = useMemo(
    () =>
      (stats?.reviewsPerDay ?? []).map((p) => ({
        key: p.day,
        label: formatDay(p.at),
        value: p.count,
        title: `${formatDay(p.at)}: ${p.count} review${p.count === 1 ? '' : 's'}`,
      })),
    [stats?.reviewsPerDay]
  );

  const forecastPoints = useMemo(
    () =>
      (stats?.forecast ?? []).map((p) => ({
        key: p.day,
        label: formatDay(p.at),
        value: p.count,
        title: `${formatDay(p.at)}: ${p.count} due · ${p.cumulative} cumulative`,
      })),
    [stats?.forecast]
  );

  const intervalPoints = useMemo(
    () =>
      (stats?.intervals ?? []).map((b) => ({
        key: b.label,
        label: b.label,
        value: b.count,
        title: `${b.label}: ${b.count} card${b.count === 1 ? '' : 's'}`,
      })),
    [stats?.intervals]
  );

  if (!stats) return null;

  const { summary, streak, windowDays } = stats;
  const perDay = summary.reviews / windowDays;

  if (summary.reviews === 0) {
    return (
      <div className="stats stats-empty">
        <h2>Statistics</h2>
        <p>
          Nothing reviewed in the last {windowDays} days. Retention, forecasts and interval
          spread all read from the review log, so they fill in as you review — there is
          nothing to backfill them from.
        </p>
      </div>
    );
  }

  return (
    <div className="stats">
      <div className="stats-head">
        <h2>Statistics</h2>
        <button type="button" className="stats-toggle" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show charts' : 'Show tables'}
        </button>
      </div>

      <div className="stats-figures">
        <div className="stats-hero">
          <span className="stats-hero-value">{percent(summary.retention)}</span>
          <span className="stats-hero-label">retention · last {windowDays} days</span>
          <span className="stats-hero-note">
            Share of reviews you got right, counting only cards you had seen before.
          </span>
        </div>
        <div className="stats-tiles">
          <div className="stats-tile">
            <span className="stats-tile-value">{summary.reviews}</span>
            <span className="stats-tile-label">reviews</span>
          </div>
          <div className="stats-tile">
            <span className="stats-tile-value">{perDay.toFixed(1)}</span>
            <span className="stats-tile-label">per day</span>
          </div>
          <div className="stats-tile">
            <span className="stats-tile-value">{summary.lapses}</span>
            <span className="stats-tile-label">lapses</span>
          </div>
          <div className="stats-tile">
            <span className="stats-tile-value">{streak}</span>
            <span className="stats-tile-label">day streak</span>
          </div>
        </div>
      </div>

      <Figure
        title={`Reviews per day · last ${windowDays} days`}
        note="Empty days are shown, because the gaps are the point."
        asTable={asTable}
        chart={<Columns points={reviewPoints} unit="reviews" labels="ends" />}
        table={<Table head={['Day', 'Reviews']} rows={reviewRows(stats.reviewsPerDay)} />}
      />

      <Figure
        title={`Due in the next ${windowDays} days`}
        note={`Everything already due lands on the first day — ${stats.dueNow} card${
          stats.dueNow === 1 ? '' : 's'
        } right now.`}
        asTable={asTable}
        chart={<Columns points={forecastPoints} unit="cards" labels="ends" />}
        table={<Table head={['Day', 'Due', 'Cumulative']} rows={forecastRows(stats.forecast)} />}
      />

      <Figure
        title="Interval spread"
        note={`${stats.mature} of ${stats.total} cards are on an interval of three weeks or more.`}
        asTable={asTable}
        chart={<Columns points={intervalPoints} unit="cards" labels="all" />}
        table={<Table head={['Interval', 'Cards']} rows={intervalRows(stats.intervals)} />}
      />
    </div>
  );
}
