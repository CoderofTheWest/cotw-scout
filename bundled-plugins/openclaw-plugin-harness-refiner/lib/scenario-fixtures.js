'use strict';

function getScenarioFixtures() {
  return [
    {
      id: 'tool-loop-without-new-evidence',
      title: 'Tool loop without new evidence',
      expectedSignatures: ['tool_loop', 'repeated_tool_failure', 'low_surprise_drift'],
      window: {
        id: 'fixture-tool-loop',
        mode: 'code',
        messages: [
          { role: 'user', content: 'Run the failing test and fix the smallest thing.' },
          { role: 'assistant', content: 'The command failed. Next I will verify the same output.' }
        ],
        toolCalls: [
          { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: failed', success: false },
          { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: failed', success: false },
          { toolName: 'exec', params: { cmd: 'npm test' }, result: 'Error: failed', success: false }
        ],
        cognitiveSnapshot: { surpriseFrozen: 0.12, surpriseLearned: 0.1, featureAvailability: { timing: true, thread_context: true } },
        sourceHandles: ['source:test-log']
      }
    },
    {
      id: 'attachment-certainty-receipt-mismatch',
      title: 'Attachment certainty / receipt mismatch',
      expectedSignatures: ['receipt_mismatch'],
      window: {
        id: 'fixture-receipt-mismatch',
        messages: [
          { role: 'user', content: 'Can you inspect the image?' },
          { role: 'assistant', content: 'I saw it clearly and verified the object in the image.' }
        ],
        toolCalls: [],
        sourceHandles: [],
        metadata: { receiptMismatch: true }
      }
    },
    {
      id: 'mode-bleed-after-exit',
      title: 'Mode bleed after exit',
      expectedSignatures: ['mode_bleed'],
      window: {
        id: 'fixture-mode-bleed',
        mode: 'normal',
        messages: [
          { role: 'user', content: 'Back to normal chat.' },
          { role: 'assistant', content: 'In Code mode, I will continue the patch plan.' }
        ],
        metadata: { modeMismatch: true }
      }
    },
    {
      id: 'correction-not-integrated',
      title: 'Correction not integrated',
      expectedSignatures: ['correction_not_integrated'],
      window: {
        id: 'fixture-correction',
        messages: [
          { role: 'user', content: 'Actually, I meant the runtime config, not the bundled template.' },
          { role: 'assistant', content: 'I will continue editing the template.' }
        ],
        toolCalls: [
          { toolName: 'edit', params: { file: 'template.json' }, result: 'Error: wrong target', success: false }
        ]
      }
    }
  ];
}

module.exports = {
  getScenarioFixtures
};
