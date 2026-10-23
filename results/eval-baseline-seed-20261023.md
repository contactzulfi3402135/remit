# Remit evaluation 2026-10-23T15:37:52.638Z

Draft model: baseline:rules · seed 20261023 · three 60-day episodes in 5.7s · invoiced $446,069

```
Strategy  Collected by day 30  By day 60       DSO(sim)  Contacts  Model cost
none      $200,969 (45%)       $243,764 (55%)  52.1      0         $0.0000   
template  $342,174 (77%)       $376,070 (84%)  42.6      128       $0.0000   
remit     $356,150 (80%)       $386,392 (87%)  40.6      157       $0.0000   
```

Remit collected $10,322 more than fixed-template dunning by day 60 on the same seeded world.

## What the bandit learned (contacts → payments within 7 days)
- new / formal-firm: 11/27
- new / friendly-plan-early: 4/16
- new / friendly-remind-only: 5/15
- promise-broken / formal-firm: 10/20
- promise-broken / friendly-plan-early: 1/3
- promise-broken / friendly-remind-only: 0/1
- promised-before / friendly-plan-early: 0/1
- silent / formal-firm: 0/1
- silent / friendly-plan-early: 0/1
- silent / friendly-remind-only: 1/12
- slow-payer / formal-firm: 0/2
- slow-payer / friendly-plan-early: 1/6
- slow-payer / friendly-remind-only: 9/16
- usually-pays / formal-firm: 11/27
- usually-pays / friendly-plan-early: 1/6
- usually-pays / friendly-remind-only: 0/3

Seeded simulator debtors with disclosed behaviour rules; the agent never sees persona labels. Proves strategy/policy wiring and relative uplift, not real-world collection rates.
