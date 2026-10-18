# Atlas ADR-001: Payments provider

Status: Accepted
Date: 2026-08-12
Author: Alex Chen
Approved by: Dana Ortiz

## Context

Atlas replaces the legacy checkout service. We need a card processor before the September pilot.

## Decision

Atlas will use Braintree as its payments provider, starting immediately.

## Rationale

We already have an enterprise contract with Braintree, and the team can integrate it within one sprint.

## Consequences

Multi-currency payouts are not supported by our Braintree plan. We will revisit if the EU launch is confirmed.
