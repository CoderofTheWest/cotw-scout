---
name: prd-builder
description: "Transform ideas into AI-optimized Product Requirements Documents (PRDs) using the Five Primitives of Spec-Driven Development. Use when the user wants to create a PRD, specify a product idea, or prepare requirements for a coding project."
metadata:
  openclaw:
    emoji: "📋"
    requires: {}
    user-invocable: true
---

# PRD Builder

Create structured, AI-optimized Product Requirements Documents using the Five Primitives of Spec-Driven Development. These primitives create a "source of truth" that enables autonomous execution by coding agents.

## The Five Primitives

Every PRD MUST include all five primitives. Each serves a distinct purpose:

| Primitive | Purpose | Fills Gaps? |
|-----------|---------|-------------|
| Core Objective | Enables "vibe-aligned" decisions when edge cases arise | Yes |
| Functional Requirements | Non-negotiable checklist for completion | No |
| Technical Constraints | Prevents architectural drift | No |
| User Journeys | Surface hidden requirements (state, feedback) | Yes |
| Verification Criteria | Definition of done for autonomous validation | No |

## Process

### Phase 0: Context Detection

**BEFORE asking any questions**, determine the organizational context:

```
Search for:
1. Is there an existing project folder? → Check projects/, docs/
2. Is there a master plan or architecture doc?
3. Is there prior brainstorming in memory/ or conversation history?
4. Is this standalone, an addon, or a new phase?
```

**Organizational Rules:**

| Context | Location | Filename Pattern |
|---------|----------|------------------|
| New standalone project | `projects/[name]/PRD.md` | `PRD.md` (first of many docs) |
| New project, multi-phase | `projects/[name]/prd/PRD-001-[feature].md` | `PRD-###-[feature].md` |
| Addon to existing project | `projects/[name]/prd/PRD-###-[feature].md` | Continue numbering |
| Brainstorm → PRD conversion | `projects/[name]/PRD.md` OR `projects/[name]/prd/PRD.md` | Preserve brainstorm context |
| Feature for existing system | `projects/[system]/prd/PRD-###-[feature].md` | Check for existing PRDs |

**GAP CUE - Context Uncertainty:**
If you cannot determine the organizational context, STOP and ask:
> "I want to make sure this goes in the right place. Is this a new project, an addon to [existing project], or something else?"

### Phase 1: Discovery (Fill the Five Primitives)

Ask targeted questions to fill each primitive. **Not all questions need answers** — the goal is to surface what matters.

#### Primitive 1: Core Objective (Vision)

The high-level "spirit" of the task. Enables autonomous decisions when edge cases arise.

**Questions to ask:**
- What's the outcome you're trying to achieve?
- If this works perfectly, what changes for the user?
- What's the ONE thing this feature/project must accomplish?

**GAP CUE - Vague Objective:**
If the objective feels generic ("build a dashboard"), STOP and ask:
> "Help me understand the spirit of this. What's the specific outcome that would make this successful? What's the 'vibe' you're going for?"

**Well-formed Core Objective:**
```
Enable small teams to track tasks without the complexity of enterprise tools — 
fast setup, minimal configuration, focused on getting things done.
```

**NOT this:**
```
Create a task management app.
```

#### Primitive 2: Functional Requirements (The "What")

Non-negotiable behaviors. Granular, specific, testable.

**GAP CUE - Missing Requirements:**
If you have fewer than 3 functional requirements, STOP and ask:
> "I want to make sure I have the essentials. What are the 3-5 things this absolutely MUST do?"

**GAP CUE - Vague Requirements:**
If a requirement includes words like "user-friendly", "fast", "good", STOP and ask:
> "When you say '[vague word]', what would that look like in practice? How would I know if it's working?"

**Well-formed Requirement:**
```
- Search bar filters results in real-time as the user types (debounce 200ms)
- User can log in via Google OAuth2 only
- Tasks can have exactly one assignee (not multiple)
```

**NOT this:**
```
- Good search
- User authentication
- Task assignment
```

#### Primitive 3: Technical Constraints (The "How" and "Where")

Hard boundaries that prevent architectural drift.

**Questions to ask:**
- Any tech stack requirements? (frameworks, languages, databases)
- Any existing patterns to follow? (architecture, file structure)
- Any performance boundaries? (load time, bundle size, response time)
- Any integrations required? (APIs, services, existing systems)

**GAP CUE - No Constraints:**
If this is for an existing project and you have NO technical constraints, STOP and ask:
> "I want to make sure this fits your existing setup. What's your current stack? Any patterns I should follow?"

**GAP CUE - Constraint Conflict:**
If a proposed requirement conflicts with existing constraints, STOP and ask:
> "You mentioned [requirement], but I see [existing pattern/constraint]. Should this follow the existing pattern, or branch off intentionally?"

**Well-formed Constraints:**
```
- Use Next.js 14 with App Router (existing project pattern)
- Follow the repository pattern in /api/users for new endpoints
- Bundle size increase must stay under 5kb
- Database: SQLite (keep it simple, no external deps)
```

#### Primitive 4: User Journeys (The Workflow)

Narrative walkthroughs that surface hidden requirements.

**GAP CUE - No Journey:**
If you have functional requirements but no user journey, STOP and ask:
> "Walk me through how someone would actually USE this. What happens first, then what?"

**GAP CUE - Missing States:**
If a journey mentions success but no error states, ASK:
> "What happens if [step] fails? What does the user see?"

**Well-formed Journey:**
```
1. User navigates to /settings
2. User toggles "Dark Mode"
3. UI immediately updates (no page refresh)
4. Success toast appears: "Theme saved"
5. On return visit, dark mode persists

Error case:
1. User toggles "Dark Mode"
2. API returns 500
3. UI reverts toggle, shows error: "Couldn't save. Try again?"
```

#### Primitive 5: Verification Criteria (Definition of Done)

Explicit tests/checks for autonomous validation.

**GAP CUUE - No Verification:**
If you have no verification criteria, STOP and ask:
> "How will we know this is done? What would you check to verify it works?"

**Verification Patterns:**
```
- Visual: Screenshots before/after, component states
- Functional: E2E test script, manual test checklist
- Performance: Lighthouse score, bundle size check
- Integration: API response validation, webhook tests
```

**Reviewer Subagent Pattern:**
```
When complete, spawn a reviewer agent that checks:
1. All acceptance criteria pass
2. No TypeScript errors
3. Responsive on mobile viewports
4. Dark mode renders correctly
```

### Phase 2: Draft

Use the template below. ALL FIVE PRIMITIVES must be present.

```markdown
# PRD: [Feature/Project Name]

## Context
<!-- Where does this fit? Link to project, previous PRDs, master plan if applicable -->

## Primitive 1: Core Objective

<!-- The spirit of this work. 2-3 sentences max. Enables "vibe-aligned" decisions. -->


## Primitive 2: Functional Requirements

- [ ] [Requirement 1]
- [ ] [Requirement 2]
- [ ] [Requirement 3]
- [ ] ...

### Nice-to-Have (Out of Scope for This PRD)
- [Feature that would be great but isn't essential]

## Primitive 3: Technical Constraints

| Constraint | Value | Rationale |
|------------|-------|-----------|
| Stack | [framework/language] | [why] |
| Pattern | [existing pattern to follow] | [why] |
| Performance | [metric] | [why] |
| Integration | [API/service] | [why] |

## Primitive 4: User Journeys

### Primary Journey
1. User [action]
2. System [response]
3. User [action]
4. System [response]
5. [Continue until success state]

### Error Journey: [Error Type]
1. User [action]
2. System [error response]
3. User [recovery action]
4. System [recovery response]

### Edge Case: [Edge Case]
1. [Scenario walkthrough]

## Primitive 5: Verification Criteria

### Manual Verification
- [ ] [Test step 1]
- [ ] [Test step 2]

### Automated Verification
- [ ] [Type of test]: [what it validates]

### Reviewer Subagent (if applicable)
Spawn a reviewer agent to validate:
- [ ] [Check 1]
- [ ] [Check 2]
- [ ] [Check 3]

## Implementation Notes

<!-- Additional context, gotchas, references -->

## Blocks

| This PRD | Relationship | Other PRD |
|----------|--------------|-----------|
| [This feature] | blocks | [Downstream feature] |
| [This feature] | blocked by | [Upstream dependency] |

## References

- [Related docs, prior art, conversations]
```

### Phase 3: Review Against Primitives

Before delivering, check:

| Primitive | Must Have | Check |
|-----------|-----------|-------|
| Core Objective | Clear outcome, enables vibe-aligned decisions | ☐ |
| Functional Requirements | Specific, testable, non-negotiable | ☐ |
| Technical Constraints | Hard boundaries, prevents drift | ☐ |
| User Journeys | Narrative flow, includes errors | ☐ |
| Verification Criteria | Explicit checks, reviewer pattern | ☐ |

**GAP CUE - Missing Primitive:**
If any primitive is weak or missing, STOP and ask:
> "I want to strengthen the [primitive] section. [Specific question to fill the gap]"

### Phase 4: Deliver

Save to location determined in Phase 0. Confirm with user:

```
PRD saved to: [path]

Ready for:
- Coding agent implementation
- Further refinement
- Addition to project roadmap
```

## Gap Detection Summary

**ALWAYS STOP AND ASK when you encounter:**

1. **Organizational uncertainty** → "Where does this fit?"
2. **Vague objective** → "What's the spirit/outcome?"
3. **Fewer than 3 requirements** → "What are the essentials?"
4. **Vague requirements** → "What does 'good' look like?"
5. **No technical constraints** → "What's the stack?"
6. **Constraint conflicts** → "Existing vs. new approach?"
7. **No user journey** → "Walk me through usage"
8. **Missing error states** → "What happens if X fails?"
9. **No verification** → "How do we know it's done?"
10. **Weak primitive** → "Strengthen this section"

## File Organization

```
projects/
├── [new-project]/
│   ├── PRD.md              # First doc, project kickoff
│   ├── BRAINSTORM.md       # If converting from brainstorm
│   └── prd/
│       ├── PRD-001-feature.md
│       └── PRD-002-feature.md
│
├── [existing-project]/
│   ├── MASTER.md           # Project master plan
│   └── prd/
│       ├── PRD-001-core.md
│       ├── PRD-002-addon.md
│       └── PRD-003-phase2.md
│
└── [standalone-feature]/
    └── prd-[feature-name].md
```

## Best Practices

1. **All five primitives, every time** — No partial PRDs
2. **Specificity over completeness** — Better specific and wrong than vague and right
3. **Gap detection is not nagging** — It's ensuring quality
4. **Journey before requirements** — Narratives surface hidden needs
5. **Verification enables autonomy** — Coding agents need explicit "done" criteria
6. **Context determines location** — Fit the existing structure, don't force new patterns