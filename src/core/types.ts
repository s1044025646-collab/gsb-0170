export interface CashFlow {
  payDate: string; // ISO date
  amount: number;
}

export interface InstrumentInput {
  instrumentId: string;
  quoteVersionId: string;
  cleanPrice: number;
  accruedInterest: number;
  cashflows: CashFlow[];
}

export interface CurveNode {
  payDate: string;
  yearFraction: number;
  discountFactor: number;
  zeroRate: number; // continuously compounded, ACT/365F
}

export interface Residual {
  instrumentId: string;
  maturityDate: string;
  modelDirtyPrice: number;
  quotedDirtyPrice: number;
  error: number; // model - quoted
}

export interface BootstrapResult {
  nodes: CurveNode[];
  residuals: Residual[];
}

export interface ValuationResult {
  dirtyPrice: number;
  cleanPrice: number; // dirty - accruedInterest passed in
  presentValues: { payDate: string; yearFraction: number; amount: number; df: number; pv: number }[];
}
