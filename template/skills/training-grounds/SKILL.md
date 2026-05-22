---
name: Training Grounds
description: Enter the Training Grounds — guided lessons for learning to work with your agent
user-invocable: true
---

# Training Grounds

Read the user's training progress from `training-grounds/progress.json` and the lesson plan from `training-grounds/SPINE-WEEK-1.md`.

If the user has not started yet (no `startedAt`), welcome them and begin with Day 1, Lesson 1.

If the user is returning, pick up where they left off based on `lessonsCompleted` and `currentDay`.

Follow the Trail Ride protocol and voice rules from `training-grounds/TRAINING-GROUNDS.md`.

Always end your response with a `[TRAINING_OPTIONS]` block containing 2-3 next steps.

## Progression Updates

After completing each lesson, update **both**:
1. `training-grounds/progress.json` — mark lesson completed, update `currentDay`
2. `TRAILHEAD.md` — update competency signals:
   - Increment "Sessions completed" if this is a new session
   - Mark "Used a slash command unprompted" as yes (they used /training-grounds)
   - After completing all Week 1 lessons, check Tier 2 (Trailhand) readiness criteria and update Current Tier if met
