# Remit

Remit is a B2B accounts-receivable agent. Its job is not to “write reminder
emails”; its job is to own an overdue-invoice workflow until money arrives,
a lawful payment plan is in place, or a person needs to take over.

Most dunning software sends the same sequence to everyone. Remit infers a
debtor segment from observable behaviour, experiments with three lawful
contact playbooks inside strict code policy, records which contact was
followed by payment, and gradually plays the winner for that segment. A
person handles disputes, opt-outs, distress, contact-cap cases, blocked
drafts, and payment plans above the configured balance limit.

## What this repository proves — and what it does not

This is a complete working system against a stand-in Go/GraphQL ledger.
The ledger simulates debtor behaviour so strategy can be measured without
touching real customers or money. Simulator persona labels exist only
inside the Go world generator; the GraphQL API does not expose them and
the agent never reads them.

The included evaluation proves the relative behaviour of the policies and
learning loop in that seeded simulator. It does **not** prove a real-world
collection rate, legal compliance for any particular jurisdiction, or that
a particular language model is profitable. Those require a real ERP,
sending channel, local legal review, and a measured pilot.

## Measured simulator result

The evaluator resets the same seeded world for three 60-day episodes:
**none** (never chase), **template** (fixed formal dunning calendar), and
**remit** (segmented playbooks + learning + the same policy rails). Each
episode starts with 67 invoices totalling **$446,068.50**.

Latest local run: 23 Oct 2026, `--draft-model baseline:rules`, seed
`20261023`, 5.7 seconds.

| Strategy | Collected by day 30 | Collected by day 60 | DSO(sim) | Contacts | Model cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| none | $200,969 (45.1%) | $243,764 (54.6%) | 52.1 | 0 | $0 |
| template | $342,174 (76.7%) | $376,070 (84.3%) | 42.6 | 128 | $0 |
| remit | $356,150 (79.8%) | $386,392 (86.6%) | 40.6 | 157 | $0 |

Against fixed-template dunning, Remit collected **$13,976 more by day 30**
and **$10,322 more by day 60**, and reduced DSO(sim) by **2.0 days**. It
used 29 more contacts to do so. That contact cost is part of the result,
not a footnote: a production pilot must price contact burden, human queue
time, model spend, complaints, and opt-outs alongside cash.

The $0 model cost is honest for this run because `baseline:rules` is a
deterministic no-model drafting path. It is not a claim that a hosted LLM
is free. Re-running the same evaluation after the attribution fix produced
identical scores and playbook statistics.

Full report: [`results/eval-baseline-seed-20261023.md`](results/eval-baseline-seed-20261023.md)
and [`results/eval-baseline-seed-20261023.json`](results/eval-baseline-seed-20261023.json).

## How one sweep works

1. Read ledger events since the saved cursor.
2. Handle replies before drafting anything new:
   - dispute/distress: suppress the invoice and queue it for a person;
   - opt-out: suppress it and queue acknowledgement; the review desk cannot
     resume an opt-out.
3. Attribute payments to contact trials (below).
4. For each open invoice in the action window, infer its debtor segment.
5. Choose a playbook with an epsilon-greedy bandit (15% exploration;
   untried playbooks first).
6. Draft one structured step with an LLM tool call, or with the
   deterministic baseline.
7. Pass the draft through deterministic policy. The model never writes
   directly to the ledger.
8. Log the contact or create the proposed plan, record the decision, and
   store a contact-trial row for later attribution.
9. In the stand-in deployment, advance the simulated world one day. A
   production ERP integration would remove that clock step.

## Segments and playbooks

Segments use only observable evidence:

- `new`
- `usually-pays`
- `slow-payer`
- `promised-before`
- `promise-broken`
- `silent`

Playbooks are all inside the same collection policy:

- `friendly-plan-early` — warm tone; may offer a payment plan early.
- `formal-firm` — factual business reminder; no threats.
- `friendly-remind-only` — brief oversight assumption; asks for payment or
  a promise date without offering a plan yet.

### Attribution rule

Reward data is stored in `remit.contact_trials`, one row per actual
contact. The row freezes the segment and playbook at contact time. A later
payment can reward only the latest contact inside a seven-day window, and
each contact can earn at most one binary reward. Partial and instalment
payments therefore cannot make `rewards > contacts`, and a segment change
after contact cannot move the denominator.

Remit also waits until a debtor’s own promised payment date has passed
before chasing again. That is both better practice and cleaner causality:
a follow-up should not steal credit for a promise created by the previous
contact.

## Policy rails

Policy lives in [`policy/collection.json`](policy/collection.json) and is
enforced in [`src/policy.ts`](src/policy.ts), not merely described to the
model.

Current configured limits:

- B2B invoices only; this code is not a consumer-debt product.
- At least 3 days between contacts on one invoice.
- At most 6 contacts per invoice, then a person takes over.
- Friendly action window begins 2 days before due date.
- No threats or banned phrases such as legal action, court, police, shame,
  “final warning”, or “or else”.
- No discounts or settle-for-less offers.
- Payment plans: at most 3 instalments; all inside 45 days; first
  instalment at least 25%; instalments must total the exact remaining
  balance.
- Balances above $5,000 require explicit human plan approval. The stored
  draft is revalidated against current balance/history before sending;
  human approval waives only that threshold, not the other rules.
- Disputes, opt-outs, lawyer/insolvency signals, blocked drafts, and
  escalations go to the human desk.
- Debtor text is untrusted data. Instructions inside a reply cannot widen
  the code gate.

There is deliberately no write-off tool, discount tool, legal-action tool,
or “ignore opt-out” button.

## Repository map

```text
src/
  cli.ts       sweep | eval | serve commands and model/budget flags
  engine.ts    one collection day; event handling and reward attribution
  strategy.ts  observed segments, epsilon-greedy playbook choice, trials
  draft.ts     LLM tool drafting + deterministic baseline drafting
  policy.ts    draft validation and deterministic collection gate
  ledger.ts    GraphQL client for the system of record
  evaluate.ts  isolated none/template/remit simulator episodes
  score.ts     cash-by-day, DSO(sim), contacts, and cost scoring
  server.ts    password-protected human desk
  db.ts        Postgres runs, calls, decisions, queue, trials, state

ledger/        Go GraphQL stand-in ledger + seeded debtor simulator
policy/        collection limits and banned phrases
db/migrations/ agent Postgres schema (separate from remit_ledger)
results/       committed evaluation reports
deploy/        agent Dockerfile and optional GCP deployment
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for data flow, invariants, and
failure behaviour.

## Run locally with Docker Compose

Requirements: Docker with Compose.

```bash
cp .env.example .env
# Edit .env and replace LEDGER_TOKEN / REVIEW_PASSWORD.
docker compose up --build
```

Open the human desk at <http://localhost:3000>. The username is `remit`;
the password is `REVIEW_PASSWORD`.

Run a sweep in another terminal:

```bash
docker compose exec agent node dist/src/cli.js sweep --draft-model baseline:rules --budget 1
```

## Run locally without Docker

Requirements: Node 22, Go (version in `ledger/go.mod`), and Postgres.

```bash
npm install
createdb remit

# Terminal 1: ledger using the same Postgres database
cd ledger
DATABASE_URL=postgres://remit:remit@localhost:5432/remit \
LEDGER_TOKEN=change-me PORT=8090 go run .

# Terminal 2: agent
DATABASE_URL=postgres://remit:remit@localhost:5432/remit \
LEDGER_URL=http://localhost:8090 LEDGER_TOKEN=change-me \
npm run seed

DATABASE_URL=postgres://remit:remit@localhost:5432/remit \
LEDGER_URL=http://localhost:8090 LEDGER_TOKEN=change-me \
DRAFT_MODEL=baseline:rules npm run sweep

DATABASE_URL=postgres://remit:remit@localhost:5432/remit \
LEDGER_URL=http://localhost:8090 LEDGER_TOKEN=change-me \
REVIEW_PASSWORD=change-me npm run serve
```

`npm run seed` is guarded: if the ledger already has invoices it does not
reseed. The Go Postgres store also creates the seeded world on first use;
the guard matters because `resetWorld` is destructive and must never be a
scheduled live operation.

## Evaluate

Use an in-memory ledger for evaluation so live data cannot be reset:

```bash
# Do not set DATABASE_URL for this ledger process.
cd ledger && LEDGER_TOKEN=ci-only-token PORT=8090 go run .

# From the repo root, with DATABASE_URL pointing at Postgres:
LEDGER_URL=http://localhost:8090 LEDGER_TOKEN=ci-only-token \
npx tsx src/cli.ts eval --draft-model baseline:rules --seed 20261023 --budget 5
```

The GitHub `remit-eval` workflow does the same isolation with a throwaway
Postgres service and an in-memory ledger. It never calls the deployed
live ledger.

## Model choice and budgets

Drafting accepts `provider:model` specs through `--draft-model` or
`DRAFT_MODEL`. Supported routes include xAI/Grok, Anthropic/Claude,
OpenAI, an OpenAI-compatible OSS endpoint (`oss:...` + `OSS_BASE_URL`),
and `baseline:rules`.

Examples:

```bash
npx tsx src/cli.ts sweep --draft-model baseline:rules --budget 1
npx tsx src/cli.ts sweep --draft-model oss:openai/gpt-oss-20b --budget 1
npx tsx src/cli.ts eval  --draft-model Claude:claude-sonnet-4-5 --budget 5
```

Every model call is recorded with model, invoice ids, tokens, latency,
cost, and error. If a model repeatedly returns an unusable structured
draft, Remit escalates that invoice for a person to draft; bad model text
is not sent as a fallback.

## Permanent free deployment shape

The intended no-card route is:

- **Neon Postgres** for both the normalized `remit` agent schema and the
  stand-in `remit_ledger` snapshot schema.
- **Render free web service `remit-ledger`** from `ledger/Dockerfile`.
- **Render free web service `remit-review`** from
  `deploy/Dockerfile.agent`.
- **GitHub Actions `remit-sweep`** hourly. One sweep equals one simulated
  business day in this stand-in deployment.
- **GitHub Actions `remit-eval`** manually, fully isolated from live.

[`render.yaml`](render.yaml) describes both services. After the first
deploy, set the review service’s `LEDGER_URL` to the public ledger URL and
copy the same `LEDGER_TOKEN` into the review service and GitHub secrets.
GitHub sweep calls the one deployed ledger; it does not start a second
ledger writer.

Free Render services sleep when idle and can take about a minute to wake.
That delay is visible in the sweep workflow’s wake-up step.

If any provider asks for card details during setup, stop; the route above
is specifically the no-card route used for this portfolio deployment.

## Optional GCP deployment

[`deploy/gcp.sh`](deploy/gcp.sh) builds both images, stores secrets in
Secret Manager, deploys the ledger and desk to Cloud Run, creates a Cloud
Run sweep job, and schedules it hourly. It is scripted but **not run** for
the free deployment above. Google Cloud requires a billing account even
if a workload stays within free allowances.

## Tests

```bash
npm run check
npm test
cd ledger && go vet ./... && go test ./...
```

Current local verification on 23 Oct 2026:

- TypeScript type-check: clean.
- TypeScript tests: 15/15.
- Go `vet`: clean; Go tests pass.
- Local integration: seeded ledger, 3 baseline sweeps, contact-trial
  rewards, over-limit human plan approval, dispute resolution, opt-out
  resume rejection, and Postgres ledger restart persistence.

## Failure modes and kill criteria

Important limitations are listed rather than hidden:

- The stand-in ledger persists one JSON world snapshot and assumes one
  authoritative ledger process. That is acceptable for a simulator, not
  a design for a production ERP.
- Reply classification is deterministic keyword matching. It is safe-side
  biased toward humans, but synonyms can be missed.
- Contacts are ledger events, not real email/WhatsApp sends. A production
  adapter needs consent records, deliverability, idempotency keys at the
  provider boundary, bounce handling, and jurisdiction-specific review.
- Bandit rewards measure correlation inside a seven-day latest-touch
  window, not proof that a particular message caused payment.
- Simulator behaviour rules are disclosed in `ledger/world.go`; tuning to
  them too aggressively would be overfitting. Segment and promise rules
  were therefore kept observable and operationally defensible.

Stop or roll back a real pilot if any of these occur:

- incremental cash versus a fixed-sequence holdout is not positive after
  model, sending, and human-review costs over the agreed pilot window;
- opt-outs/complaints rise above the operator’s pre-set threshold;
- any contact is sent after an opt-out or during an unresolved dispute;
- reward/contact accounting violates `rewards <= contacts` for any
  segment/playbook;
- model draft failure or queue age makes human review the bottleneck
  rather than the safeguard.

Remit’s value claim is therefore narrow and testable: lawful playbook
learning collected cash earlier than a fixed sequence in this seeded
world, with the extra contact burden and all simulator limits in plain
sight.
