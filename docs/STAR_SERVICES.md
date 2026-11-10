# Proposed star services

Status: operator business policy and implementation requirements, not an active
provider offer. The desktop presents this model with signup disabled. No service
is allocated, billed, booted or transferred by this page.

## Policy

- An identity is free at signup. The issuing star’s operator retains its ownership
  until the user buys it out; free access is not a grant of ownership.
- A monthly subscription pays for hosting and agreed services: compute,
  arbitration, and workspace guidance using QPC and the corpus. The monthly price,
  limits and terms must be supplied by the provider; none are invented here.
- The operator-selected ownership buyout is USD 10, available at any time, with
  a verified path to self-hosting. Implementing this promise requires provider
  agreement, ownership authority and a working transfer/data-export process.
- Ownership, sponsorship, server custody and subscription status are separate.
  Canceling services must not revoke purchased ownership or silently delete data.
  Retention and export terms must be disclosed before signup.

This is not an assertion that Orraah offers these terms. Its existing public
catalog and generic direct-purchase checkout remain a separate alternative.
QPC/corpus services are proposed scopes, not evidence that hosted services or
full Readymade parity are operational.

## Required provider contract

These are proposed data and proof requirements, not implemented endpoint names.
Persistent account, allocation, billing-entitlement, provisioning and transfer
state must live in Urbit-native agents. External payment and hosting systems may
supply authenticated observations through bounded adapters; no new Earthside
daemon becomes the authority for those records.

Every operation needs an authenticated account, provider identity, protocol
version, stable request ID, exact input digest, status and correlated receipt.
Duplicate identical requests return the retained result; conflicting reuse is
refused. An unknown response is observed by its original ID, never automatically
resubmitted. Payment redirect completion is not payment confirmation.

A versioned provider quote must identify the issuing star and actual ownership
controller, currency, monthly price, billing interval, renewal/cancellation terms,
compute/model limits, arbitration scope, QPC/corpus access and privacy boundaries,
backup/export/retention terms, and the USD 10 buyout conditions. Distinguish user
permission to use a ship from custody of its ownership and networking keys.
Bind accepted terms to the account and subsequent allocation; record consent
before subscription or provisioning. Do not send private corpus content to a
provider or model merely because a subscription exists.

An allocation receipt must bind the account, planet, issuer, current ownership
address, sponsorship, accepted terms and request. A billing receipt must bind
the payment-provider event, amount/currency, account, subscription and entitlement
period; verify its authenticity and deduplicate it. Neither receipt alone proves
that a server exists or that the user owns the identity.

## Signup acceptance sequence

1. Authenticate the account and present the versioned quote and monthly terms.
2. Claim one free allocation idempotently, recording exact planet and custody.
3. Obtain explicit subscription consent and observe confirmed payment/entitlement.
   A declined, pending or unknown payment must not be labeled subscribed.
4. Provision once under a retained request. After every ship boot, mount `%base`
   natively and verify its required system files before readiness. Install the
   backend through the supported path with complete app/data preservation and
   the applicable compilation/load guards; never use a partial Gall load.
5. Observe a readiness receipt binding account, planet, authenticated ship
   identity, server origin, backend/source versions, app inventory, preservation
   result and current health. Provisioning acknowledgment is not readiness.
6. Connect explicitly through the existing private password flow. Keep an existing
   Readymade connection intact; use another window for a different ship.

Acceptance must cover duplicate requests, response loss, failed payment,
provisioning failure, cross-account/planet substitution and restart recovery.
No inferred success, repeated boot, or automatic replay is allowed after an
unknown operation. Existing native-operation and deployment gates still apply.

## USD 10 buyout and self-hosting acceptance

1. Show the exact planet, current ownership controller, destination ownership
   address, USD 10 quote and transfer/proxy consequences. Record an immutable
   buyout/payment intent before any payment or ownership action.
2. Observe the correlated confirmed payment, then submit the authorized transfer
   once. Confirm resulting ownership on the appropriate Urbit ID ledger, including
   the applicable L1/L2 transaction or rollup evidence and proxy disposition.
   A provider promise or payment receipt is not ownership proof.
3. Arrange a private, complete pier/data and necessary key handoff, with validated
   backup integrity, declared versions and custody/access policy. No master
   tickets, keys, login codes or private export links belong in URL parameters,
   application logs, analytics, receipts intended for public sharing or chat.
4. Perform an explicit single-instance cutover: establish the old instance has
   stopped before booting the same identity elsewhere. Keep failure recovery
   controlled; do not boot duplicate identities or silently reset the ship.
5. Verify self-hosted identity, mounted `%base`, complete app/data continuity and
   actual access before ending hosting. Keep ownership transfer, data migration
   and hosting cancellation as separately observed operations. Cancellation must
   preserve paid ownership and the agreed data-export/retention rights.

Do not choose transfer options blindly: networking keys, proxies and continuity
have distinct consequences. The user must know which control remains with the
provider and which is relinquished. Self-hosting readiness cannot be inferred
from ownership transfer alone.

## Native identity references

Urbit distinguishes ownership from management, spawn and other delegated rights;
sponsorship is not proof of ownership. See the official
[proxy reference](https://docs.urbit.org/user-manual/id/proxies),
[Bridge guide](https://docs.urbit.org/user-manual/id/using-bridge), and
[L2 action reference](https://docs.urbit.org/urbit-id/l2/l2-actions).
These document technical identity operations, not the proposed commercial offer
or a provider commitment to execute it.
