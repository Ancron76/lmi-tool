# Fair Lending Self-Assessment — LMI Search & Property Intelligence

> Audit completed: 2026-05-29. Reviewed by: operator + Claude code review.
> Next required review: annually, or after any change to LMI Search,
> Property Intelligence, CRA scoring, or marketing-targeting features.

This document describes how the LMI Search and Property Intelligence
features in Loopenta have been designed to comply with the Equal
Credit Opportunity Act (ECOA / Regulation B), the Fair Housing Act,
and the CFPB's anti-redlining guidance. It is intended for the
operator's own compliance file and for any regulator examining the
platform.

## Scope of features audited

- **LMI Search** (`/?zip=XXXXX`) — surfaces census tracts within a
  county classified by income relative to MSA AMI (Low / Moderate /
  Middle / Upper). Source: CFPB FFIEC HMDA data.
- **Property Intelligence** (`/property-intelligence?tractId=…`) —
  surfaces lender activity and CRA opportunity context for a specific
  tract. Source: CFPB HMDA + LMI lookup.

## ECOA / Reg B prohibited bases — exposure analysis

ECOA §202.4(a) prohibits discrimination "on a prohibited basis"
including race, color, religion, national origin, sex, marital
status, age, public-assistance income, and exercise of CCPA rights.

### What we collect / display

| Field | Source | Used in scoring? | Used in marketing-target? |
|---|---|---|---|
| Tract income | CFPB FFIEC | **Yes** (CRA Opportunity Score) | Yes (LMI classification) |
| LMI tract status | derived from income | **Yes** | Yes |
| Tract population | CFPB FFIEC | No | No |
| Active lender count | CFPB HMDA | **Yes** (CRA Opportunity Score) | No |
| Application volume | CFPB HMDA | **Yes** (CRA Opportunity Score) | No |
| Origination rate | CFPB HMDA | No | No |
| Minority population % | CFPB HMDA | **NO** (intentionally removed) | **NO** (UI labels as reporting-only) |

### Why we display minority population %

Per HMDA §1003.4, CRA-subject lenders MUST track aggregate
demographics of the tracts they serve and report annually. We
surface this data so operators can:
- Self-assess their own lending portfolio for disparate impact
- Generate CRA Performance Evaluation evidence
- Maintain transparency about the dataset being used

We DO NOT:
- Factor minority population into the CRA Opportunity Score
- Allow filtering / sorting LMI results by minority population
- Tailor marketing copy based on demographic composition
- Vary loan terms, pricing, or product offerings based on tract demographics

The UI surfaces the field inside a collapsed `<details>` block with
an explicit ECOA / Fair Housing Act notice telling the loan officer
they MUST NOT use this for targeting or avoidance.

## CRA Opportunity Score — methodology

The score (0-100) is computed in `worker.js::calculateCraOpportunity`.
It is built from race-neutral inputs:

| Factor | Points | Rationale |
|---|---|---|
| Tract income < 80% AMI (LMI) | +40 | Direct CRA criterion |
| Tract income < 50% AMI (deep low) | +20 (additive) | Underserved per CRA |
| Active lenders < 5 | +20 | Market underserved by competition |
| HMDA apps > 50 AND lenders < 10 | +20 | Latent demand, undersupplied |

Maximum: 100. Cap is applied explicitly in code.

### What we deliberately do NOT score on

- **Race, ethnicity, or national-origin proxies**. A prior version
  of `calculateCraOpportunity` added +25 / +40 based on minority
  population percentage. That version was removed during this audit;
  see commit history for the exact change. Even with positive intent
  ("target underserved minority areas for outreach"), CFPB has
  consistently held that using race in any lending-related scoring
  is a prohibited basis violation regardless of direction.

- **Low origination rate as a positive signal**. The prior version
  awarded points for low approval rate. That signal can read as
  "find areas where it is easier to make non-prime loans," which
  is a reverse-redlining liability. Removed.

## Marketing equity — how we prevent disparate treatment

The platform surfaces LMI tracts to loan officers as **prospect
generation** territory. To prevent disparate-treatment liability:

- LMI status is shown as Low / Moderate / Middle / Upper — a
  bucket-based income classification, not a demographic one.
- Property listings inside an LMI tract are surfaced identically
  regardless of demographic composition.
- Marketing flyers generated for a tract use uniform copy and
  uniform product positioning regardless of demographics.
- The Settings → Profile page collects NMLS, name, phone, email,
  and a headshot — no demographic data about the loan officer that
  could be used to "match" demographically.

## Adverse-action notice readiness

The platform does **not** currently issue credit decisions, adverse
action notices, or CRA Reg B §202.9 notices. It is a CRM and
prospect-discovery tool. The actual loan origination, underwriting,
and adverse-action workflows happen in the loan officer's separate
LOS (loan origination system).

If Loopenta is ever extended to perform underwriting decisions, the
following must be added before any such feature ships:

- Reg B §202.9 adverse-action notice generation
- 30-day notice window tracker
- Statement of specific reasons or notice-of-right-to-statement
- ECOA notice of nondiscrimination on the adverse-action document
- Audit log of every adverse action with retention per §202.12 (25 mo)

## Data sources — public, regulator-approved

All data used is sourced from public regulatory datasets:
- CFPB FFIEC HMDA Loan-Application Register (LAR)
- US Census Bureau ACS 5-year estimates (via FFIEC)
- HUD AMI tables (via FFIEC)

We do not purchase, ingest, or display:
- Consumer report data from CRAs (Equifax / Experian / TransUnion)
- Predicted demographics from data brokers
- Inferred protected-class data from any source

## Audit trail

Every LMI Search query is logged at the worker level via
`wrangler tail` and the worker's observability dashboard. Every
property-intelligence request is similarly logged. The frontend
writes a row to Firestore `/auditLog` on save-to-prospect-list, on
flyer generation, and on send-to-realtor.

If a regulator asks "what searches did this loan officer perform
between dates X and Y, and what actions did they take on the
results?" — the audit log answers that question.

## Recommended periodic reviews

| Cadence | Activity |
|---|---|
| Quarterly | Run an internal HMDA-style portfolio review of saved prospects by income classification — are LMI tracts represented at a rate proportional to their share of the licensed footprint? |
| Annually | Re-read this document. Verify no new features introduced demographic-based scoring or targeting. Update the audit table if HMDA fields change. |
| On feature change | Any code change to `calculateCraOpportunity`, `renderHmdaPanel`, or LMI Search results rendering triggers a re-audit. The git commit comment must call out the change explicitly. |

## Open items

- [ ] Operator should engage outside counsel to review this document
      and the underlying code before any production loan officer
      uses the LMI Search at scale. This audit is technical, not
      legal advice.
- [ ] Set up the quarterly self-review cadence as a recurring
      reminder.
- [ ] If/when Loopenta begins issuing credit decisions or generating
      adverse-action notices, expand this document to cover those
      flows (Reg B §202.9).
