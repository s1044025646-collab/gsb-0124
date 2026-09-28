export interface Product { id: string; name: string; }
export interface Store { id: string; name: string; }

export interface TransactionInput {
  id: string;
  storeId: string;
  time: string;
  lines: { lineRef?: string; sku: string; quantity: number }[];
  idempotencyKey?: string;
}

export interface BasketContext {
  storeId?: string;
  start?: string;
  end?: string;
  asOf?: string;
  mappingVersionId?: number;
}

export interface EffectiveBasket {
  transactionId: string;
  storeId: string;
  time: string;
  items: string[];
}

export interface MineParams {
  minSupport: number;
  minConfidence: number;
  maxCandidates: number;
  storeId?: string;
  start?: string;
  end?: string;
  asOf?: string;
  mappingVersionId?: number;
  includeSamples?: boolean;
  sampleSize?: number;
}

export interface ItemsetResult {
  items: string[];
  supportCount: number;
  support: number;
  sampleTransactionIds: string[];
}

export interface RuleResult {
  antecedent: string[];
  consequent: string[];
  supportCount: number;
  support: number;
  confidence: number | null;
  lift: number | null;
  sampleTransactionIds: string[];
}

export interface MineResult {
  denominator: number;
  baskets: EffectiveBasket[];
  itemsets: ItemsetResult[];
  rules: RuleResult[];
  incomplete: boolean;
  truncationReason: string | null;
  candidateCount: number;
}

export interface Page<T> { data: T[]; limit: number; nextCursor: string | null; }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
