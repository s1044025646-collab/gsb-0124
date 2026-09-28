import { ApiError, type EffectiveBasket, type ItemsetResult, type MineParams, type MineResult, type RuleResult } from './types.js';

interface CandidateSet { items: string[]; key: string; }

export function mine(baskets: EffectiveBasket[], params: MineParams): MineResult {
  const minSupport = params.minSupport;
  const minConfidence = params.minConfidence;
  const maxCandidates = params.maxCandidates;
  if (!Number.isFinite(minSupport) || minSupport <= 0 || minSupport > 1) throw new ApiError(400, 'INVALID_MIN_SUPPORT', 'minSupport must be in (0,1]');
  if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new ApiError(400, 'INVALID_MIN_CONFIDENCE', 'minConfidence must be in [0,1]');
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) throw new ApiError(400, 'INVALID_MAX_CANDIDATES', 'maxCandidates must be a positive integer');

  const denominator = baskets.length;
  const encoded = baskets.map(b => new Set(b.items));
  const supportByKey = new Map<string, number>();
  const samplesByKey = new Map<string, string[]>();
  const itemsets: ItemsetResult[] = [];
  let candidateCount = 0;
  let incomplete = false;
  let truncationReason: string | null = null;

  function account(candidates: CandidateSet[]): Map<string, Set<number>> {
    const matches = new Map<string, Set<number>>();
    for (const candidate of candidates) {
      candidateCount++;
      if (candidateCount > maxCandidates) {
        incomplete = true;
        truncationReason = `candidate limit ${maxCandidates} reached; remaining search space was not evaluated`;
        return matches;
      }
      const matchedTx = new Set<number>();
      encoded.forEach((basket, index) => {
        if (candidate.items.every(item => basket.has(item))) matchedTx.add(index);
      });
      if (matchedTx.size > 0) matches.set(candidate.key, matchedTx);
    }
    return matches;
  }

  function keep(matches: Map<string, Set<number>>, candidates: CandidateSet[]): CandidateSet[] {
    const kept: CandidateSet[] = [];
    for (const candidate of candidates) {
      const matchedTx = matches.get(candidate.key);
      if (!matchedTx) continue;
      const count = matchedTx.size;
      if (denominator > 0 && count / denominator >= minSupport) {
        supportByKey.set(candidate.key, count);
        const samples = params.includeSamples === false ? [] : [...matchedTx].slice(0, params.sampleSize ?? 20).map(i => baskets[i].transactionId);
        samplesByKey.set(candidate.key, samples);
        itemsets.push({ items: candidate.items, supportCount: count, support: count / denominator, sampleTransactionIds: samples });
        kept.push(candidate);
      }
    }
    return kept;
  }

  if (denominator > 0) {
    const singletonMap = new Map<string, string>();
    for (const basket of baskets) for (const item of basket.items) if (!singletonMap.has(item)) singletonMap.set(item, item);
    let current = [...singletonMap.keys()].sort().map(items => ({ items: [items], key: items }));
    let matches = account(current);
    if (incomplete) current = [];
    current = keep(matches, current);

    while (current.length > 1) {
      const next = generateCandidates(current);
      if (next.length === 0) break;
      candidateCount += next.length;
      if (candidateCount > maxCandidates) {
        incomplete = true;
        truncationReason = `candidate limit ${maxCandidates} reached while generating ${current[0].items.length + 1}-itemsets; results are partial`;
        break;
      }
      matches = account(next);
      if (incomplete) break;
      current = keep(matches, next);
    }
  }

  const rules: RuleResult[] = [];
  for (const itemset of itemsets.filter(x => x.items.length >= 2)) {
    const keyOf = (items: string[]) => items.join('|');
    const unionCount = itemset.supportCount;
    for (let mask = 1; mask < (1 << itemset.items.length) - 1; mask++) {
      const antecedent = itemset.items.filter((_item: string, i: number) => mask & (1 << i));
      const consequent = itemset.items.filter((_item: string, i: number) => !(mask & (1 << i)));
      const antecedentCount = supportByKey.get(keyOf(antecedent));
      const consequentCount = supportByKey.get(keyOf(consequent));
      if (antecedentCount === undefined || consequentCount === undefined || denominator === 0) continue;
      const confidence = unionCount / antecedentCount;
      const expected = (antecedentCount / denominator) * (consequentCount / denominator);
      const lift = expected === 0 ? null : (unionCount / denominator) / expected;
      if (confidence >= minConfidence) {
        rules.push({
          antecedent,
          consequent,
          supportCount: unionCount,
          support: unionCount / denominator,
          confidence,
          lift,
          sampleTransactionIds: samplesByKey.get(keyOf(itemset.items)) ?? []
        });
      }
    }
  }

  itemsets.sort((a, b) => b.items.length - a.items.length || b.supportCount - a.supportCount || a.items.join('|').localeCompare(b.items.join('|')));
  rules.sort((a, b) => b.lift! - a.lift! || b.confidence! - a.confidence! || a.antecedent.join('|').localeCompare(b.antecedent.join('|')));
  return { denominator, baskets, itemsets, rules, incomplete, truncationReason, candidateCount };
}

function generateCandidates(previous: CandidateSet[]): CandidateSet[] {
  const keys = new Set(previous.map(c => c.key));
  const result = new Map<string, CandidateSet>();
  for (let i = 0; i < previous.length; i++) {
    for (let j = i + 1; j < previous.length; j++) {
      const a = previous[i].items;
      const b = previous[j].items;
      const prefixLength = a.length - 1;
      if (!a.slice(0, prefixLength).every((value, index) => value === b[index])) continue;
      const items = [...a, b[prefixLength]].sort();
      if (!allSubsetsFrequent(items, keys)) continue;
      const key = items.join('|');
      result.set(key, { items, key });
    }
  }
  return [...result.values()];
}

function allSubsetsFrequent(items: string[], frequentKeys: Set<string>): boolean {
  for (let skip = 0; skip < items.length; skip++) {
    const subset = items.filter((_, index) => index !== skip);
    if (!frequentKeys.has(subset.join('|'))) return false;
  }
  return true;
}

