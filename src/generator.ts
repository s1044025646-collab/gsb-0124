export interface GeneratorOptions {
  count: number;
  start: string;
  end: string;
  stores: string[];
  rng?: () => number;
  seed?: number;
  prefix?: string;
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateTransactions(options: GeneratorOptions) {
  if (!Number.isInteger(options.count) || options.count <= 0) throw new Error('count must be positive');
  if (options.stores.length === 0) throw new Error('at least one store is required');
  const rng = options.rng ?? mulberry32(options.seed ?? 1);
  const start = Date.parse(options.start);
  const end = Date.parse(options.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) throw new Error('invalid time range');
  const products = ['bread', 'butter', 'milk', 'eggs', 'cereal', 'coffee', 'tea', 'sugar', 'diaper', 'beer'];
  const transactions = [];
  for (let i = 0; i < options.count; i++) {
    const storeId = options.stores[Math.floor(rng() * options.stores.length)];
    const time = new Date(start + Math.floor(rng() * (end - start))).toISOString();
    const items = new Set<string>();
    const add = (product: string, probability: number) => { if (rng() < probability) items.add(product); };
    add('bread', 0.65);
    if (items.has('bread')) add('butter', 0.82);
    add('milk', 0.60);
    if (items.has('milk')) add('cereal', 0.42);
    add('diaper', 0.18);
    if (items.has('diaper')) add('beer', 0.70);
    for (const product of products) add(product, 0.04);
    if (items.size === 0) items.add('sugar');
    transactions.push({
      id: `${options.prefix ?? 'GEN'}-${String(i + 1).padStart(6, '0')}`,
      idempotencyKey: `demo:${options.prefix ?? 'GEN'}:${options.seed ?? 1}:${i + 1}`,
      storeId,
      time,
      lines: [...items].sort().map((product, index) => ({ lineRef: `L${index + 1}`, sku: product, quantity: 1 + Math.floor(rng() * 3) }))
    });
  }
  return transactions.sort((a, b) => a.time.localeCompare(b.time));
}
