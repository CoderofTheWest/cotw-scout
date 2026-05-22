---
name: nightshift
description: Manually trigger a nightshift run when the overnight window was missed
trigger: /nightshift
---

# /nightshift — Manual Nightshift Trigger

The user is asking you to run the overnight processing now. This is a belt-and-suspenders failsafe for when the automatic overnight window didn't fire (or when they just want to kick it manually).

The nightshift plugin listens for this command and fires forceRun() in the background — you don't have to do anything procedural. The safety gates (user-active, already-processing) still apply.

[NIGHTSHIFT_FORCE_RUN]

## Response

Keep it short — one line. Something grounded like:

"Running nightshift now. Give it a minute or two."

Or in your own voice. No need to explain what nightshift does unless they ask.
