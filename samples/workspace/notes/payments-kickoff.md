Payments Integration Review — March 14

Attendees: Dana Reyes (eng lead), Marcus Hill (backend), Priya Shah (finance)

We need a payment processor live before the June launch. Evaluated three:

- Stripe. Team has shipped with it twice before. Docs are good. Estimated
  two weeks to integrate.
- PayPal. Marcus checked the API and it can't do the split-payout flow we
  need for marketplace sellers without a workaround.
- Adyen. Priya flagged that Adyen would require additional compliance
  review on our side, probably four to six weeks of legal time we don't
  have before June.

Decision: going with Stripe. The deciding factor was integration time —
two weeks vs. six-plus for Adyen, and PayPal doesn't support the flow at all.

Dana noted we're assuming transaction volume stays under 10k/month, which is
where Stripe's pricing stays favourable. Nobody pushed back on that.

Action: Marcus starts the Stripe integration Monday.
