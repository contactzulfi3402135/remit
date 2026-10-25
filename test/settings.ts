import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSettings,
  normalizeSettings,
  policyFromSettings,
  renderTemplate,
  scheduleStatus,
} from '../src/settings.js';
import { baselineDraft } from '../src/draft.js';
import { choosePlaybook } from '../src/strategy.js';
import type { Invoice } from '../src/ledger.js';

test('dashboard defaults preserve the locked no-discount rail', () => {
  const settings = defaultSettings();
  assert.equal(settings.draftModel, 'baseline:rules');
  assert.equal(settings.minGapDays, 3);
  assert.equal(policyFromSettings(settings).discount_allowed, false);
});

test('dashboard settings reject values outside the safe operating bounds', () => {
  assert.throws(() => normalizeSettings({ ...defaultSettings(), minGapDays: 2 }), /between 3 and 30/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), maxContactsPerInvoice: 7 }), /between 1 and 6/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), planMaxInstalments: 4 }), /between 1 and 3/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), planMinFirstPct: 10 }), /between 25 and 100/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), explorationPct: 51 }), /between 0 and 50/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), sendDays: [] }), /at least one sending day/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), enabledPlaybooks: [] }), /at least one playbook/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), draftModel: 'unknown:model' }), /Draft model/);
  assert.throws(() => normalizeSettings({ ...defaultSettings(), timezone: 'Not/AZone' }), /Unknown timezone/);
});

test('dashboard templates cannot smuggle in threats or discounts', () => {
  const base = defaultSettings();
  const threat = {
    ...base,
    templates: { ...base.templates, 'formal-firm': 'Pay now or we will see you in court, {debtor}.' },
  };
  assert.throws(() => normalizeSettings(threat), /banned phrase/);
  const discount = {
    ...base,
    templates: { ...base.templates, 'formal-firm': 'We can give a discount on invoice {invoice}.' },
  };
  assert.throws(() => normalizeSettings(discount), /discount/);
});

test('schedule status honors timezone, weekdays, time window, and pause', () => {
  const settings = normalizeSettings({
    ...defaultSettings(),
    timezone: 'UTC',
    sendDays: [1],
    sendStart: '09:00',
    sendEnd: '17:00',
  });
  const mondayInside = new Date('2026-10-26T10:00:00Z');
  const mondayOutside = new Date('2026-10-26T18:00:00Z');
  const TuesdayInside = new Date('2026-10-27T10:00:00Z');
  assert.equal(scheduleStatus(settings, mondayInside).allowed, true);
  assert.equal(scheduleStatus(settings, mondayOutside).allowed, false);
  assert.equal(scheduleStatus(settings, TuesdayInside).allowed, false);
  assert.equal(scheduleStatus({ ...settings, enabled: false }, mondayInside).allowed, false);
});

test('templates render invoice values and baseline drafting uses saved wording', () => {
  assert.equal(renderTemplate('Hi {debtor}, {invoice} is {amount}.', { debtor: 'Acme', invoice: 'inv-9', amount: '$20' }), 'Hi Acme, inv-9 is $20.');
  const base = defaultSettings();
  const settings = normalizeSettings({
    ...base,
    templates: { ...base.templates, 'formal-firm': 'CUSTOM {debtor} {invoice} {amount}' },
  });
  const inv: Invoice = {
    id: 'inv-9', debtorId: 'd9', debtorName: 'Acme', amountCents: 2000, paidCents: 0,
    issuedDay: -30, dueDay: 0, status: 'open', paidDay: null,
  };
  const draft = baselineDraft({ inv, events: [], worldDay: 2, segment: 'new', playbook: 'formal-firm', policy: policyFromSettings(settings), settings });
  assert.equal(draft.message, 'CUSTOM Acme inv-9 $20.00');
});

test('default baseline wording stays accurate before the due day', () => {
  const settings = defaultSettings();
  const inv: Invoice = {
    id: 'inv-early', debtorId: 'd1', debtorName: 'Blue Peak', amountCents: 12345, paidCents: 0,
    issuedDay: 0, dueDay: 4, status: 'open', paidDay: null,
  };
  for (const playbook of ['friendly-plan-early', 'formal-firm', 'friendly-remind-only'] as const) {
    const draft = baselineDraft({ inv, events: [], worldDay: 2, segment: 'new', playbook, policy: policyFromSettings(settings), settings });
    assert.match(draft.message, /day 4/);
    assert.doesNotMatch(draft.message, /-2|now due|days after its due date/);
  }

  const migrated = normalizeSettings({
    ...settings,
    templates: {
      ...settings.templates,
      'friendly-remind-only': 'Hi {debtor} team, a friendly note that invoice {invoice} for {amount} is now due. It may simply have been missed. Could you confirm the payment date on your side? Happy to resend any paperwork you need.',
    },
  });
  assert.equal(migrated.templates['friendly-remind-only'], settings.templates['friendly-remind-only']);
  const custom = normalizeSettings({
    ...settings,
    templates: { ...settings.templates, 'friendly-remind-only': 'Custom wording for {invoice}.' },
  });
  assert.equal(custom.templates['friendly-remind-only'], 'Custom wording for {invoice}.');
});

test('playbook selection stays inside the operator-enabled set', () => {
  const stats = [
    { playbook: 'friendly-plan-early' as const, contacts: 10, rewards: 0 },
    { playbook: 'formal-firm' as const, contacts: 10, rewards: 10 },
    { playbook: 'friendly-remind-only' as const, contacts: 10, rewards: 1 },
  ];
  assert.equal(choosePlaybook(stats, 0, ['friendly-remind-only']), 'friendly-remind-only');
});
