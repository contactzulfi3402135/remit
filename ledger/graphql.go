package main

import (
	"github.com/graphql-go/graphql"
)

// GraphQL surface. Note what is deliberately missing: no persona field
// exists anywhere a client can read. Behaviour labels are world-private.

var invoiceType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Invoice",
	Fields: graphql.Fields{
		"id":          &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Invoice).ID, nil }},
		"debtorId":    &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Invoice).DebtorID, nil }},
		"amountCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Invoice).AmountCents), nil }},
		"paidCents":   &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Invoice).PaidCents), nil }},
		"issuedDay":   &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Invoice).IssuedDay, nil }},
		"dueDay":      &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Invoice).DueDay, nil }},
		"status":      &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Invoice).Status, nil }},
		"paidDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
			if p.Source.(Invoice).PaidDay == nil {
				return nil, nil
			}
			return *p.Source.(Invoice).PaidDay, nil
		}},
	},
})

var debtorType = graphql.NewObject(graphql.ObjectConfig{
	Name: "Debtor",
	Fields: graphql.Fields{
		"id":    &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Debtor).ID, nil }},
		"name":  &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Debtor).Name, nil }},
		"email": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Debtor).Email, nil }},
	},
})

var eventType = graphql.NewObject(graphql.ObjectConfig{
	Name: "LedgerEvent",
	Fields: graphql.Fields{
		"id":        &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return int(p.Source.(Event).ID), nil }},
		"invoiceId": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).InvoiceID, nil }},
		"day":       &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).Day, nil }},
		"kind":      &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).Kind, nil }},
		"detail":    &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(Event).Detail, nil }},
	},
})

type statsView struct {
	WorldDay       int
	InvoicedCents  int64
	CollectedCents int64
	OpenCount      int
	PaidCount      int
}

var statsType = graphql.NewObject(graphql.ObjectConfig{
	Name: "LedgerStats",
	Fields: graphql.Fields{
		"worldDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(statsView).WorldDay, nil }},
		"invoicedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
			return int(p.Source.(statsView).InvoicedCents), nil
		}},
		"collectedCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
			return int(p.Source.(statsView).CollectedCents), nil
		}},
		"openCount": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(statsView).OpenCount, nil }},
		"paidCount": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(statsView).PaidCount, nil }},
	},
})

var instalmentInput = graphql.NewInputObject(graphql.InputObjectConfig{
	Name: "InstalmentInput",
	Fields: graphql.InputObjectConfigFieldMap{
		"day":         &graphql.InputObjectFieldConfig{Type: graphql.NewNonNull(graphql.Int)},
		"amountCents": &graphql.InputObjectFieldConfig{Type: graphql.NewNonNull(graphql.Int)},
	},
})

func withDebtorName(st *State, inv Invoice) Invoice { return inv }

func buildSchema(svc *Service) (graphql.Schema, error) {
	// debtorName is joined at resolve time via a wrapper type.
	invoiceWithName := graphql.NewObject(graphql.ObjectConfig{
		Name: "InvoiceWithName",
		Fields: graphql.Fields{
			"id": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(namedInvoice).Invoice.ID, nil }},
			"debtorId": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				return p.Source.(namedInvoice).Invoice.DebtorID, nil
			}},
			"debtorName": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(namedInvoice).Name, nil }},
			"amountCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				return int(p.Source.(namedInvoice).Invoice.AmountCents), nil
			}},
			"paidCents": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				return int(p.Source.(namedInvoice).Invoice.PaidCents), nil
			}},
			"issuedDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				return p.Source.(namedInvoice).Invoice.IssuedDay, nil
			}},
			"dueDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(namedInvoice).Invoice.DueDay, nil }},
			"status": &graphql.Field{Type: graphql.String, Resolve: func(p graphql.ResolveParams) (interface{}, error) { return p.Source.(namedInvoice).Invoice.Status, nil }},
			"paidDay": &graphql.Field{Type: graphql.Int, Resolve: func(p graphql.ResolveParams) (interface{}, error) {
				if p.Source.(namedInvoice).Invoice.PaidDay == nil {
					return nil, nil
				}
				return *p.Source.(namedInvoice).Invoice.PaidDay, nil
			}},
		},
	})
	_ = invoiceType

	named := func(st *State, invs []Invoice) []namedInvoice {
		out := make([]namedInvoice, 0, len(invs))
		for _, inv := range invs {
			name := ""
			if d := findDebtor(st, inv.DebtorID); d != nil {
				name = d.Name
			}
			out = append(out, namedInvoice{Invoice: inv, Name: name})
		}
		return out
	}

	query := graphql.NewObject(graphql.ObjectConfig{
		Name: "Query",
		Fields: graphql.Fields{
			"stats": &graphql.Field{
				Type: statsType,
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					var out statsView
					err := svc.view(func(st *State) {
						out.WorldDay = st.Day
						for _, inv := range st.Invoices {
							out.InvoicedCents += inv.AmountCents
							out.CollectedCents += inv.PaidCents
							if inv.Status == "paid" {
								out.PaidCount++
							} else if inv.Status == "open" {
								out.OpenCount++
							}
						}
					})
					return out, err
				},
			},
			"debtors": &graphql.Field{
				Type: graphql.NewList(debtorType),
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					var out []Debtor
					err := svc.view(func(st *State) { out = append(out, st.Debtors...) })
					return out, err
				},
			},
			"invoices": &graphql.Field{
				Type: graphql.NewList(invoiceWithName),
				Args: graphql.FieldConfigArgument{
					"status": &graphql.ArgumentConfig{Type: graphql.String},
					"limit":  &graphql.ArgumentConfig{Type: graphql.Int},
				},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					status, _ := p.Args["status"].(string)
					limit := 200
					if v, ok := p.Args["limit"].(int); ok && v > 0 {
						limit = v
					}
					var out []namedInvoice
					err := svc.view(func(st *State) {
						var invs []Invoice
						for _, inv := range st.Invoices {
							if status == "" || inv.Status == status {
								invs = append(invs, inv)
							}
						}
						if len(invs) > limit {
							invs = invs[:limit]
						}
						out = named(st, invs)
					})
					return out, err
				},
			},
			"invoice": &graphql.Field{
				Type: invoiceWithName,
				Args: graphql.FieldConfigArgument{"id": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					id := p.Args["id"].(string)
					var out *namedInvoice
					err := svc.view(func(st *State) {
						if inv := findInvoice(st, id); inv != nil {
							n := named(st, []Invoice{*inv})[0]
							out = &n
						}
					})
					if out == nil {
						return nil, err
					}
					return *out, err
				},
			},
			"debtorInvoices": &graphql.Field{
				Type: graphql.NewList(invoiceWithName),
				Args: graphql.FieldConfigArgument{"debtorId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					debtorID := p.Args["debtorId"].(string)
					var out []namedInvoice
					err := svc.view(func(st *State) {
						var invs []Invoice
						for _, inv := range st.Invoices {
							if inv.DebtorID == debtorID {
								invs = append(invs, inv)
							}
						}
						out = named(st, invs)
					})
					return out, err
				},
			},
			"events": &graphql.Field{
				Type: graphql.NewList(eventType),
				Args: graphql.FieldConfigArgument{
					"afterId": &graphql.ArgumentConfig{Type: graphql.Int},
					"limit":   &graphql.ArgumentConfig{Type: graphql.Int},
				},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					after := 0
					if v, ok := p.Args["afterId"].(int); ok {
						after = v
					}
					limit := 500
					if v, ok := p.Args["limit"].(int); ok && v > 0 {
						limit = v
					}
					var out []Event
					err := svc.view(func(st *State) {
						for _, e := range st.Events {
							if e.ID > int64(after) {
								out = append(out, e)
								if len(out) >= limit {
									break
								}
							}
						}
					})
					return out, err
				},
			},
			"invoiceEvents": &graphql.Field{
				Type: graphql.NewList(eventType),
				Args: graphql.FieldConfigArgument{"invoiceId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)}},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					id := p.Args["invoiceId"].(string)
					var out []Event
					err := svc.view(func(st *State) {
						for _, e := range st.Events {
							if e.InvoiceID == id {
								out = append(out, e)
							}
						}
					})
					return out, err
				},
			},
		},
	})

	boolField := func(fn func(p graphql.ResolveParams) error) graphql.FieldResolveFn {
		return func(p graphql.ResolveParams) (interface{}, error) {
			if err := fn(p); err != nil {
				return false, err
			}
			return true, nil
		}
	}

	mutation := graphql.NewObject(graphql.ObjectConfig{
		Name: "Mutation",
		Fields: graphql.Fields{
			"createInvoice": &graphql.Field{
				Type: graphql.String,
				Args: graphql.FieldConfigArgument{
					"debtorId":    &graphql.ArgumentConfig{Type: graphql.String},
					"debtorName":  &graphql.ArgumentConfig{Type: graphql.String},
					"debtorEmail": &graphql.ArgumentConfig{Type: graphql.String},
					"amountCents": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)},
					"dueDay":      &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)},
				},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					debtorID, _ := p.Args["debtorId"].(string)
					debtorName, _ := p.Args["debtorName"].(string)
					debtorEmail, _ := p.Args["debtorEmail"].(string)
					return svc.CreateInvoice(debtorID, debtorName, debtorEmail, int64(p.Args["amountCents"].(int)), p.Args["dueDay"].(int))
				},
			},
			"updateDebtor": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"debtorId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"name":     &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"email":    &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.UpdateDebtor(p.Args["debtorId"].(string), p.Args["name"].(string), p.Args["email"].(string))
				}),
			},
			"recordPayment": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId":   &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"amountCents": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)},
					"note":        &graphql.ArgumentConfig{Type: graphql.String},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					note, _ := p.Args["note"].(string)
					return svc.RecordPayment(p.Args["invoiceId"].(string), int64(p.Args["amountCents"].(int)), note)
				}),
			},
			"logContact": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"playbook":  &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"tone":      &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"message":   &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.LogContact(p.Args["invoiceId"].(string), p.Args["playbook"].(string), p.Args["tone"].(string), p.Args["message"].(string))
				}),
			},
			"createPlan": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId":   &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"instalments": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.NewList(graphql.NewNonNull(instalmentInput)))},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					raw := p.Args["instalments"].([]interface{})
					inst := make([]Instalment, 0, len(raw))
					for _, r := range raw {
						m := r.(map[string]interface{})
						inst = append(inst, Instalment{Day: m["day"].(int), AmountCents: int64(m["amountCents"].(int))})
					}
					return svc.CreatePlan(p.Args["invoiceId"].(string), inst)
				}),
			},
			"recordPromise": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"day":       &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.RecordPromise(p.Args["invoiceId"].(string), p.Args["day"].(int))
				}),
			},
			"escalate": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
					"reason":    &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.Escalate(p.Args["invoiceId"].(string), p.Args["reason"].(string))
				}),
			},
			"reopen": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.Reopen(p.Args["invoiceId"].(string))
				}),
			},
			"resolveDispute": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{
					"invoiceId": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.String)},
				},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.ResolveDispute(p.Args["invoiceId"].(string))
				}),
			},
			"advanceDay": &graphql.Field{
				Type: graphql.Int,
				Args: graphql.FieldConfigArgument{"days": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)}},
				Resolve: func(p graphql.ResolveParams) (interface{}, error) {
					return svc.AdvanceDay(p.Args["days"].(int))
				},
			},
			"resetWorld": &graphql.Field{
				Type: graphql.Boolean,
				Args: graphql.FieldConfigArgument{"seed": &graphql.ArgumentConfig{Type: graphql.NewNonNull(graphql.Int)}},
				Resolve: boolField(func(p graphql.ResolveParams) error {
					return svc.Reset(int64(p.Args["seed"].(int)))
				}),
			},
		},
	})

	return graphql.NewSchema(graphql.SchemaConfig{Query: query, Mutation: mutation})
}

type namedInvoice struct {
	Invoice Invoice
	Name    string
}
