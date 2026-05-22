---
name: deep-research
description: Execute systematic deep research on technical topics with hypothesis-driven methodology. Use when asked to research a topic deeply, investigate a technical approach, analyze competing methods, or develop a proposal based on research. Triggers on phrases like "deep dive", "research this", "investigate approaches", "develop a methodology", or when the user explicitly asks for a systematic research process. Produces structured output with findings, eliminated approaches, and actionable proposals.
---

# Deep Research Methodology

Execute multi-phase research to produce high-quality findings and proposals.

## Overview

This workflow transforms a research question into a structured proposal through systematic investigation, hypothesis testing, and elimination of unpromising approaches. It's designed to produce defensible conclusions with minimal wasted effort.

## Phases

Execute phases in order. Each phase builds on the previous. Document findings in a project file.

### Phase 1: Survey the Landscape

**Goal:** Map the current state of knowledge before diving deep.

**Actions:**
1. Web search for the topic + "2024 2025 2026" to find current approaches
2. Identify 3-7 leading methods/frameworks/papers
3. Create a comparison table with columns relevant to the research question

**Output:** A comparison table showing:
| Approach | Key Insight | Resource Requirement | Applicability |
|----------|-------------|---------------------|---------------|

**Example:**
```
| AZR | Zero external data, code executor verifies | HIGH fit | Self-play reasoning |
| SPELL | Multi-role self-play, semantic verifier | MEDIUM fit | Long-context reasoning |
| o1 | RL on chain-of-thought | LOW fit | Requires frontier compute |
```

### Phase 2: Inventory Assets

**Goal:** Quantify what you have before deciding what to build.

**Actions:**
1. List available data with quantities (turns, dimensions, size)
2. Document previous attempts and their results (successes and failures)
3. Identify what's missing vs. what would be nice to have

**Output:** Asset inventory with status:
| Asset | Available? | Quantity | Notes |
|-------|-----------|----------|-------|
| Cognitive dynamics data | ✅ | 603 turns, 25 dims | JEPA encoder weights |
| V8 model | ⚠️ | Broken | Identity worked, tools lost |

### Phase 3: Hypothesis Formation

**Goal:** Generate competing approaches before committing.

**Actions:**
1. Formulate 3-5 hypotheses for how to solve the problem
2. Rate each by resource fit (HIGH/MEDIUM/LOW)
3. Identify what would validate or eliminate each hypothesis

**Output:** Hypothesis table:
| Hypothesis | Resource Fit | Validation Criteria |
|------------|--------------|---------------------|
| H1: AZR pattern | HIGH | Paper proves SOTA without data |
| H2: Hybrid approach | MEDIUM | Need to test tool preservation |

### Phase 4: Deep Dive on Promising Approaches

**Goal:** Fetch and analyze primary sources for top hypotheses.

**Actions:**
1. Web fetch full papers for the most promising 2-3 approaches
2. Extract: architecture, key results, limitations, resource requirements
3. Map to your specific situation—what applies, what doesn't, what needs adaptation

**Output:** Per-paper analysis:
- Architecture (how it works)
- Key results (what it achieved)
- Limitations (where it fails)
- Applicability to your situation

### Phase 5: Hypothesis Elimination

**Goal:** Cut unpromising approaches with evidence.

**Actions:**
1. Test each hypothesis against findings
2. Eliminate approaches that:
   - Require resources you don't have
   - Preserve failure modes of previous attempts
   - Contradict primary source evidence
3. Document why each eliminated approach was rejected

**Output:** Elimination log:
- H5: Scale V8 directly → ELIMINATED (preserves failure modes)
- H6: Pure prompting → ELIMINATED (identity needs training)

### Phase 6: Proposal Draft

**Goal:** Synthesize findings into actionable recommendations.

**Structure:**
1. **Executive Summary** - 2-3 sentences on the recommended approach
2. **Architecture** - How the solution works (include diagram if complex)
3. **Key Design Decisions** - Why this approach over alternatives
4. **Resource Requirements** - What you need to execute
5. **Open Questions** - What the user needs to decide
6. **Success Criteria** - How to measure if it worked

**Output:** A project file named `<topic>-proposal.md` with all sections populated.

## Output Artifacts

Create a project file to track all research:

```
projects/<topic>-research-proposal.md
```

Update this file throughout the research process with:
- Phase completion status
- Key findings
- Asset inventories
- Hypotheses and elimination rationale
- Final proposal

## Quality Checks

Before declaring complete, verify:

- [ ] All phases executed in order
- [ ] Comparison tables populated with data
- [ ] Hypotheses explicitly rated and eliminated with evidence
- [ ] Primary sources fetched and analyzed (not just search summaries)
- [ ] Proposal addresses all open questions
- [ ] Success criteria are measurable

## Example Usage

**User:** "Can you research how AlphaZero's approach could apply to training a reasoning model with limited resources?"

**Trigger:** "research", "AlphaZero approach", "limited resources"

**Skill execution:**
1. Survey: Search "AlphaZero LLM reasoning self-play 2024 2025"
2. Inventory: What training data do we have? What failed previously?
3. Hypothesize: AZR pattern, SeRL, Hybrid, ARC-AGI transfer—rate each
4. Deep dive: Fetch AZR and SPELL papers, extract architecture
5. Eliminate: Scale V8 → preserves failure; Prompting → no training benefit
6. Propose: SPELL+V8 hybrid with verification from correction data

## When to Use

- User asks for "research on X"
- User says "investigate approaches for Y"
- User wants a "proposal" or "methodology" developed
- User mentions specific technical approaches to compare
- User asks to "deep dive" into a topic

## When NOT to Use

- Simple factual lookup (use web_search directly)
- Quick answer without proposal synthesis
- User explicitly asks for just a summary