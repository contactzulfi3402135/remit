package main

import "testing"

func TestResetDeterministic(t *testing.T) {
	a := generateWorld(42)
	b := generateWorld(42)
	if len(a.Invoices) != len(b.Invoices) {
		t.Fatalf("invoice count differs: %d vs %d", len(a.Invoices), len(b.Invoices))
	}
	var ta, tb int64
	for _, inv := range a.Invoices {
		ta += inv.AmountCents
	}
	for _, inv := range b.Invoices {
		tb += inv.AmountCents
	}
	if ta != tb {
		t.Fatalf("totals differ: %d vs %d", ta, tb)
	}
}

func TestDisputingNeverPaysOnContact(t *testing.T) {
	svc := &Service{store: NewMemoryStore(42)}
	var disputingID string
	_ = svc.view(func(st *State) {
		for _, inv := range st.Invoices {
			if d := findDebtor(st, inv.DebtorID); d != nil && d.Persona == "disputing" {
				disputingID = inv.ID
				break
			}
		}
	})
	if disputingID == "" {
		t.Fatal("no disputing invoice generated")
	}
	if err := svc.LogContact(disputingID, "formal-firm", "formal-firm", "Please pay."); err != nil {
		t.Fatal(err)
	}
	_ = svc.view(func(st *State) {
		inv := findInvoice(st, disputingID)
		if inv.Status != "disputed" {
			t.Fatalf("expected disputed, got %s", inv.Status)
		}
		if inv.PaidCents != 0 {
			t.Fatalf("disputing debtor paid %d on contact", inv.PaidCents)
		}
	})
}

func TestEscalatedInvoiceCanBeReturnedByHuman(t *testing.T) {
	svc := &Service{store: NewMemoryStore(11)}
	var id string
	_ = svc.view(func(st *State) { id = st.Invoices[0].ID })
	if err := svc.Escalate(id, "needs a person"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Reopen(id); err != nil {
		t.Fatal(err)
	}
	_ = svc.view(func(st *State) {
		if inv := findInvoice(st, id); inv == nil || inv.Status != "open" {
			t.Fatalf("expected reopened invoice, got %+v", inv)
		}
	})
}

func TestPlanMustTotalRemainingBalance(t *testing.T) {
	svc := &Service{store: NewMemoryStore(7)}
	var id string
	_ = svc.view(func(st *State) { id = st.Invoices[0].ID })
	if err := svc.CreatePlan(id, []Instalment{{Day: 5, AmountCents: 100}}); err == nil {
		t.Fatal("expected error for plan not totalling balance")
	}
}

func TestWorldCollectsSomethingOver60Days(t *testing.T) {
	svc := &Service{store: NewMemoryStore(20261023)}
	if _, err := svc.AdvanceDay(60); err != nil {
		t.Fatal(err)
	}
	_ = svc.view(func(st *State) {
		var collected, invoiced int64
		for _, inv := range st.Invoices {
			collected += inv.PaidCents
			invoiced += inv.AmountCents
		}
		if collected == 0 {
			t.Fatal("expected some spontaneous collection over 60 days")
		}
		if collected >= invoiced {
			t.Fatalf("world collected everything with no chasing (%d/%d); simulator too easy", collected, invoiced)
		}
	})
}
