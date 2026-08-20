import { z } from "zod";

/**
 * Deribit API Response Schemas
 */

export const DeribitTradeSchema = z.object({
  trade_seq: z.number(),
  trade_id: z.string(),
  timestamp: z.number(),
  tick_direction: z.number(),
  price: z.number(),
  mark_price: z.number().nullish(),
  instrument_name: z.string(),
  index_price: z.number(),
  direction: z.enum(["buy", "sell"]),
  amount: z.number(),
  iv: z.number().nullish(), // Implied volatility (percentage format: 19.06 = 19.06%)
});

export const DeribitTradesResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(), // Optional for GET requests
  result: z.object({
    trades: z.array(DeribitTradeSchema),
    has_more: z.boolean(),
  }),
});

export const DeribitDeliveryPriceSchema = z.object({
  date: z.string(), // YYYY-MM-DD format
  delivery_price: z.number(),
});

export const DeribitDeliveryPricesResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(), // Optional for GET requests
  result: z.object({
    data: z.array(DeribitDeliveryPriceSchema),
    records_total: z.number(),
  }),
});

export const DeribitInstrumentSchema = z.object({
  instrument_name: z.string(),
  kind: z.string(), // Can be "future", "option", "spot", "future_combo", "option_combo"
  base_currency: z.string(),
  expiration_timestamp: z.number().optional(),
  strike: z.number().optional(),
  option_type: z.string().optional(), // Can be "call", "put"
  is_active: z.boolean().nullable(),
  settlement_period: z.string().optional(),
});

export const DeribitInstrumentsResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(), // Optional for GET requests
  result: z.array(DeribitInstrumentSchema),
});

export const DeribitHistoricalVolatilitySchema = z.tuple([
  z.number(), // timestamp
  z.number(), // volatility value
]);

export const DeribitHistoricalVolatilityResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(),
  result: z.array(DeribitHistoricalVolatilitySchema),
});

/**
 * Domain Types
 */

export type DeribitTrade = z.infer<typeof DeribitTradeSchema>;
export type DeribitDeliveryPrice = z.infer<typeof DeribitDeliveryPriceSchema>;
export type DeribitInstrument = z.infer<typeof DeribitInstrumentSchema>;
export type DeribitHistoricalVolatility = z.infer<typeof DeribitHistoricalVolatilitySchema>;

export interface Trade {
  id: string;
  instrumentName: string;
  price: number;
  amount: number;
  direction: "buy" | "sell";
  timestamp: number;
  indexPrice: number;
  markPrice?: number;
  impliedVolatility?: number;
}

export interface DeliveryPrice {
  indexName: string;
  date: number;
  deliveryPrice: number;
}

export interface HistoricalVolatility {
  currency: string;
  timestamp: number;
  volatilityValue: number;
}

export interface Instrument {
  name: string;
  underlying: string;
  strike: number;
  expiration: number;
  optionType: "call" | "put";
  instrumentType: "option" | "future" | "perpetual";
}

export interface Greeks {
  instrumentName: string;
  timestamp: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  price: number;
  underlyingPrice: number;
  impliedVolatility: number;
}

export enum Moneyness {
  ITM = "ITM",
  ATM = "ATM",
  OTM = "OTM",
}

export interface OptionAnalysis {
  instrumentName: string;
  strike: number;
  expirationDate: number;
  optionType: "call" | "put";
  deliveryPrice: number;
  moneyness: Moneyness;
  greeks: Greeks;
}

export interface RiskFilter {
  name: string;
  underlying: string;
  deltaMin?: number;
  deltaMax?: number;
  gammaMin?: number;
  gammaMax?: number;
  vegaMin?: number;
  vegaMax?: number;
  thetaMin?: number;
  thetaMax?: number;
  moneynessFilter?: Moneyness[];
}

/**
 * Utility Functions
 */

export function parseInstrumentName(instrumentName: string): Instrument | null {
  // Formats:
  // - Perpetual: BTC-PERPETUAL
  // - Future: BTC-5AUG16, BTC-15JUL16 (2 parts)
  // - Option: BTC-8APR26-64500-P, BTC-29MAR24-50000-C (4 parts)
  const parts = instrumentName.split("-");

  const monthMap: Record<string, number> = {
    JAN: 0,
    FEB: 1,
    MAR: 2,
    APR: 3,
    MAY: 4,
    JUN: 5,
    JUL: 6,
    AUG: 7,
    SEP: 8,
    OCT: 9,
    NOV: 10,
    DEC: 11,
  };

  // Perpetual: BTC-PERPETUAL
  if (parts.length === 2 && parts[1] === "PERPETUAL") {
    return {
      name: instrumentName,
      underlying: parts[0]!,
      strike: 0,
      expiration: 0,
      optionType: "call",
      instrumentType: "perpetual",
    };
  }

  // Future: BTC-5AUG16 or BTC-15JUL16 (2 parts)
  if (parts.length === 2) {
    const [underlying, dateStr] = parts;

    // Parse date with flexible day length (1 or 2 digits): 5AUG16 or 15JUL16
    const dateMatch = dateStr!.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!dateMatch) return null;

    const day = parseInt(dateMatch[1]!);
    const monthStr = dateMatch[2]!;
    const year = 2000 + parseInt(dateMatch[3]!);

    const month = monthMap[monthStr];
    if (month === undefined) return null;

    const expiration = new Date(Date.UTC(year, month, day, 8, 0, 0)).getTime();

    return {
      name: instrumentName,
      underlying: underlying!,
      strike: 0,
      expiration,
      optionType: "call",
      instrumentType: "future",
    };
  }

  // Option: BTC-8APR26-64500-P or BTC-29MAR24-50000-C (4 parts)
  if (parts.length === 4) {
    const [underlying, dateStr, strikeStr, optionTypeStr] = parts;
    const optionType = optionTypeStr === "C" ? "call" : "put";
    const strike = parseFloat(strikeStr!);

    // Parse date with flexible day length (1 or 2 digits): 8APR26 or 29MAR24
    const dateMatch = dateStr!.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/);
    if (!dateMatch) return null;

    const day = parseInt(dateMatch[1]!);
    const monthStr = dateMatch[2]!;
    const year = 2000 + parseInt(dateMatch[3]!);

    const month = monthMap[monthStr];
    if (month === undefined) return null;

    const expiration = new Date(Date.UTC(year, month, day, 8, 0, 0)).getTime();

    return {
      name: instrumentName,
      underlying: underlying!,
      strike,
      expiration,
      optionType,
      instrumentType: "option",
    };
  }

  return null;
}

export function convertDeribitTradeToTrade(deribitTrade: DeribitTrade): Trade {
  return {
    id: deribitTrade.trade_id,
    instrumentName: deribitTrade.instrument_name,
    price: deribitTrade.price,
    amount: deribitTrade.amount,
    direction: deribitTrade.direction,
    timestamp: deribitTrade.timestamp,
    indexPrice: deribitTrade.index_price,
    markPrice: deribitTrade.mark_price,
    impliedVolatility: deribitTrade.iv,
  };
}
