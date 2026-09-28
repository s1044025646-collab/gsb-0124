// Pure frequent-itemset mining (Apriori) and association rule generation.
// A transaction is a SET: duplicate items and multi-qty never inflate support.

export type Itemset = string[]; // sorted item keys

export interface ItemsetResult {
  items: Itemset;
  supportCount: number;
  support: number;
  sampleTxnIds: number[];
}

export interface RuleResult {
  antecedent: Itemset;
  consequent: Itemset;
  supportCount: number; // count(antecedent ∪ consequent)
  support: number;
  confidence: number;
  lift: number;
  antecedentCount: number;
  sampleTxnIds: number[];
}

export interface MineOptions {
  minSupport: number; // absolute minimum support count
  minConfidence: number; // [0,1]
  maxCandidates: number; // safety cap on generated candidates per level
  maxItemsetSize: number;
  sampleSize: number;
}

export interface MineResult {
  denominator: number;
  itemsets: ItemsetResult[];
  rules: RuleResult[];
  complete: boolean;
  capReason?: string;
}

const key = (items: Itemset): string => items.join('\u0001');
const unionSorted = (a: Itemset, b: Itemset): Itemset =>
  Array.from(new Set([...a, ...b])).sort();

// Join two (k-1)-itemsets sharing their first k-2 items -> k candidates.
function aprioriGen(prev: Itemset[]): Itemset[] {
  const out: Itemset[] = [];
  const set = new Set(prev.map(key));
  for (let i = 0; i < prev.length; i++) {
    for (let j = i + 1; j < prev.length; j++) {
      const a = prev[i];
      const b = prev[j];
      let shared = 0;
      while (shared < a.length - 1 && a[shared] === b[shared]) shared++;
      if (shared !== a.length - 1) continue;
      const cand = [...a.slice(0, a.length - 1), a[a.length - 1], b[b.length - 1]].sort();
      // all (k-1)-subsets must be frequent
      let allSubsets = true;
      for (let skip = 0; skip < cand.length; skip++) {
        const sub = cand.filter((_, idx) => idx !== skip);
        if (!set.has(key(sub))) {
          allSubsets = false;
          break;
        }
      }
      if (allSubsets) out.push(cand);
    }
  }
  return out;
}

export function mine(
  baskets: { txnId: number; items: Itemset }[],
  opts: MineOptions
): MineResult {
  const denominator = baskets.length;
  const complete = true;
  let capReason: string | undefined;

  // Map itemset key -> {count, txnIds}
  const frequent: Map<string, { items: Itemset; txnIds: number[] }> = new Map();
  const results: ItemsetResult[] = [];

  const record = (items: Itemset, txnIds: number[]): void => {
    const k = key(items);
    frequent.set(k, { items, txnIds });
    results.push({
      items,
      supportCount: txnIds.length,
      support: denominator === 0 ? 0 : txnIds.length / denominator,
      sampleTxnIds: txnIds.slice(0, opts.sampleSize)
    });
  };

  if (denominator === 0) {
    // Empty population: no metrics can be fabricated.
    return { denominator, itemsets: [], rules: [], complete: true };
  }

  // Level 1: count distinct items (sets, so dedup within basket first).
  const l1Map = new Map<string, number[]>();
  for (const b of baskets) {
    const uniq = Array.from(new Set(b.items)).sort();
    for (const item of uniq) {
      const arr = l1Map.get(item);
      if (arr) arr.push(b.txnId);
      else l1Map.set(item, [b.txnId]);
    }
  }
  let level: Itemset[] = [];
  for (const [item, txnIds] of l1Map) {
    if (txnIds.length >= opts.minSupport) {
      const items = [item];
      level.push(items);
      record(items, txnIds);
    }
  }
  level.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  let candidatesGenerated = level.length;

  for (let size = 2; size <= opts.maxItemsetSize && level.length > 0; size++) {
    let cands = aprioriGen(level);
    // de-dup candidates
    cands = Array.from(new Map(cands.map((c) => [key(c), c])).values());
    candidatesGenerated += cands.length;
    if (cands.length > opts.maxCandidates) {
      capReason = `candidate cap: level ${size} produced ${cands.length} > maxCandidates ${opts.maxCandidates}`;
      complete = false;
      break;
    }
    if (candidatesGenerated > opts.maxCandidates) {
      capReason = `cumulative candidate cap ${opts.maxCandidates} exceeded at level ${size}`;
      complete = false;
      break;
    }

    // Count candidates by subset scanning of baskets.
    const counts = new Map<string, number[]>();
    for (const c of cands) counts.set(key(c), []);
    for (const b of baskets) {
      const uniq = new Set(b.items);
      for (const c of cands) {
        if (c.every((it) => uniq.has(it))) counts.get(key(c))!.push(b.txnId);
      }
    }
    const next: Itemset[] = [];
    for (const c of cands) {
      const txnIds = counts.get(key(c))!;
      if (txnIds.length >= opts.minSupport) {
        next.push(c);
        record(c, txnIds);
      }
    }
    level = next;
  }

  // Association rules from frequent itemsets of size >= 2.
  const rules: RuleResult[] = [];
  const itemsetTxns = new Map<string, number[]>();
  for (const f of frequent.values()) itemsetTxns.set(key(f.items), f.txnIds);

  for (const { items, txnIds } of frequent.values()) {
    if (items.length < 2) continue;
    const n = items.length;
    // Every non-empty proper subset as antecedent; disjoint consequent.
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      const ant: Itemset = [];
      const con: Itemset = [];
      for (let i = 0; i < n; i++) (mask & (1 << i) ? ant : con).push(items[i]);
      const antTxns = itemsetTxns.get(key(ant));
      const conTxns = itemsetTxns.get(key(con));
      if (!antTxns || !conTxns) continue; // subset must be frequent
      const antCount = antTxns.length;
      const conCount = conTxns.length;
      const bothCount = txnIds.length;
      if (antCount === 0) continue; // no fabricated metric on empty denominator
      const confidence = bothCount / antCount;
      if (confidence < opts.minConfidence) continue;
      const support = bothCount / denominator;
      // lift = confidence / P(consequent); 0 denominator => undefined
      const lift = conCount === 0 || denominator === 0 ? NaN : confidence / (conCount / denominator);
      rules.push({
        antecedent: ant,
        consequent: con,
        supportCount: bothCount,
        support,
        confidence,
        lift,
        antecedentCount: antCount,
        sampleTxnIds: txnIds.slice(0, opts.sampleSize)
      });
    }
  }
  rules.sort(
    (a, b) =>
      b.confidence - a.confidence || b.lift - a.lift || b.supportCount - a.supportCount
  );

  return { denominator, itemsets: results, rules, complete, capReason };
}

// Exhaustive enumeration over the power set of all items: ground truth for
// tests. Returns every itemset with its exact support count (no min threshold).
export function exhaustiveItemsets(
  baskets: { txnId: number; items: Itemset }[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of baskets) {
    const uniq = Array.from(new Set(b.items)).sort();
    for (let mask = 1; mask < 1 << uniq.length; mask++) {
      const sub: Itemset = [];
      for (let i = 0; i < uniq.length; i++) if (mask & (1 << i)) sub.push(uniq[i]);
      const k = key(sub);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return counts;
}
