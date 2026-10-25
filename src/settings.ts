import * as db from './db.js';
import { bannedPhraseIn, POLICY, type CollectionPolicy } from './policy.js';
import { PLAYBOOKS, PLAYBOOK_TONE, type Playbook } from './strategy.js';

// Operator settings for the dashboard. These are intentionally separate
// from the hard collection rails in policy.ts: the dashboard can tune
// timing, cadence, playbooks, plan limits and model choice only inside
// validated bounds. It cannot enable threats, discounts, contact after
// an opt-out, or an unlimited contact cap.

export type AgentSettings = {
  enabled: boolean;
  draftModel: string;
  budgetUsd: number;

  timezone: string;
  sendDays: number[]; // JavaScript weekday numbers: Sunday=0 ... Saturday=6
  sendStart: string; // HH:MM
  sendEnd: string;   // HH:MM

  preDueReminderDays: number;
  minGapDays: number;
  maxContactsPerInvoice: number;
  maxOverdueDays: number;

  planMaxInstalments: number;
  planMaxDays: number;
  planMinFirstPct: number;
  planHumanAboveCents: number;

  enabledPlaybooks: Playbook[];
  explorationPct: number;
  rewardWindowDays: number;
  tones: Record<Playbook, string>;
  templates: Record<Playbook, string>;
};

export const DEFAULT_TEMPLATES: Record<Playbook, string> = {
  'friendly-plan-early': 'Hello {debtor} team, invoice {invoice} for {amount} was due on day {dueDay}. To make this easier, we can split it into {planCount} payments, with the first due by day {firstDay} and the final payment by day {lastDay}. Please reply to confirm, or let us know if anything looks wrong on the invoice.',
  'formal-firm': 'Dear {debtor} accounts team, our records show invoice {invoice} for {amount} remains unpaid {daysOverdue} days after its due date. Please arrange payment this week or share a firm payment date so we can keep your account in good standing.',
  'friendly-remind-only': 'Hi {debtor} team, a friendly note that invoice {invoice} for {amount} is now due. It may simply have been missed. Could you confirm the payment date on your side? Happy to resend any paperwork you need.',
};

export function defaultSettings(): AgentSettings {
  return {
    enabled: true,
    draftModel: 'baseline:rules',
    budgetUsd: 1,

    timezone: 'Asia/Karachi',
    sendDays: [0, 1, 2, 3, 4, 5, 6],
    sendStart: '00:00',
    sendEnd: '23:59',

    preDueReminderDays: POLICY.pre_due_reminder_days,
    minGapDays: POLICY.min_gap_days,
    maxContactsPerInvoice: POLICY.max_contacts_per_invoice,
    maxOverdueDays: 90,

    planMaxInstalments: POLICY.plan_max_instalments,
    planMaxDays: POLICY.plan_max_days,
    planMinFirstPct: POLICY.plan_min_first_pct,
    planHumanAboveCents: POLICY.plan_human_above_cents,

    enabledPlaybooks: [...PLAYBOOKS],
    explorationPct: 15,
    rewardWindowDays: 7,
    tones: { ...PLAYBOOK_TONE },
    templates: { ...DEFAULT_TEMPLATES },
  };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function text(v: unknown, fallback: string, max = 300): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return (s || fallback).slice(0, max);
}
function boundedNumber(name: string, v: unknown, fallback: number, min: number, max: number, integer = false): number {
  const n = v === undefined || v === null || v === '' ? fallback : Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}
function timeText(name: string, v: unknown, fallback: string): string {
  const s = text(v, fallback, 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error(`${name} must use HH:MM time`);
  return s;
}
function validTimezone(v: unknown, fallback: string): string {
  const tz = text(v, fallback, 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    throw new Error(`Unknown timezone: ${tz}`);
  }
}

export function normalizeSettings(raw: unknown): AgentSettings {
  const d = defaultSettings();
  const r = asRecord(raw);

  const draftModel = text(r.draftModel, d.draftModel, 100);
  const provider = draftModel.split(':')[0]?.toLowerCase();
  if (!/^[a-z]+:.+/.test(draftModel) || !['baseline', 'grok', 'Claude', 'openai', 'oss'].includes(provider)) {
    throw new Error('Draft model must look like baseline:rules, grok:model, Claude:model, openai:model, or oss:model');
  }

  const rawDays = Array.isArray(r.sendDays) ? r.sendDays : d.sendDays;
  const sendDays = [...new Set(rawDays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
  if (!sendDays.length) throw new Error('Choose at least one sending day');

  const sendStart = timeText('Send start', r.sendStart, d.sendStart);
  const sendEnd = timeText('Send end', r.sendEnd, d.sendEnd);
  if (sendEnd <= sendStart) throw new Error('Send end must be after send start (overnight windows are not supported)');

  const rawPlaybooks = Array.isArray(r.enabledPlaybooks) ? r.enabledPlaybooks : d.enabledPlaybooks;
  const enabledPlaybooks = PLAYBOOKS.filter((p) => rawPlaybooks.includes(p));
  if (!enabledPlaybooks.length) throw new Error('Enable at least one playbook');

  const rawTones = asRecord(r.tones);
  const rawTemplates = asRecord(r.templates);
  const tones = Object.fromEntries(PLAYBOOKS.map((p) => [p, text(rawTones[p], d.tones[p], 300)])) as Record<Playbook, string>;
  const templates = Object.fromEntries(PLAYBOOKS.map((p) => [p, text(rawTemplates[p], d.templates[p], 1200)])) as Record<Playbook, string>;
  for (const p of PLAYBOOKS) {
    const banned = bannedPhraseIn(templates[p], POLICY);
    if (banned) throw new Error(`${p} template contains banned phrase: ${banned}`);
    if (/discount|% off|settle for less|reduce (the )?balance/i.test(templates[p])) {
      throw new Error(`${p} template appears to offer a discount; discounts are locked off`);
    }
  }

  return {
    enabled: bool(r.enabled, d.enabled),
    draftModel,
    budgetUsd: boundedNumber('Budget', r.budgetUsd, d.budgetUsd, 0, 100),

    timezone: validTimezone(r.timezone, d.timezone),
    sendDays,
    sendStart,
    sendEnd,

    preDueReminderDays: boundedNumber('Pre-due reminder days', r.preDueReminderDays, d.preDueReminderDays, 0, 14, true),
    minGapDays: boundedNumber('Minimum days between contacts', r.minGapDays, d.minGapDays, 3, 30, true),
    maxContactsPerInvoice: boundedNumber('Maximum contacts per invoice', r.maxContactsPerInvoice, d.maxContactsPerInvoice, 1, 6, true),
    maxOverdueDays: boundedNumber('Stop automated chasing after overdue days', r.maxOverdueDays, d.maxOverdueDays, 7, 365, true),

    planMaxInstalments: boundedNumber('Maximum plan instalments', r.planMaxInstalments, d.planMaxInstalments, 1, 3, true),
    planMaxDays: boundedNumber('Maximum plan days', r.planMaxDays, d.planMaxDays, 7, 45, true),
    planMinFirstPct: boundedNumber('Minimum first instalment %', r.planMinFirstPct, d.planMinFirstPct, 25, 100, true),
    planHumanAboveCents: boundedNumber('Human plan approval threshold', r.planHumanAboveCents, d.planHumanAboveCents, 0, 100_000_000, true),

    enabledPlaybooks,
    explorationPct: boundedNumber('Exploration %', r.explorationPct, d.explorationPct, 0, 50),
    rewardWindowDays: boundedNumber('Reward window days', r.rewardWindowDays, d.rewardWindowDays, 1, 14, true),
    tones,
    templates,
  };
}

export function policyFromSettings(settings: AgentSettings): CollectionPolicy {
  return {
    ...POLICY,
    min_gap_days: settings.minGapDays,
    max_contacts_per_invoice: settings.maxContactsPerInvoice,
    pre_due_reminder_days: settings.preDueReminderDays,
    plan_max_instalments: settings.planMaxInstalments,
    plan_max_days: settings.planMaxDays,
    plan_min_first_pct: settings.planMinFirstPct,
    plan_human_above_cents: settings.planHumanAboveCents,
    discount_allowed: false,
  };
}

export async function loadSettings(scope = 'live'): Promise<AgentSettings> {
  const raw = await db.getState(`settings:${scope}`);
  if (!raw) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // A corrupt dashboard value must not take collections down with it.
    // The settings page will overwrite it on the next successful save.
    return defaultSettings();
  }
}

export async function saveSettings(scope: string, raw: unknown, changedBy = 'dashboard'): Promise<AgentSettings> {
  const settings = normalizeSettings(raw);
  await db.setState(`settings:${scope}`, JSON.stringify(settings));
  await db.recordSettingsHistory(scope, settings, changedBy);
  return settings;
}

const WEEKDAY_NUMBER: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type ScheduleStatus = {
  allowed: boolean;
  localTime: string;
  weekday: number;
  reason: string;
};

export function scheduleStatus(settings: AgentSettings, now = new Date()): ScheduleStatus {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = WEEKDAY_NUMBER[part('weekday')] ?? now.getUTCDay();
  const localTime = `${part('hour').padStart(2, '0')}:${part('minute').padStart(2, '0')}`;
  if (!settings.enabled) return { allowed: false, localTime, weekday, reason: 'Agent is paused in the dashboard' };
  if (!settings.sendDays.includes(weekday)) return { allowed: false, localTime, weekday, reason: 'Today is not a selected sending day' };
  if (localTime < settings.sendStart || localTime > settings.sendEnd) {
    return { allowed: false, localTime, weekday, reason: `Outside sending window ${settings.sendStart}–${settings.sendEnd} (${settings.timezone})` };
  }
  return { allowed: true, localTime, weekday, reason: `Inside sending window ${settings.sendStart}–${settings.sendEnd} (${settings.timezone})` };
}

export function renderTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_match, key: string) => String(values[key] ?? ''));
}
