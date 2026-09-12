/**
 * Coverage for configurable working days (src/lib/workingDays.ts,
 * operatingSettingsService.ts): Mon-Fri are always working days, Saturday and
 * Sunday are toggled in Settings > Working days, and that choice drives
 * instalment due dates, daily loan interest accrual, and direct-debit
 * collection — but never whether a payment someone actually makes is accepted.
 *
 * The date math is tested against the pure helpers with an explicit config
 * rather than through the DB singleton: the singleton is global, other test
 * files write to it too, and the logic worth pinning down here is
 * deterministic given its inputs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest } from './helpers';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as operatingGET, PATCH as operatingPATCH } from '@/app/api/settings/operating/route';
import { isWorkingDay, rollToWorkingDay, addWorkingDays, DEFAULT_WORKING_DAYS } from '@/lib/workingDays';
import { generateStraightLineSchedule } from '@/lib/services/scheduleService';

const PASSWORD = 'Passw0rd!123';

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

const MON_FRI = DEFAULT_WORKING_DAYS;
const SAT_ONLY = { saturday: true, sunday: false };
const BOTH = { saturday: true, sunday: true };

// 2026-01-03 is a Saturday, 2026-01-04 a Sunday, 2026-01-05 a Monday.
const SATURDAY = new Date(2026, 0, 3);
const SUNDAY = new Date(2026, 0, 4);
const MONDAY = new Date(2026, 0, 5);

describe('Working days: pure date helpers', () => {
  it('Mon-Fri are working days under every configuration', () => {
    for (const days of [MON_FRI, SAT_ONLY, BOTH]) {
      for (let d = 5; d <= 9; d++) {
        expect(isWorkingDay(new Date(2026, 0, d), days)).toBe(true); // Mon 5th .. Fri 9th
      }
    }
  });

  it('the weekend follows the configuration', () => {
    expect(isWorkingDay(SATURDAY, MON_FRI)).toBe(false);
    expect(isWorkingDay(SUNDAY, MON_FRI)).toBe(false);

    expect(isWorkingDay(SATURDAY, SAT_ONLY)).toBe(true);
    expect(isWorkingDay(SUNDAY, SAT_ONLY)).toBe(false);

    expect(isWorkingDay(SATURDAY, BOTH)).toBe(true);
    expect(isWorkingDay(SUNDAY, BOTH)).toBe(true);
  });

  it('rollToWorkingDay skips only the days that are actually closed', () => {
    expect(rollToWorkingDay(SATURDAY, MON_FRI).getDate()).toBe(5); // Sat -> Mon
    expect(rollToWorkingDay(SATURDAY, SAT_ONLY).getDate()).toBe(3); // Sat is open, stays put
    expect(rollToWorkingDay(SUNDAY, SAT_ONLY).getDate()).toBe(5); // Sun -> Mon
    expect(rollToWorkingDay(MONDAY, MON_FRI).getDate()).toBe(5); // already working, untouched
  });

  it('addWorkingDays counts only open days, never landing two instalments on the same date', () => {
    // Thu 2026-01-01 + 5 working days, Mon-Fri only: Fri 2, Mon 5, Tue 6, Wed 7, Thu 8.
    const thursday = new Date(2026, 0, 1);
    const monFri = [1, 2, 3, 4, 5].map((n) => addWorkingDays(thursday, n, MON_FRI).getDate());
    expect(monFri).toEqual([2, 5, 6, 7, 8]);

    // Same start, open 7 days a week: plain consecutive calendar days.
    const both = [1, 2, 3, 4, 5].map((n) => addWorkingDays(thursday, n, BOTH).getDate());
    expect(both).toEqual([2, 3, 4, 5, 6]);

    // Open Saturdays but not Sundays: Fri 2, Sat 3, Mon 5, Tue 6, Wed 7.
    const satOnly = [1, 2, 3, 4, 5].map((n) => addWorkingDays(thursday, n, SAT_ONLY).getDate());
    expect(satOnly).toEqual([2, 3, 5, 6, 7]);
  });
});

describe('Working days: instalment schedules', () => {
  it('a DAILY schedule puts every due date on an open day, whatever the configuration', () => {
    for (const days of [MON_FRI, SAT_ONLY, BOTH]) {
      const schedule = generateStraightLineSchedule(100000, 1, new Date(2026, 0, 1), 'DAILY', 10, days);
      expect(schedule).toHaveLength(10);
      expect(schedule.every((s) => isWorkingDay(s.dueDate, days))).toBe(true);
      expect(new Set(schedule.map((s) => s.dueDate.getTime())).size).toBe(10); // no collisions
    }
  });

  it('enabling weekend work shortens the calendar span of the same DAILY schedule', () => {
    const start = new Date(2026, 0, 1);
    const closed = generateStraightLineSchedule(100000, 1, start, 'DAILY', 10, MON_FRI);
    const open = generateStraightLineSchedule(100000, 1, start, 'DAILY', 10, BOTH);
    const last = (s: typeof closed) => s[s.length - 1].dueDate.getTime();
    expect(last(open)).toBeLessThan(last(closed));
  });

  it('a WEEKLY schedule starting on a Saturday stays on Saturday when Saturdays are worked', () => {
    const schedule = generateStraightLineSchedule(20000, 1, SATURDAY, 'WEEKLY', 2, SAT_ONLY);
    expect(schedule[0].dueDate.getDay()).toBe(6); // still Saturday, no roll
    expect(schedule[0].dueDate.getDate()).toBe(10);
    expect(schedule[1].dueDate.getDate()).toBe(17);
  });

  it('defaults to Mon-Fri when no configuration is passed', () => {
    const schedule = generateStraightLineSchedule(100000, 1, new Date(2026, 0, 1), 'DAILY', 10);
    expect(schedule.every((s) => isWorkingDay(s.dueDate, MON_FRI))).toBe(true);
  });
});

describe('Working days: settings API', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
  });

  it('GET needs only authentication — the contract wizard preview reads it as any staff user', async () => {
    const res = await operatingGET(makeRequest('GET', '/api/settings/operating', { token: cashier }));
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    expect(typeof settings.worksSaturday).toBe('boolean');
    expect(typeof settings.worksSunday).toBe('boolean');
  });

  it('GET rejects an unauthenticated caller', async () => {
    const res = await operatingGET(makeRequest('GET', '/api/settings/operating'));
    expect(res.status).toBe(401);
  });

  it('PATCH requires settings.manage — CASHIER gets 403', async () => {
    const res = await operatingPATCH(makeRequest('PATCH', '/api/settings/operating', {
      token: cashier, body: { worksSaturday: true, worksSunday: true },
    }));
    expect(res.status).toBe(403);
  });

  it('PATCH rejects a non-boolean value', async () => {
    const res = await operatingPATCH(makeRequest('PATCH', '/api/settings/operating', {
      token: admin, body: { worksSaturday: 'yes', worksSunday: false },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/worksSaturday must be a boolean/i);
  });

  it('ADMIN can save both toggles, and the response reflects exactly what was written', async () => {
    // Asserted against this call's own response rather than a follow-up GET:
    // the row is a global singleton other test files also write to.
    const on = await operatingPATCH(makeRequest('PATCH', '/api/settings/operating', {
      token: admin, body: { worksSaturday: true, worksSunday: false },
    }));
    expect(on.status).toBe(200);
    const saved = (await on.json()).settings;
    expect(saved.worksSaturday).toBe(true);
    expect(saved.worksSunday).toBe(false);
  });
});
