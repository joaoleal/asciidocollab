// Wall-clock budget assertion for the print-appearance performance suites.
//
// Under `jest --coverage` the source is istanbul-instrumented, which inflates measured wall-clock
// time well beyond what the un-instrumented code takes. Asserting a millisecond budget in that pass
// measures the instrumentation, not the parser, so the budgets are asserted only when performance
// mode is on (the dedicated un-instrumented `--runInBand` pass in scripts/ci/unit.sh). In the
// coverage pass the tests still run — they are the only coverage for parts of the module — but the
// timing assertion is skipped. The budget VALUES are unchanged; only where they are measured moves.
const budgetsEnforced = process.env.ASCIIDOCOLLAB_PERF_BUDGETS !== 'off';

export function expectWithinBudget(elapsedMs: number, budgetMs: number): void {
  if (!budgetsEnforced) return;
  expect(elapsedMs).toBeLessThan(budgetMs);
}
