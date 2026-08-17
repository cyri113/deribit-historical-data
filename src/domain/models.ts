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
  mark_price: z.number().optional(),
  instrument_name: z.string(),
  index_price: z.number(),
  direction: z.enum(["buy", "sell"]),
  amount: z.number(),
  iv: z.number().optional(), // Implied volatility
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
  date: z.number(),
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
  is_active: z.boolean(),
  settlement_period: z.string().optional(),
});

export const DeribitInstrumentsResponseSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(), // Optional for GET requests
  result: z.array(DeribitInstrumentSchema),
});

/**
 * Domain Types
 */

export type DeribitTrade = z.infer<typeof DeribitTradeSchema>;
export type DeribitDeliveryPrice = z.infer<typeof DeribitDeliveryPriceSchema>;
export type DeribitInstrument = z.infer<typeof DeribitInstrumentSchema>;

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
  // Format: BTC-29MAR24-50000-C or ETH-PERPETUAL
  const parts = instrumentName.split("-");

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

  if (parts.length === 4) {
    const [underlying, dateStr, strikeStr, optionTypeStr] = parts;
    const optionType = optionTypeStr === "C" ? "call" : "put";
    const strike = parseFloat(strikeStr!);

    // Parse date (e.g., "29MAR24")
    const day = parseInt(dateStr!.slice(0, 2));
    const monthStr = dateStr!.slice(2, 5);
    const year = 2000 + parseInt(dateStr!.slice(5, 7));

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

    const month = monthMap[monthStr!];
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
