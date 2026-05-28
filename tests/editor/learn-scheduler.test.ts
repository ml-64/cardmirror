/**
 * Learn scheduler — binary interval ladder, retry, queue building.
 */

import { describe, expect, it } from 'vitest';
import {
  newSchedule,
  gradeCard,
  isDue,
  buildQueue,
  dueCount,
  addDays,
  GROWTH,
  type ScheduleEntry,
} from '../../src/editor/learn-scheduler.js';

const TODAY = '2026-05-27';
const NOW = '2026-05-27T12:00:00.000Z';
const noFuzz = () => 0.5; // factor 1.0 — deterministic intervals

function entry(over: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return {
    cardId: 'c1',
    state: 'review',
    dueOn: TODAY,
    intervalDays: 10,
    reps: 3,
    lapses: 0,
    lastReviewed: null,
    ...over,
  };
}

describe('addDays', () => {
  it('adds days with month rollover', () => {
    expect(addDays('2026-05-27', 1)).toBe('2026-05-28');
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01');
    expect(addDays('2026-05-27', 0)).toBe('2026-05-27');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('newSchedule', () => {
  it('is a new card due today', () => {
    const s = newSchedule('c1', TODAY);
    expect(s).toMatchObject({ state: 'new', dueOn: TODAY, intervalDays: 0, reps: 0, lapses: 0 });
  });
});

describe('gradeCard — remembered', () => {
  it('new → review at the first interval (1d), due tomorrow', () => {
    const { entry: e, retryInSession } = gradeCard(
      newSchedule('c1', TODAY),
      'remembered',
      TODAY,
      NOW,
      noFuzz,
    );
    expect(e.state).toBe('review');
    expect(e.intervalDays).toBe(1);
    expect(e.reps).toBe(1);
    expect(e.dueOn).toBe('2026-05-28');
    expect(retryInSession).toBe(false);
  });

  it('review → interval grows by GROWTH (rounded)', () => {
    const { e } = grade(entry({ intervalDays: 10 }), 'remembered');
    expect(e.intervalDays).toBe(Math.round(10 * GROWTH)); // 23
    expect(e.dueOn).toBe(addDays(TODAY, 23));
  });

  it('interval is capped at the max', () => {
    const { e } = grade(entry({ intervalDays: 300 }), 'remembered');
    expect(e.intervalDays).toBe(365);
  });

  it('relearning (learning + prior lapse) → review at relearn interval', () => {
    const { e } = grade(entry({ state: 'learning', lapses: 1, intervalDays: 0 }), 'remembered');
    expect(e.state).toBe('review');
    expect(e.intervalDays).toBe(1);
  });
});

describe('gradeCard — forgot', () => {
  it('lapses, resets to learning, wants tomorrow + in-session retry', () => {
    const { entry: e, retryInSession } = gradeCard(
      entry({ intervalDays: 40, reps: 5, lapses: 2 }),
      'forgot',
      TODAY,
      NOW,
      noFuzz,
    );
    expect(e.state).toBe('learning');
    expect(e.intervalDays).toBe(0);
    expect(e.reps).toBe(0);
    expect(e.lapses).toBe(3);
    expect(e.dueOn).toBe('2026-05-28');
    expect(retryInSession).toBe(true);
  });
});

describe('isDue', () => {
  it('due on/before today, not suspended', () => {
    expect(isDue(entry({ dueOn: TODAY }), TODAY)).toBe(true);
    expect(isDue(entry({ dueOn: '2026-05-20' }), TODAY)).toBe(true);
    expect(isDue(entry({ dueOn: '2026-06-01' }), TODAY)).toBe(false);
    expect(isDue(entry({ state: 'suspended', dueOn: TODAY }), TODAY)).toBe(false);
  });
});

describe('buildQueue', () => {
  it('dedupes by cardId (keeps soonest due), new before review, drops not-due/suspended', () => {
    const q = buildQueue(
      [
        entry({ cardId: 'a', state: 'review', dueOn: TODAY }),
        entry({ cardId: 'a', state: 'review', dueOn: '2026-05-20' }), // same card, earlier
        entry({ cardId: 'b', state: 'new', dueOn: TODAY }),
        entry({ cardId: 'c', state: 'review', dueOn: '2026-06-10' }), // not due
        entry({ cardId: 'd', state: 'suspended', dueOn: TODAY }), // suspended
      ],
      TODAY,
    );
    expect(q.map((e) => e.cardId)).toEqual(['b', 'a']); // new first, then the deduped review
    expect(q.find((e) => e.cardId === 'a')!.dueOn).toBe('2026-05-20'); // soonest kept
  });
});

describe('dueCount', () => {
  it('counts distinct due cards', () => {
    expect(
      dueCount(
        [
          entry({ cardId: 'a', dueOn: TODAY }),
          entry({ cardId: 'a', dueOn: TODAY }),
          entry({ cardId: 'b', dueOn: TODAY }),
          entry({ cardId: 'c', dueOn: '2026-07-01' }),
        ],
        TODAY,
      ),
    ).toBe(2);
  });
});

// Helper that grades with fixed timestamp/fuzz and returns the entry.
function grade(e: ScheduleEntry, g: 'remembered' | 'forgot') {
  return { e: gradeCard(e, g, TODAY, NOW, noFuzz).entry };
}
