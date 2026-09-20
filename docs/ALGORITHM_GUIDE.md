# Algorithm guide

These cards describe pure snapshot functions, not network latency, edge-cache
hit rates, or live benchmark results. The feed is already parsed before these
functions run.

## Extract a compact game snapshot

Implementation: [`extractSnapshot`](../src/snapshot.ts).

```text
# Snapshot Projection / Fixed-Field Extraction
# Input: parsed feed object, game ID, region, measured latency
# Output: fixed-field snapshot, or null if required feed sections are absent
# Time: O(1) with bounded field lengths and a three-character base state
# Memory: O(1) additional fixed-shape output under the same assumption

READ linescore and team sections
IF either is absent: RETURN null
READ inning, outs, scores and offense with defaults
ENCODE first/second/third base occupancy
CLIP run differential to [-5, 5]
CALL winProbability; round its result
RETURN selected fields, acquisition timestamp, region and latency
```

Downloading and parsing B bytes of JSON is separate O(B) work/storage.
Unbounded string fields also make output byte size variable, even though the
number of fields is fixed. The probability function is a heuristic; constant
runtime does not establish baseball-rule correctness or calibration.

## Detect changed fields

Implementation: [`computeDiff`](../src/snapshot.ts).

```text
# Snapshot Diff / Serialize and Compare Each Current Key
# Input: previous and current objects with K current top-level keys
# Output: references to current values whose serialized representations differ
# Time: O(K+B), for B total serialized characters examined
# Memory: O(K+M) auxiliary, plus O(K) output references
# M = largest pair of serialized field values held during a comparison

diff = empty object
FOR each key in current:
    IF JSON_STRINGIFY(previous[key]) != JSON_STRINGIFY(current[key]):
        diff[key] = current[key]
RETURN diff
```

This is not a recursive semantic diff: nested key order can change serialized
text, removed top-level keys are not reported, and a newly present `undefined`
value can compare equal to an absent value. Cycles and unsupported JSON values
can throw. The output holds references, not deep copies.

For the fixed primitive snapshot schema this is effectively constant-size.
For the generic `Record<string, any>` signature, claiming O(K) while ignoring
serialization would understate costs.
