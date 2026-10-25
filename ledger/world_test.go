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

func TestDashboardInvoiceDebtorAndManualPayments(t *testing.T) {
	svc := &Service{store: NewMemoryStore(42)}
	var beforeInvoices, beforeDebtors int
	_ = svc.view(func(st *State) {
		beforeInvoices = len(st.Invoices)
		beforeDebtors = len(st.Debtors)
	})

	createdID, err := svc.CreateInvoice("", "Dashboard Test Ltd", "Ap@Dashboard.example", 125050, 14)
	if err != nil {
		t.Fatal(err)
	}
	if createdID == "" {
		t.Fatal("expected a created invoice ID")
	}

	var debtorID string
	_ = svc.view(func(st *State) {
		if len(st.Invoices) != beforeInvoices+1 {
			t.Fatalf("invoice count = %d, want %d", len(st.Invoices), beforeInvoices+1)
		}
		if len(st.Debtors) != beforeDebtors+1 {
			t.Fatalf("debtor count = %d, want %d", len(st.Debtors), beforeDebtors+1)
		}
		inv := findInvoice(st, createdID)
		if inv == nil || inv.AmountCents != 125050 || inv.DueDay != 14 || inv.Status != "open" {
			t.Fatalf("unexpected created invoice: %+v", inv)
		}
		debtorID = inv.DebtorID
	})

	secondID, err := svc.CreateInvoice("", "Dashboard Test Ltd", "ap@dashboard.example", 1000, 20)
	if err != nil {
		t.Fatal(err)
	}
	_ = svc.view(func(st *State) {
		if len(st.Debtors) != beforeDebtors+1 {
			t.Fatalf("same client email created a duplicate debtor: %d", len(st.Debtors))
		}
		if inv := findInvoice(st, secondID); inv == nil || inv.DebtorID != debtorID {
			t.Fatalf("second invoice is on the wrong debtor: %+v", inv)
		}
	})

	if err := svc.UpdateDebtor(debtorID, "Renamed Dashboard Ltd", "billing@dashboard.example"); err != nil {
		t.Fatal(err)
	}
	if err := svc.RecordPayment(createdID, 25050, "part payment"); err != nil {
		t.Fatal(err)
	}
	if err := svc.RecordPayment(createdID, 100001, "too much"); err == nil {
		t.Fatal("expected overpayment to be rejected")
	}
	if err := svc.RecordPayment(createdID, 100000, "final payment"); err != nil {
		t.Fatal(err)
	}
	_ = svc.view(func(st *State) {
		debtor := findDebtor(st, debtorID)
		if debtor == nil || debtor.Name != "Renamed Dashboard Ltd" || debtor.Email != "billing@dashboard.example" {
			t.Fatalf("debtor edit did not stick: %+v", debtor)
		}
		inv := findInvoice(st, createdID)
		if inv == nil || inv.Status != "paid" || inv.PaidCents != inv.AmountCents {
			t.Fatalf("manual payments did not settle invoice: %+v", inv)
		}
	})
	if _, err := svc.CreateInvoice("", "No Money Ltd", "", 0, 1); err == nil {
		t.Fatal("expected non-positive invoice amount to be rejected")
	}
}
