# Remit architecture

Remit is split into an agent (TypeScript), a human desk (same TypeScript
process when serving), an agent database (Postgres), and a system of
record behind GraphQL (a Go stand-in ledger in this repository).

```text
                         ┌──────────────────────────────┐
                         │ Human desk (HTTP + Basic)    │
                         │ disputes / plan approval     │
                         └──────────────┬───────────────┘
                                        │
┌────────────────┐      ┌───────────────▼────────────────┐      ┌─────────────────┐
│ Scheduler / CLI│─────▶│ Remit engine (TypeScript)      │─────▶│ Model providers │
│ sweep / eval   │      │ segment → playbook → draft     │      │ tool-call draft │
└────────────────┘      │          │                     │      └─────────────────┘
                        │          ▼                     │
                        │ deterministic policy gate      │
                        └───────┬──────────────┬─────────┘
                                │              │
                    GraphQL     │              │     Postgres
                                ▼              ▼
                    ┌────────────────┐  ┌──────────────────────────────┐
                    │ Go ledger      │  │ remit schema                 │
                    │ invoices/events│  │ runs/calls/decisions/queue/  │
                    │ plans/payments │  │ suppressions/contact_trials/ │
                    │ simulator      │  │ playbook_stats/state         │
                    └────────────────┘  └──────────────────────────────┘
```

## Design boundaries

### The model proposes; code disposes

The LLM receives one invoice, a segment, a playbook, plan limits, and a
short event history. It must answer through the `decide_draft` tool with
one of `wait`, `contact`, `offer_plan`, or `escalate`.

That output is only a proposal. `checkDraft` validates its form and
`gate` checks spacing, caps, active promises, banned language, discount
language, and every plan rule before any ledger mutation. If drafting
fails after retries, the invoice is escalated; malformed model text is
never used as a message fallback.

### The ledger is the system of record

Invoices, debtor-visible contacts, replies, promises, plans, payments,
disputes, and escalations live behind the GraphQL ledger API. The agent
database stores operational memory and telemetry, not a second copy of
invoice truth.

The Go implementation is intentionally a stand-in for an ERP/billing API.
It also advances a seeded debtor world. Persona labels are private to the
world generator and absent from the GraphQL schema.

### Scopes isolate live and evaluation memory

Agent state is scoped:

- `live` for scheduled sweeps and the human desk;
- `eval-none-<seed>`, `eval-template-<seed>`, and `eval-remit-<seed>` for
  simulator episodes.

Evaluation calls `resetScope` before each disposable episode. That clears
only that scope’s cursor, decisions, queue, suppressions, playbook stats,
and contact trials. `resetScope` refuses the `live` scope.

## One engine pass

`src/engine.ts:runDay` is the centre of the system.

1. **Read world state.** Fetch ledger stats, all invoices, and events
   after `${scope}:last_event_id`.
2. **Safety first.** Classify fresh replies. Dispute/distress suppress and
   queue; opt-out suppresses and queues acknowledgement.
3. **Attribute payments.** For each fresh payment, find the latest
   contact trial inside seven days. If that trial is unrewarded, mark it
   rewarded and increment the aggregate for its frozen segment/playbook.
   If it is already rewarded, stop—do not credit an older trial.
4. **Select actionable invoices.** Open, positive remaining balance, not
   suppressed, and no earlier than two days before due.
5. **Infer segment.** `segmentOf` uses debtor-level paid history plus the
   invoice’s contact/reply/promise/payment events.
6. **Choose and draft.** Template strategy uses fixed overdue days and
   `formal-firm`. Remit uses the bandit and the configured draft model.
7. **Gate.** Policy returns allow, wait, or queue with a reason. Every
   outcome is recorded in `remit.decisions`.
8. **Write.** Allowed contacts/plans are sent to the ledger. The engine
   immediately reads back the contact event id and writes a trial row.
9. **Advance simulated time (sweep wrapper only).** The evaluation and
   stand-in sweep advance the world one day after working it.

## Learning invariants

The learning loop is deliberately small enough to audit.

### Contact trial

`remit.contact_trials` has primary key `(scope, contact_event_id)` and
stores:

- invoice id;
- world day;
- segment at contact time;
- playbook at contact time;
- optional rewarded payment event id and reward timestamp.

### Reward

A reward means: “at least one payment arrived within seven days after
this contact, and this was the latest contact before that payment.” It
does not prove causation.

Required invariants:

```sql
-- Aggregate sanity
select *
from remit.playbook_stats
where rewards > contacts;

-- Trial sanity: a rewarded trial has exactly one payment event recorded
select scope, segment, playbook, count(*) as trials,
       count(rewarded_payment_event_id) as rewarded
from remit.contact_trials
group by scope, segment, playbook;
```

The first query must always return zero rows.

### Promise handling

Ledger promise events carry the promised day. `latestPromise` finds the
newest structured promise and whether any later payment exists.

- Promise day today or in the future, with no later payment: policy waits.
- Promise day in the past, with no later payment: segment becomes
  `promise-broken`.
- Any other promise history: segment may be `promised-before`.

This prevents a reminder sent shortly before a promised payment from
stealing the earlier contact’s reward.

## Human desk authority

The desk exposes only kind-appropriate actions:

| Queue kind | Allowed actions |
| --- | --- |
| `optout` | keep paused only |
| `dispute` | dispute resolved, keep paused |
| policy with stored `offer_plan` | approve & send plan, resume, keep paused |
| other queue kinds | resume, keep paused |

Server-side checks mirror button visibility. Posting `resume` for an
opt-out returns HTTP 400 and leaves the suppression intact.

Plan approval is a revalidation, not a blind send:

1. parse the stored draft with `checkDraft`;
2. fetch current invoice, events, and world day;
3. require the invoice to still be open;
4. run `gate` with only `plan_human_above_cents` raised;
5. create the plan, log the contact, and record a normal contact trial.

Dispute resolution reopens a disputed ledger invoice and removes the
agent suppression. Generic resume reopens an escalated ledger invoice (via
`reopen`) when necessary and removes suppression. There is no write-off
or discount action anywhere in the UI or agent toolset.

In production mode, the desk fails closed if `REVIEW_PASSWORD` is unset.
Debtor-controlled strings are HTML-escaped before rendering.

## Data model

### `remit` schema (agent memory)

- `runs` — sweep/eval execution records and summary stats.
- `calls` — model telemetry: stage, model, invoice ids, tokens, cost,
  latency, and errors.
- `decisions` — one row per considered invoice/action outcome, with
  segment, playbook, world day, and reason.
- `queue` — open human work, with JSON detail such as debtor reply or the
  full blocked draft.
- `state` — scoped event cursors.
- `playbook_stats` — aggregate contacts/rewards by scope, segment, and
  playbook.
- `contact_trials` — immutable attribution rows described above.
- `suppressions` — invoices the agent must not contact in a scope.

### `remit_ledger` schema (stand-in only)

- `world_state` — one JSONB snapshot of debtors, invoices, events, plans,
  contact counts, world day, and seed.

The snapshot is a disclosed simulator simplification. It makes restart
persistence easy and behaviour deterministic at dozens-of-invoices scale,
but it requires a single authoritative ledger process. Deployment keeps
that invariant: GitHub sweeps call the deployed ledger instead of
starting another writer; the optional GCP script pins Cloud Run to one
instance with concurrency one. A real ERP is external and would not use
this store.

## Ledger API

Queries:

- `stats`
- `invoices(status, limit)`
- `invoice(id)`
- `debtorInvoices(debtorId)`
- `events(afterId, limit)`
- `invoiceEvents(invoiceId)`

Mutations:

- `logContact`
- `createPlan`
- `recordPromise`
- `escalate`
- `reopen`
- `resolveDispute`
- `advanceDay`
- `resetWorld` (evaluation/simulator harness only)

There is no persona field in the schema. `advanceDay` and `resetWorld`
exist because the system of record is also the measurement simulator;
they would not exist on a production ERP adapter.

## Failure behaviour

- **Ledger unavailable:** the run fails rather than inventing invoice
  state. The scheduler can retry on its next invocation.
- **Model unavailable or malformed:** calls are retried by the provider
  layer/draft loop; persistent failure escalates the invoice.
- **Database unavailable:** the run fails. Contacts are not counted as
  trials without the database, and queue/decision records are considered
  part of safe operation.
- **Contact logged but trial read-back missing:** the engine throws. This
  is intentionally loud: silently losing attribution would corrupt the
  learning claim.
- **Plan terms changed by time/payment:** approval revalidation rejects
  the plan instead of sending stale terms.
- **Free-tier sleep:** sweep workflow polls `/healthz` for up to about
  three minutes before failing.

## Security notes

- Ledger GraphQL requires `Authorization: Bearer <LEDGER_TOKEN>` when a
  token is configured. Production deployment must configure one.
- Human desk uses HTTP Basic with user `remit`; put it behind HTTPS from
  the hosting platform. It is an operator tool, not a public product UI.
- Secrets belong in platform secret stores/GitHub secrets, never in the
  repo or chat.
- Debtor replies are data, not instructions. Even if a model follows a
  malicious instruction embedded in a reply, code policy still blocks
  discounts, threats, over-contacting, and invalid plans.
- The system handles fictional B2B invoices only in this repository. A
  production deployment needs privacy, retention, consent, consumer-debt
  exclusion, and jurisdiction-specific legal review before use.
