# Loopenta — Organizations, Roles & Hub Spec

Living document. Source of truth for the multi-org, multi-role model.
Last updated: 2026-04-22.

---

## 1. Organization Types

Every `organization` document now has an `orgType` field.

| orgType            | Label                     | Who belongs here                                                                     |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------ |
| `mortgage`         | Mortgage Organization     | Lenders, brokerages, credit unions. Home Loan Advisors + Managers.                   |
| `realEstate`       | Real Estate Organization  | Brokerages. Realtors + Managers (brokers).                                           |
| `referralPartner`  | Referral Partner          | CPAs, financial advisors, insurance agents, attorneys, etc. Manager + Users.         |
| `title`            | Title Company             | (scaffolded) Title officers + Managers. Full workflow later.                         |
| `escrow`           | Escrow Company            | (scaffolded) Escrow officers + Managers. Full workflow later.                        |

Back-compat: organizations without `orgType` are treated as `mortgage` (that's how the app started).

Fields on `organizations/{orgId}`:

```
{
  name:             string,
  orgType:          'mortgage' | 'realEstate' | 'referralPartner' | 'title' | 'escrow',
  primaryColor:     '#hex',
  accentColor:      '#hex',
  logoUrl:          string,
  tagline:          string,
  subscriptionTier: 'lmi_only' | 'full',
  memberCount:      number,
  createdAt:        isoString,
  createdBy:        uid,
  // Referral Partner only:
  partnerCategory:  'cpa' | 'advisor' | 'insurance' | 'attorney' | 'builder'
                  | 'propertyManager' | 'inspector' | 'appraiser' | 'custom',
  partnerCategoryCustom: string,    // when partnerCategory === 'custom'
}
```

---

## 2. Roles

Roles are stored in the existing `role` field on `/users/{uid}`. The set expands
from `{superadmin, admin, mlo, realtor}` to:

| role             | Label                 | Scope                                                                                         |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `superadmin`     | Super Admin           | Platform-wide. No org boundary. Can see/do anything.                                          |
| `admin`          | Admin                 | Full control of a single organization (any orgType). Creates managers and users inside org.   |
| `manager`        | Manager               | Supervises a team inside one org. Sees team activity, assigns leads, reports up to admin.     |
| `mlo`            | Home Loan Advisor     | Individual user inside a `mortgage` org. (Field name kept as `'mlo'` for data back-compat.)   |
| `realtor`        | Realtor               | Individual user inside a `realEstate` org.                                                    |
| `referralUser`   | Referral Partner User | Individual user inside a `referralPartner` org (CPA, advisor, etc.).                          |
| `titleUser`      | Title Officer         | Individual user inside a `title` org. (Scaffolded.)                                           |
| `escrowUser`     | Escrow Officer        | Individual user inside an `escrow` org. (Scaffolded.)                                         |

### Role → orgType matrix

| role            | Valid orgTypes                                              |
| --------------- | ----------------------------------------------------------- |
| superadmin      | platform (not tied to org)                                  |
| admin           | any                                                         |
| manager         | any                                                         |
| mlo             | `mortgage`                                                  |
| realtor         | `realEstate`                                                |
| referralUser    | `referralPartner`                                           |
| titleUser       | `title`                                                     |
| escrowUser      | `escrow`                                                    |

UI display label resolution: `Hub.roleLabel(role)` in `src/hub/roleModel.js`.

### Manager hierarchy

Users can be assigned a `managerId` (the uid of the Manager they report to).
A Manager sees the activity of any user in the same org where
`user.managerId == manager.uid`. An Admin sees all users in the org.
Superadmin sees everyone.

Fields on `/users/{uid}` used for this:

```
{
  role:       one of the values above,
  orgId:      string,
  managerId:  uid of the Manager they report to (optional),
  title:      display title (e.g., 'Senior Home Loan Advisor'),
  // Referral Partner users pick from:
  partnerTitle:       'CPA' | 'Financial Advisor' | ... | 'Custom',
  partnerTitleCustom: string,
}
```

---

## 3. Visibility / Authority Rules

Higher levels see everything lower levels can see (within their org, except
superadmin which is global).

```
superadmin ⊇ admin (per org) ⊇ manager (per team) ⊇ individual user
```

| Action                              | superadmin | admin (own org) | manager (own team) | individual |
| ----------------------------------- | :--------: | :-------------: | :----------------: | :--------: |
| Read all orgs                        | ✓          |                 |                    |            |
| Read/update own org                  | ✓          | ✓               | read-only          | read-only  |
| List users in own org                | ✓          | ✓               | team-only          |            |
| Invite user to own org               | ✓          | ✓               | ✓ (into own team)  |            |
| Assign user to a Manager             | ✓          | ✓               |                    |            |
| Assign / reassign a lead             | ✓          | ✓               | ✓ (within team)    |            |
| Read team activity                   | ✓          | ✓               | ✓ (team)           | self only  |
| Read cross-org lead (as recipient)   | ✓          | ✓               | ✓                  | ✓ if assigned |
| Send referral to another org         | ✓          | ✓               | ✓                  | ✓          |
| Accept referral partnership          | ✓          | ✓               |                    |            |
| Platform settings / feature flags    | ✓          |                 |                    |            |

---

## 4. Referral / Lead Network

Organizations connect via `referralLinks` documents. A link is established
through email invite and acknowledged by an admin on the other side.

```
referralLinks/{linkId}
{
  orgA:       orgId,
  orgB:       orgId,
  status:     'pending' | 'active' | 'paused' | 'revoked',
  initiatedBy: uid,
  initiatedAt: iso,
  acceptedBy:  uid,
  acceptedAt:  iso,
  note:        string,
}
```

A referral (lead) sent across orgs is stored in `leads`:

```
leads/{leadId}
{
  fromOrgId:  orgId,
  fromUserId: uid,
  toOrgId:    orgId,
  toUserId:   uid | '',          // '' = unassigned, receiving manager will assign
  kind:       'borrower' | 'property' | 'refinance' | 'buyer' | 'seller' | 'referral',
  status:     'sent' | 'accepted' | 'working' | 'won' | 'lost' | 'declined',
  // Borrower context
  borrowerName:  string,
  borrowerEmail: string,
  borrowerPhone: string,
  // Property context
  propertyAddress: string,
  propertyCity:    string,
  propertyState:   string,
  propertyZip:     string,
  estPrice:        number,
  // Notes + metadata
  note:           string,
  urgency:        'low' | 'normal' | 'high',
  createdAt:      iso,
  lastActivity:   iso,
  timeline:       [ { at, by, event, note } ],
}
```

Receiving rules:
- Any signed-in user in `toOrgId` can `read` their own unassigned leads.
- If `toUserId` is set, only that user + their manager + org admin see the lead.
- A Manager can reassign within their team.
- Superadmin sees everything.

---

## 5. Referral Partner Titles

When a `referralUser` signs up, they pick one of:

- CPA / Accountant
- Financial Advisor
- Insurance Agent
- Attorney
- Builder / Developer
- Property Manager
- Home Inspector
- Appraiser
- Divorce Attorney
- Estate Planner
- Credit Repair
- Contractor
- Real Estate Investor
- Other / Custom (free text)

Stored on the user as `partnerTitle` and `partnerTitleCustom` (when `Other`).
The `referralPartner` org can also store a default `partnerCategory` that
pre-fills the user's choice.

---

## 6. Title + Escrow (Scaffold)

Minimal viable features we ship now:

- Org type + role + invite flow: yes
- Shared-deal visibility: an HLA or Realtor can link a title/escrow org to a
  specific deal. That org sees only the deals linked to them.
- Closing Date tracker: close date + countdown visible to all linked parties.
- Document drop: each deal can receive a file reference (URL) from title/escrow.
- Status beacon: title/escrow can post a status string on the deal (e.g.,
  "Title commitment sent", "Escrow open", "CTC").

No deep title search / commitment generation yet — flagged for later.

---

## 7. Feature Flags × Org Type

Tier ceilings still apply. In addition, some features are implicitly
org-type-gated:

| Feature key          | Visible to orgType                           |
| -------------------- | -------------------------------------------- |
| `lmi_search`         | all (LMI is the universal hub feature)       |
| `deal_pipeline`      | mortgage                                     |
| `buyer_pipeline`     | realEstate                                   |
| `listings_board`     | realEstate                                   |
| `realtor_scorecard`  | mortgage (loan officer view of their realtors) |
| `referral_inbox`     | all                                          |
| `manager_reports`    | all (if the user has a team under them)      |
| `title_portal`       | title                                        |
| `escrow_portal`      | escrow                                       |

`src/hub/roleModel.js` exports `isFeatureVisibleForOrgType(flag, orgType)`.

---

## 8. Migration from Today's State

The existing data model has:
- `users` with roles `superadmin`, `admin`, `mlo`, `realtor`.
- `organizations` without `orgType`.

Migration plan (additive, zero-downtime):
1. New `organizations` docs get `orgType` on create. Existing docs default to
   `mortgage` at read time if the field is missing.
2. `role: 'mlo'` is unchanged on disk but is relabeled in every UI surface to
   "Home Loan Advisor". Helper: `Hub.roleLabel('mlo') === 'Home Loan Advisor'`.
3. `role: 'realtor'` remains valid, but realtors previously linked to a single
   MLO (via `linkedMloId`) can optionally also be assigned a `managerId` and an
   `orgId` pointing at a `realEstate` org.
4. New `manager` role: zero rows today; created going forward via invite.
5. New `referralUser` / `titleUser` / `escrowUser` roles: none today.

No backfill script is required — reads are defensive.

---

## 9. UI Touchpoints (completed or pending)

- [x] Role helpers expanded: `isSuperAdmin`, `isAdmin`, `isManager`, `isHla`, `isRealtor`, `isReferralUser`, `isTitleUser`, `isEscrowUser`, plus legacy `isMLO()` kept.
- [x] Invite form supports orgType + role + manager assignment + referral partner title.
- [x] User list renders new role badges with proper labels.
- [x] Manager Team Reporting view.
- [x] Referrals inbox + send flow.
- [x] Realtor portal gets listing + buyer pipeline shells.
- [ ] Title/Escrow portals (scaffold only).
- [ ] Cross-org "shared deal" view (stub).
- [x] Design polish: nav chrome, role chips, dashboard hero.

---

## 10. Open Questions (for Aaron)

1. Should a single person able to hold roles in multiple orgs (e.g., an
   attorney who is both a Referral Partner and a title officer)? Current spec:
   no — one user = one role = one org. A person who needs both gets two
   accounts. Simpler and safer.
2. Referral partner commission tracking: include now (phase 1) or later?
   Current plan: later.
3. Should Managers be allowed to invite new users, or admin-only?
   Current plan: Managers can invite into their own team; Admin can invite
   anywhere in the org.
