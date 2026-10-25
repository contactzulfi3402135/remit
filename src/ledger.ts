// Client for the Go ledger service: the accounts-receivable system of
// record (a stand-in for an ERP/QuickBooks-like API). The agent never
// sees debtor "persona" data — the API does not expose it — because in
// production there is no such label to peek at. Segments are inferred
// from observable payment behaviour only.

export type Invoice = {
  id: string;
  debtorId: string;
  debtorName: string;
  amountCents: number;
  paidCents: number;
  issuedDay: number;
  dueDay: number;
  status: 'open' | 'paid' | 'disputed' | 'escalated';
  paidDay: number | null;
};

export type LedgerEvent = {
  id: number;
  invoiceId: string;
  day: number;
  kind: 'contact' | 'reply' | 'payment' | 'promise' | 'plan' | 'plan_accepted' | 'escalation' | 'note';
  detail: string;
};

export type Debtor = { id: string; name: string; email: string };
export type LedgerStats = { worldDay: number; invoicedCents: number; collectedCents: number; openCount: number; paidCount: number };

const INVOICE_FIELDS = 'id debtorId debtorName amountCents paidCents issuedDay dueDay status paidDay';

export class Ledger {
  constructor(private baseUrl: string, private token: string | undefined) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`ledger HTTP ${res.status}`);
    const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Error(`ledger: ${body.errors[0].message}`);
    if (!body.data) throw new Error('ledger: empty response');
    return body.data;
  }

  async stats(): Promise<LedgerStats> {
    const d = await this.gql<{ stats: LedgerStats }>(`query { stats { worldDay invoicedCents collectedCents openCount paidCount } }`);
    return d.stats;
  }

  async debtors(): Promise<Debtor[]> {
    const d = await this.gql<{ debtors: Debtor[] }>(`query { debtors { id name email } }`);
    return d.debtors;
  }

  async openInvoices(limit = 200): Promise<Invoice[]> {
    const d = await this.gql<{ invoices: Invoice[] }>(
      `query($status: String, $limit: Int) { invoices(status: $status, limit: $limit) { ${INVOICE_FIELDS} } }`,
      { status: 'open', limit });
    return d.invoices;
  }

  async allInvoices(limit = 500): Promise<Invoice[]> {
    const d = await this.gql<{ invoices: Invoice[] }>(
      `query($limit: Int) { invoices(limit: $limit) { ${INVOICE_FIELDS} } }`, { limit });
    return d.invoices;
  }

  async invoice(id: string): Promise<Invoice | null> {
    const d = await this.gql<{ invoice: Invoice | null }>(`query($id: String!) { invoice(id: $id) { ${INVOICE_FIELDS} } }`, { id });
    return d.invoice;
  }

  async debtorInvoices(debtorId: string): Promise<Invoice[]> {
    const d = await this.gql<{ debtorInvoices: Invoice[] }>(
      `query($debtorId: String!) { debtorInvoices(debtorId: $debtorId) { ${INVOICE_FIELDS} } }`, { debtorId });
    return d.debtorInvoices;
  }

  async eventsAfter(afterId: number, limit = 500): Promise<LedgerEvent[]> {
    const d = await this.gql<{ events: LedgerEvent[] }>(
      `query($afterId: Int, $limit: Int) { events(afterId: $afterId, limit: $limit) { id invoiceId day kind detail } }`,
      { afterId, limit });
    return d.events;
  }

  async allEvents(maxEvents = 10_000): Promise<LedgerEvent[]> {
    const out: LedgerEvent[] = [];
    let afterId = 0;
    while (out.length < maxEvents) {
      const batch = await this.eventsAfter(afterId, 500);
      if (!batch.length) break;
      out.push(...batch);
      afterId = batch[batch.length - 1].id;
      if (batch.length < 500) break;
    }
    return out.slice(0, maxEvents);
  }

  async invoiceEvents(invoiceId: string): Promise<LedgerEvent[]> {
    const d = await this.gql<{ invoiceEvents: LedgerEvent[] }>(
      `query($invoiceId: String!) { invoiceEvents(invoiceId: $invoiceId) { id invoiceId day kind detail } }`, { invoiceId });
    return d.invoiceEvents;
  }

  async createInvoice(input: { debtorId?: string; debtorName?: string; debtorEmail?: string; amountCents: number; dueDay: number }): Promise<string> {
    const d = await this.gql<{ createInvoice: string }>(
      `mutation($debtorId: String, $debtorName: String, $debtorEmail: String, $amountCents: Int!, $dueDay: Int!) {
         createInvoice(debtorId: $debtorId, debtorName: $debtorName, debtorEmail: $debtorEmail, amountCents: $amountCents, dueDay: $dueDay) }`,
      input);
    return d.createInvoice;
  }

  async updateDebtor(debtorId: string, name: string, email: string): Promise<boolean> {
    const d = await this.gql<{ updateDebtor: boolean }>(
      `mutation($debtorId: String!, $name: String!, $email: String!) {
         updateDebtor(debtorId: $debtorId, name: $name, email: $email) }`,
      { debtorId, name, email });
    return d.updateDebtor;
  }

  async recordPayment(invoiceId: string, amountCents: number, note = ''): Promise<boolean> {
    const d = await this.gql<{ recordPayment: boolean }>(
      `mutation($invoiceId: String!, $amountCents: Int!, $note: String) {
         recordPayment(invoiceId: $invoiceId, amountCents: $amountCents, note: $note) }`,
      { invoiceId, amountCents, note });
    return d.recordPayment;
  }

  async logContact(invoiceId: string, playbook: string, tone: string, message: string): Promise<boolean> {
    const d = await this.gql<{ logContact: boolean }>(
      `mutation($invoiceId: String!, $playbook: String!, $tone: String!, $message: String!) {
         logContact(invoiceId: $invoiceId, playbook: $playbook, tone: $tone, message: $message) }`,
      { invoiceId, playbook, tone, message });
    return d.logContact;
  }

  async createPlan(invoiceId: string, instalments: Array<{ day: number; amountCents: number }>): Promise<boolean> {
    const d = await this.gql<{ createPlan: boolean }>(
      `mutation($invoiceId: String!, $instalments: [InstalmentInput!]!) {
         createPlan(invoiceId: $invoiceId, instalments: $instalments) }`,
      { invoiceId, instalments });
    return d.createPlan;
  }

  async recordPromise(invoiceId: string, day: number): Promise<boolean> {
    const d = await this.gql<{ recordPromise: boolean }>(
      `mutation($invoiceId: String!, $day: Int!) { recordPromise(invoiceId: $invoiceId, day: $day) }`,
      { invoiceId, day });
    return d.recordPromise;
  }

  async escalate(invoiceId: string, reason: string): Promise<boolean> {
    const d = await this.gql<{ escalate: boolean }>(
      `mutation($invoiceId: String!, $reason: String!) { escalate(invoiceId: $invoiceId, reason: $reason) }`,
      { invoiceId, reason });
    return d.escalate;
  }

  async reopen(invoiceId: string): Promise<boolean> {
    const d = await this.gql<{ reopen: boolean }>(
      `mutation($invoiceId: String!) { reopen(invoiceId: $invoiceId) }`, { invoiceId });
    return d.reopen;
  }

  async resolveDispute(invoiceId: string): Promise<boolean> {
    const d = await this.gql<{ resolveDispute: boolean }>(
      `mutation($invoiceId: String!) { resolveDispute(invoiceId: $invoiceId) }`, { invoiceId });
    return d.resolveDispute;
  }

  async advanceDay(days = 1): Promise<number> {
    const d = await this.gql<{ advanceDay: number }>(`mutation($days: Int!) { advanceDay(days: $days) }`, { days });
    return d.advanceDay;
  }

  async resetWorld(seed: number): Promise<boolean> {
    const d = await this.gql<{ resetWorld: boolean }>(`mutation($seed: Int!) { resetWorld(seed: $seed) }`, { seed });
    return d.resetWorld;
  }
}

export type LatestPromise = {
  event: LedgerEvent;
  promisedDay: number;
  paymentAfter: boolean;
};

export function promisedDay(event: LedgerEvent): number | null {
  if (event.kind !== 'promise') return null;
  try {
    const parsed = JSON.parse(event.detail) as { day?: unknown };
    return Number.isInteger(parsed.day) ? Number(parsed.day) : null;
  } catch {
    return null;
  }
}

export function latestPromise(events: LedgerEvent[]): LatestPromise | null {
  let latest: LatestPromise | null = null;
  for (const event of events) {
    const day = promisedDay(event);
    if (day !== null && (!latest || event.id > latest.event.id)) {
      latest = { event, promisedDay: day, paymentAfter: false };
    }
  }
  if (!latest) return null;
  latest.paymentAfter = events.some((event) => event.kind === 'payment' && event.id > latest.event.id);
  return latest;
}

export function remainingCents(inv: Invoice): number {
  return Math.max(0, inv.amountCents - inv.paidCents);
}
export function daysOverdue(inv: Invoice, worldDay: number): number {
  return worldDay - inv.dueDay;
}
