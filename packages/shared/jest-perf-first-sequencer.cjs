// Runs the wall-clock performance suites (tests/print-appearance) before every other suite.
//
// Those suites assert millisecond budgets against the largest theme document the module accepts.
// Under jest's default run the Node process accumulates heap across earlier suites, so by the time
// the heaviest case runs its resolve timing is inflated by GC pauses rather than by the code under
// test, and the budget flakes. Ordering the performance suites first lets them execute on a clean
// heap — the same conditions their budgets were written for — while the rest of the suite still runs
// in the same invocation, keeping coverage accounting whole. Pair this with a single worker
// (--runInBand) so the timings also reflect the code rather than scheduler contention.
const PERF_PATH_FRAGMENT = `${require('node:path').sep}print-appearance${require('node:path').sep}`;

const isPerf = (test) => test.path.includes(PERF_PATH_FRAGMENT);

class PerfFirstSequencer {
  // Performance suites first; everything else keeps its incoming (stable) order.
  sort(tests) {
    return [...tests].sort((a, b) => Number(isPerf(b)) - Number(isPerf(a)));
  }

  // No cross-run cache is used, so re-run-failed and result caching are no-ops.
  allFailedTests() {
    return [];
  }

  cacheResults() {}

  // Preserve jest's default sharding contract (used by --shard); we only reorder.
  shard(tests, { shardIndex, shardCount }) {
    const ordered = [...tests].sort((a, b) => (a.path > b.path ? 1 : a.path < b.path ? -1 : 0));
    return ordered.filter((_, index) => index % shardCount === shardIndex - 1);
  }
}

module.exports = PerfFirstSequencer;
