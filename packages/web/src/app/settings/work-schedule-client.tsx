'use client';

import { useEffect, useState } from 'react';
import type { WorkBreak, WorkSchedule } from '@pulse/shared';
import styles from './settings.module.css';

type ScheduleResponse = { schedule: WorkSchedule; isDefault: boolean };

// Render Monday-first (friendlier for a work schedule); the VALUES stay the
// scoring engine's 0=Sun…6=Sat convention — order is display-only.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function WorkScheduleClient() {
  // Form state mirrors the WorkSchedule fields. Dates and times stay the raw
  // local strings the inputs emit ("YYYY-MM-DD" / "HH:MM") — no Date objects.
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const [dailyHours, setDailyHours] = useState('8');
  const [vacationDates, setVacationDates] = useState<string[]>([]);
  const [breaks, setBreaks] = useState<WorkBreak[]>([]);
  const [newVacation, setNewVacation] = useState('');

  const [loaded, setLoaded] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/work-schedule')
      .then(async (res) => {
        if (!res.ok) throw new Error(`work-schedule responded ${res.status}`);
        return (await res.json()) as ScheduleResponse;
      })
      .then(({ schedule, isDefault }) => {
        if (cancelled) return;
        setWorkingDays(schedule.workingDays);
        setDailyHours(String(schedule.dailyHours));
        setVacationDates(schedule.vacationDates);
        setBreaks(schedule.breaks ?? []);
        setIsDefault(isDefault);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load your work schedule.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function applySaved({ schedule, isDefault }: ScheduleResponse) {
    setWorkingDays(schedule.workingDays);
    setDailyHours(String(schedule.dailyHours));
    setVacationDates(schedule.vacationDates);
    setBreaks(schedule.breaks ?? []);
    setIsDefault(isDefault);
  }

  function toggleDay(day: number) {
    setWorkingDays((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
    setSavedAt(null);
  }

  function addVacation() {
    if (!newVacation) return;
    setVacationDates((dates) => (dates.includes(newVacation) ? dates : [...dates, newVacation].sort()));
    setNewVacation('');
    setSavedAt(null);
  }

  function removeVacation(date: string) {
    setVacationDates((dates) => dates.filter((d) => d !== date));
    setSavedAt(null);
  }

  function updateBreak(index: number, patch: Partial<WorkBreak>) {
    setBreaks((all) => all.map((b, i) => (i === index ? { ...b, ...patch } : b)));
    setSavedAt(null);
  }

  async function save() {
    // Pre-flight the rules a user can actually trip from this form, so the
    // common cases never round-trip as a 400. The server re-validates all of it.
    if (workingDays.length === 0) {
      setError('Select at least one working day.');
      return;
    }
    const hours = Number(dailyHours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setError('Daily hours must be between 0 and 24.');
      return;
    }
    for (const b of breaks) {
      if (!b.start || !b.end) {
        setError('Every break needs a start and end time.');
        return;
      }
      if (b.start >= b.end) {
        setError('A break must start before it ends.');
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/work-schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workingDays,
          dailyHours: hours,
          vacationDates,
          breaks: breaks.map((b) => (b.label ? b : { start: b.start, end: b.end })),
        }),
      });
      const data = (await res.json()) as ScheduleResponse & { error?: string };
      if (!res.ok) {
        // The API's 400 carries a human-readable first-issue message.
        setError(data.error ?? 'Could not save your work schedule.');
        return;
      }
      applySaved(data);
      setSavedAt(Date.now());
    } catch {
      setError('Could not save your work schedule.');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <p className={styles.muted}>{error ?? 'Loading…'}</p>;
  }

  return (
    <div>
      {isDefault && (
        <p className={styles.banner}>
          These are the defaults — you haven&apos;t set a schedule yet. Save to make it yours.
        </p>
      )}

      <h3 className={styles.subTitle}>Working days</h3>
      <div className={styles.dayChips}>
        {DAY_ORDER.map((day) => (
          <label key={day} className={workingDays.includes(day) ? styles.dayChipOn : styles.dayChip}>
            <input
              type="checkbox"
              checked={workingDays.includes(day)}
              onChange={() => toggleDay(day)}
            />
            {DAY_LABELS[day]}
          </label>
        ))}
      </div>

      <h3 className={styles.subTitle}>Daily hours target</h3>
      <div className={styles.inlineRow}>
        <input
          type="number"
          min={0.5}
          max={24}
          step={0.5}
          value={dailyHours}
          onChange={(e) => {
            setDailyHours(e.target.value);
            setSavedAt(null);
          }}
          className={styles.smallInput}
          style={{ width: 90 }}
        />
        <span>hours per working day</span>
      </div>

      <h3 className={styles.subTitle}>Vacation days</h3>
      <div className={styles.inlineRow}>
        {/* type="date" emits a local YYYY-MM-DD string — exactly the civil-day
            format scoring expects, with no Date/UTC round-trip anywhere. */}
        <input
          type="date"
          value={newVacation}
          onChange={(e) => setNewVacation(e.target.value)}
          className={styles.smallInput}
        />
        <button className={styles.quietBtn} onClick={addVacation} disabled={!newVacation}>
          Add
        </button>
      </div>
      {vacationDates.length === 0 ? (
        <p className={styles.hint}>No vacation days set.</p>
      ) : (
        <ul className={styles.plainList}>
          {vacationDates.map((date) => (
            <li key={date}>
              {date}{' '}
              <button
                className={styles.quietBtn}
                style={{ marginLeft: 8 }}
                onClick={() => removeVacation(date)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className={styles.subTitle}>Breaks</h3>
      <p className={styles.muted}>
        Optional, e.g. lunch. Saved with your schedule; scoring doesn&apos;t use these yet.
      </p>
      {breaks.map((b, i) => (
        <div key={i} className={styles.breakRow}>
          <input
            type="text"
            placeholder="Label (optional)"
            value={b.label ?? ''}
            maxLength={60}
            onChange={(e) => updateBreak(i, { label: e.target.value })}
            className={styles.smallInput}
            style={{ width: 150 }}
          />
          <input
            type="time"
            value={b.start}
            onChange={(e) => updateBreak(i, { start: e.target.value })}
            className={styles.smallInput}
          />
          –
          <input
            type="time"
            value={b.end}
            onChange={(e) => updateBreak(i, { end: e.target.value })}
            className={styles.smallInput}
          />
          <button
            className={styles.quietBtn}
            onClick={() => {
              setBreaks((all) => all.filter((_, j) => j !== i));
              setSavedAt(null);
            }}
          >
            Remove
          </button>
        </div>
      ))}
      {breaks.length < 10 && (
        <button
          className={styles.quietBtn}
          onClick={() => {
            setBreaks((all) => [...all, { start: '12:00', end: '12:30' }]);
            setSavedAt(null);
          }}
        >
          Add a break
        </button>
      )}

      <div className={styles.saveRow}>
        <button className={styles.primaryBtn} onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save schedule'}
        </button>
        {savedAt !== null && <span className={styles.savedNote}>Saved ✓</span>}
      </div>
      {error && <p className={styles.errorNote}>{error}</p>}
    </div>
  );
}
