# claim-autonomy-review-command test report

Passed: 6/6

- PASS parseArgs accepts dry-run fixture flags
- PASS parseArgs accepts read-only claim-store flags
- PASS fixture-mode JSON report includes dry-run summary and receipts
- PASS text report prints lanes decisions and receipt summaries
- PASS --apply refuses before candidate processing and performs no mutation
- PASS runner errors exit nonzero but review refusals do not