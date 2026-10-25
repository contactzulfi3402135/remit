package main

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/rand"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// The stand-in accounts-receivable world. In production this box is the
// customer's ERP/billing system; here it also carries a small debtor
// behaviour simulator so agent strategy can be measured honestly.
// Personas are world-private: the GraphQL API never exposes them, the
// agent must infer segments from observable behaviour.

type Debtor struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Email   string `json:"email"`
	Persona string `json:"persona"` // internal only; never in GraphQL output
}

type Invoice struct {
	ID              string `json:"id"`
	DebtorID        string `json:"debtor_id"`
	AmountCents     int64  `json:"amount_cents"`
	PaidCents       int64  `json:"paid_cents"`
	IssuedDay       int    `json:"issued_day"`
	DueDay          int    `json:"due_day"`
	Status          string `json:"status"` // open | paid | disputed | escalated
	PaidDay         *int   `json:"paid_day,omitempty"`
	DisputeResolved bool   `json:"dispute_resolved,omitempty"`
}

type Event struct {
	ID        int64  `json:"id"`
	InvoiceID string `json:"invoice_id"`
	Day       int    `json:"day"`
	Kind      string `json:"kind"`
	Detail    string `json:"detail"`
}

type Instalment struct {
	Day         int   `json:"day"`
	AmountCents int64 `json:"amount_cents"`
	Paid        bool  `json:"paid"`
}

type Plan struct {
	InvoiceID   string       `json:"invoice_id"`
	Instalments []Instalment `json:"instalments"`
	Accepted    bool         `json:"accepted"`
}

type State struct {
	Day         int            `json:"day"`
	Seed        int64          `json:"seed"`
	Debtors     []Debtor       `json:"debtors"`
	Invoices    []Invoice      `json:"invoices"`
	Events      []Event        `json:"events"`
	Plans       []Plan         `json:"plans"`
	NextEventID int64          `json:"next_event_id"`
	Contacts    map[string]int `json:"contacts"`
}

type personaParams struct {
	payOnContact float64
	dailyPay     float64
	replyProb    float64
	planAccept   float64
	planPay      float64
	promiseKeep  float64
}

var personas = map[string]personaParams{
	"forgetful":  {payOnContact: 0.50, dailyPay: 0.030, replyProb: 0.55, planAccept: 0.35, planPay: 0.65, promiseKeep: 0.60},
	"reliable":   {payOnContact: 0.35, dailyPay: 0.180, replyProb: 0.65, planAccept: 0.45, planPay: 0.90, promiseKeep: 0.90},
	"cash_tight": {payOnContact: 0.06, dailyPay: 0.015, replyProb: 0.55, planAccept: 0.80, planPay: 0.80, promiseKeep: 0.55},
	"chronic":    {payOnContact: 0.14, dailyPay: 0.025, replyProb: 0.35, planAccept: 0.55, planPay: 0.55, promiseKeep: 0.35},
	"disputing":  {payOnContact: 0.00, dailyPay: 0.000, replyProb: 0.90, planAccept: 0.00, planPay: 0.00, promiseKeep: 0.00},
	"ghost":      {payOnContact: 0.02, dailyPay: 0.004, replyProb: 0.05, planAccept: 0.05, planPay: 0.10, promiseKeep: 0.10},
}

var companyNames = []string{
	"Northwind Traders", "Blue Peak Logistics", "Harbor Foods Ltd", "Vertex Components",
	"Cedar & Co Retail", "Milestone Fitness", "Orbit Media Group", "Pioneer Auto Parts",
	"Silverline Hotels", "Greenfield Farms", "Quantum Office Supply", "Beacon Legal LLP",
	"Atlas Construction", "Nova Health Clinics", "Riverbend Brewing", "Summit Events",
	"Cloudberry Software", "Ironwood Furniture", "Pacific Marine Supply", "Golden Gate Grocers",
	"Redstone Mining", "Willow Creek Schools", "Metro Print Works", "Alpine Outdoor Gear",
}

func roll(seed int64, invoiceID, kind string, counter, day int) float64 {
	h := fnv.New64a()
	fmt.Fprintf(h, "%d|%s|%s|%d|%d", seed, invoiceID, kind, counter, day)
	return float64(h.Sum64()>>11) / float64(1<<53)
}

func generateWorld(seed int64) *State {
	rng := rand.New(rand.NewSource(seed))
	personaCycle := []string{
		"forgetful", "reliable", "cash_tight", "forgetful", "chronic", "reliable",
		"forgetful", "cash_tight", "disputing", "reliable", "forgetful", "cash_tight",
		"ghost", "reliable", "chronic", "forgetful", "cash_tight", "disputing",
		"reliable", "forgetful", "cash_tight", "chronic", "ghost", "disputing",
	}
	st := &State{Day: 0, Seed: seed, NextEventID: 1, Contacts: map[string]int{}}
	invN := 0
	for i, persona := range personaCycle {
		d := Debtor{
			ID:      fmt.Sprintf("d%03d", i+1),
			Name:    companyNames[i%len(companyNames)],
			Email:   fmt.Sprintf("ap@debtor-%d.example", i+1),
			Persona: persona,
		}
		st.Debtors = append(st.Debtors, d)
		n := 2 + rng.Intn(3)
		for j := 0; j < n; j++ {
			invN++
			amount := int64(20000 + rng.Intn(1180000))
			due := -10 + rng.Intn(29)
			st.Invoices = append(st.Invoices, Invoice{
				ID:          fmt.Sprintf("inv-%03d", invN),
				DebtorID:    d.ID,
				AmountCents: amount,
				IssuedDay:   due - 30,
				DueDay:      due,
				Status:      "open",
			})
		}
	}
	sort.Slice(st.Invoices, func(a, b int) bool { return st.Invoices[a].ID < st.Invoices[b].ID })
	return st
}

// Service serialises every world mutation. A single-process lock is the
// honest scope of a stand-in ledger; the agent side is built for a real
// external API and never relies on this lock.
type Service struct {
	mu    sync.Mutex
	store Store
}

func (s *Service) withState(fn func(st *State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.store.Load()
	if err != nil {
		return err
	}
	if err := fn(st); err != nil {
		return err
	}
	return s.store.Save(st)
}

func (s *Service) view(fn func(st *State)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.store.Load()
	if err != nil {
		return err
	}
	fn(st)
	return nil
}

func findInvoice(st *State, id string) *Invoice {
	for i := range st.Invoices {
		if st.Invoices[i].ID == id {
			return &st.Invoices[i]
		}
	}
	return nil
}
func findDebtor(st *State, id string) *Debtor {
	for i := range st.Debtors {
		if st.Debtors[i].ID == id {
			return &st.Debtors[i]
		}
	}
	return nil
}
func (st *State) addEvent(invoiceID, kind, detail string) {
	st.Events = append(st.Events, Event{ID: st.NextEventID, InvoiceID: invoiceID, Day: st.Day, Kind: kind, Detail: detail})
	st.NextEventID++
}
func (st *State) planFor(invoiceID string) *Plan {
	for i := range st.Plans {
		if st.Plans[i].InvoiceID == invoiceID && st.Plans[i].Accepted {
			return &st.Plans[i]
		}
	}
	return nil
}
func (st *State) pay(inv *Invoice, cents int64, note string) {
	if cents <= 0 {
		return
	}
	inv.PaidCents += cents
	st.addEvent(inv.ID, "payment", fmt.Sprintf("%s (%d cents)", note, cents))
	if inv.PaidCents >= inv.AmountCents && inv.Status != "paid" {
		inv.Status = "paid"
		d := st.Day
		inv.PaidDay = &d
	}
}

func (s *Service) Reset(seed int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.store.Save(generateWorld(seed))
}

func (s *Service) LogContact(invoiceID, playbook, tone, message string) error {
	return s.withState(func(st *State) error {
		inv := findInvoice(st, invoiceID)
		if inv == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		if inv.Status == "paid" {
			return fmt.Errorf("invoice %s is already paid", invoiceID)
		}
		debtor := findDebtor(st, inv.DebtorID)
		params := personas[debtor.Persona]
		st.Contacts[invoiceID]++
		count := st.Contacts[invoiceID]
		detail, _ := json.Marshal(map[string]string{"playbook": playbook, "tone": tone, "message": message})
		st.addEvent(invoiceID, "contact", string(detail))

		if debtor.Persona == "disputing" && !inv.DisputeResolved {
			inv.Status = "disputed"
			st.addEvent(invoiceID, "reply", "We dispute this invoice: the amount is wrong and does not match our order. Please investigate before contacting us again.")
			return nil
		}
		if inv.Status == "disputed" {
			return nil
		}

		prob := params.payOnContact
		if playbook == "formal-firm" && debtor.Persona == "chronic" {
			prob += 0.08
		}
		if st.planFor(invoiceID) != nil {
			prob += 0.05
		}
		// Harassment backfires in this world, as in the real one.
		recent := 0
		for _, e := range st.Events {
			if e.InvoiceID == invoiceID && e.Kind == "contact" && st.Day-e.Day < 3 {
				recent++
			}
		}
		if recent > 1 {
			prob *= 0.5
		}

		if roll(st.Seed, invoiceID, "contact-pay", count, st.Day) < prob {
			st.pay(inv, inv.AmountCents-inv.PaidCents, "paid after contact")
			return nil
		}
		if roll(st.Seed, invoiceID, "contact-reply", count, st.Day) < params.replyProb {
			if count >= 5 && roll(st.Seed, invoiceID, "optout", count, st.Day) < 0.25 {
				st.addEvent(invoiceID, "reply", "Stop contacting us about this. Do not contact this address again.")
				return nil
			}
			promiseDay := st.Day + 3 + int(roll(st.Seed, invoiceID, "promise-day", count, st.Day)*4)
			pd, _ := json.Marshal(map[string]int{"day": promiseDay})
			st.addEvent(invoiceID, "promise", string(pd))
			st.addEvent(invoiceID, "reply", fmt.Sprintf("Apologies for the delay. We will pay invoice %s by day %d.", invoiceID, promiseDay))
		}
		return nil
	})
}

func (s *Service) CreatePlan(invoiceID string, instalments []Instalment) error {
	return s.withState(func(st *State) error {
		inv := findInvoice(st, invoiceID)
		if inv == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		remaining := inv.AmountCents - inv.PaidCents
		var total int64
		for _, in := range instalments {
			total += in.AmountCents
		}
		if total != remaining {
			return fmt.Errorf("plan totals %d but remaining balance is %d", total, remaining)
		}
		debtor := findDebtor(st, inv.DebtorID)
		params := personas[debtor.Persona]
		count := st.Contacts[invoiceID]
		if debtor.Persona == "disputing" && !inv.DisputeResolved {
			inv.Status = "disputed"
			st.addEvent(invoiceID, "reply", "We dispute this invoice: wrong amount. A payment plan for a disputed invoice is not acceptable.")
			return nil
		}
		if roll(st.Seed, invoiceID, "plan-accept", count, st.Day) < params.planAccept {
			st.Plans = append(st.Plans, Plan{InvoiceID: invoiceID, Instalments: instalments, Accepted: true})
			st.addEvent(invoiceID, "plan_accepted", fmt.Sprintf("Plan accepted: %d instalments totalling %d cents", len(instalments), total))
			st.addEvent(invoiceID, "reply", "The proposed payment plan works for us. We accept the schedule.")
		} else {
			st.addEvent(invoiceID, "reply", "We cannot commit to that payment plan right now.")
		}
		return nil
	})
}

func (s *Service) RecordPromise(invoiceID string, day int) error {
	return s.withState(func(st *State) error {
		if findInvoice(st, invoiceID) == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		pd, _ := json.Marshal(map[string]int{"day": day})
		st.addEvent(invoiceID, "promise", string(pd))
		return nil
	})
}

func (s *Service) Escalate(invoiceID, reason string) error {
	return s.withState(func(st *State) error {
		inv := findInvoice(st, invoiceID)
		if inv == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		if inv.Status == "open" {
			inv.Status = "escalated"
		}
		st.addEvent(invoiceID, "escalation", reason)
		return nil
	})
}

func (s *Service) Reopen(invoiceID string) error {
	return s.withState(func(st *State) error {
		inv := findInvoice(st, invoiceID)
		if inv == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		if inv.Status == "paid" || inv.Status == "disputed" {
			return fmt.Errorf("invoice %s is %s and cannot be reopened this way", invoiceID, inv.Status)
		}
		inv.Status = "open"
		st.addEvent(invoiceID, "note", "Returned to automated collection by a human.")
		return nil
	})
}

func (s *Service) ResolveDispute(invoiceID string) error {
	return s.withState(func(st *State) error {
		inv := findInvoice(st, invoiceID)
		if inv == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		inv.DisputeResolved = true
		if inv.Status == "disputed" {
			inv.Status = "open"
		}
		st.addEvent(invoiceID, "note", "Dispute investigated and resolved by a human; invoice confirmed correct.")
		return nil
	})
}

func numericSuffix(id, prefix string) int {
	if !strings.HasPrefix(id, prefix) {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimPrefix(id, prefix))
	return n
}

func nextID(ids []string, prefix string) string {
	max := 0
	for _, id := range ids {
		if n := numericSuffix(id, prefix); n > max {
			max = n
		}
	}
	return fmt.Sprintf("%s%03d", prefix, max+1)
}

// CreateInvoice is the dashboard/ERP write path for a new client invoice.
// A manually created simulated debtor receives a hidden ordinary
// behaviour profile; the dashboard and agent still cannot see personas.
func (s *Service) CreateInvoice(debtorID, debtorName, debtorEmail string, amountCents int64, dueDay int) (string, error) {
	createdID := ""
	err := s.withState(func(st *State) error {
		if amountCents <= 0 {
			return fmt.Errorf("amountCents must be positive")
		}
		debtorName = strings.TrimSpace(debtorName)
		debtorEmail = strings.TrimSpace(debtorEmail)
		var debtor *Debtor
		if strings.TrimSpace(debtorID) != "" {
			debtor = findDebtor(st, strings.TrimSpace(debtorID))
			if debtor == nil {
				return fmt.Errorf("unknown debtor %s", debtorID)
			}
		} else {
			if debtorEmail != "" {
				for i := range st.Debtors {
					if strings.EqualFold(st.Debtors[i].Email, debtorEmail) {
						debtor = &st.Debtors[i]
						break
					}
				}
			}
			if debtor == nil && debtorName != "" {
				for i := range st.Debtors {
					if strings.EqualFold(st.Debtors[i].Name, debtorName) {
						debtor = &st.Debtors[i]
						break
					}
				}
			}
			if debtor == nil {
				if debtorName == "" {
					return fmt.Errorf("debtorName is required for a new debtor")
				}
				debtorIDs := make([]string, 0, len(st.Debtors))
				for _, d := range st.Debtors {
					debtorIDs = append(debtorIDs, d.ID)
				}
				newID := nextID(debtorIDs, "d")
				if debtorEmail == "" {
					debtorEmail = fmt.Sprintf("ap@debtor-%d.example", numericSuffix(newID, "d"))
				}
				personaCycle := []string{"forgetful", "reliable", "cash_tight", "chronic"}
				st.Debtors = append(st.Debtors, Debtor{
					ID:      newID,
					Name:    debtorName,
					Email:   debtorEmail,
					Persona: personaCycle[len(st.Debtors)%len(personaCycle)],
				})
				debtor = &st.Debtors[len(st.Debtors)-1]
			}
		}

		invoiceIDs := make([]string, 0, len(st.Invoices))
		for _, inv := range st.Invoices {
			invoiceIDs = append(invoiceIDs, inv.ID)
		}
		createdID = nextID(invoiceIDs, "inv-")
		st.Invoices = append(st.Invoices, Invoice{
			ID:          createdID,
			DebtorID:    debtor.ID,
			AmountCents: amountCents,
			IssuedDay:   dueDay - 30,
			DueDay:      dueDay,
			Status:      "open",
		})
		sort.Slice(st.Invoices, func(a, b int) bool {
			na, nb := numericSuffix(st.Invoices[a].ID, "inv-"), numericSuffix(st.Invoices[b].ID, "inv-")
			if na != nb {
				return na < nb
			}
			return st.Invoices[a].ID < st.Invoices[b].ID
		})
		st.addEvent(createdID, "note", "Invoice created from the dashboard.")
		return nil
	})
	return createdID, err
}

func (s *Service) UpdateDebtor(debtorID, name, email string) error {
	return s.withState(func(st *State) error {
		debtor := findDebtor(st, debtorID)
		if debtor == nil {
			return fmt.Errorf("unknown debtor %s", debtorID)
		}
		name = strings.TrimSpace(name)
		email = strings.TrimSpace(email)
		if name == "" {
			return fmt.Errorf("name is required")
		}
		if email == "" || !strings.Contains(email, "@") {
			return fmt.Errorf("a valid-looking email is required")
		}
		debtor.Name = name
		debtor.Email = email
		return nil
	})
}

// RecordPayment records money received outside the simulated debtor
// reactions (for example, a bank transfer entered by an operator).
func (s *Service) RecordPayment(invoiceID string, amountCents int64, note string) error {
	return s.withState(func(st *State) error {
		inv := findInvoice(st, invoiceID)
		if inv == nil {
			return fmt.Errorf("unknown invoice %s", invoiceID)
		}
		if inv.Status == "paid" {
			return fmt.Errorf("invoice %s is already paid", invoiceID)
		}
		if inv.Status == "disputed" {
			return fmt.Errorf("resolve the dispute before recording a payment")
		}
		remaining := inv.AmountCents - inv.PaidCents
		if amountCents <= 0 || amountCents > remaining {
			return fmt.Errorf("payment must be between 1 and the remaining %d cents", remaining)
		}
		note = strings.TrimSpace(note)
		if note == "" {
			note = "Manual payment recorded from the dashboard"
		}
		st.pay(inv, amountCents, note)
		return nil
	})
}

func (s *Service) AdvanceDay(days int) (int, error) {
	out := 0
	err := s.withState(func(st *State) error {
		for d := 0; d < days; d++ {
			st.Day++
			for i := range st.Invoices {
				inv := &st.Invoices[i]
				if inv.Status == "paid" || inv.Status == "disputed" {
					continue
				}
				debtor := findDebtor(st, inv.DebtorID)
				params := personas[debtor.Persona]
				// Plan instalments due today.
				if plan := st.planFor(inv.ID); plan != nil {
					for j := range plan.Instalments {
						in := &plan.Instalments[j]
						if !in.Paid && in.Day <= st.Day {
							if roll(st.Seed, inv.ID, "plan-pay", j, st.Day) < params.planPay {
								in.Paid = true
								st.pay(inv, in.AmountCents, "plan instalment paid")
							}
						}
					}
					if inv.Status == "paid" {
						continue
					}
				}
				// Promises due today.
				promisedToday := false
				for _, e := range st.Events {
					if e.InvoiceID == inv.ID && e.Kind == "promise" {
						var pd map[string]int
						if json.Unmarshal([]byte(e.Detail), &pd) == nil && pd["day"] == st.Day {
							promisedToday = true
						}
					}
				}
				if promisedToday && roll(st.Seed, inv.ID, "promise-keep", st.Day, st.Day) < params.promiseKeep {
					st.pay(inv, inv.AmountCents-inv.PaidCents, "promise kept")
					continue
				}
				// Spontaneous payment.
				prob := params.dailyPay
				if inv.DisputeResolved {
					prob = 0.25
				}
				if debtor.Persona == "reliable" && st.Day == inv.DueDay {
					prob = 0.75
				}
				if st.Day > inv.DueDay && roll(st.Seed, inv.ID, "daily", st.Day, st.Day) < prob {
					st.pay(inv, inv.AmountCents-inv.PaidCents, "paid without prompting")
				}
			}
		}
		out = st.Day
		return nil
	})
	return out, err
}
