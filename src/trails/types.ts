export type TrailCosting = 'auto' | 'pedestrian' | 'bicycle' | 'motorcycle';

export interface TrailNode {
  spotId: string;
  value: number;
  dwellMin: number;
  windows: Array<[number, number]>;
  crowdByHour: number[];
  category: string;
  lat?: number;
  lng?: number;
  municipality?: string;
  title?: string;
  description?: string;
}

export interface TrailProblem {
  nodes: TrailNode[];
  startNode?: string | { lat: number; lng: number };
  dayStartMin: number;
  budgetMin: number;
  minStops: number;
  maxStops: number;
  maxLegMin: number;
  maxPerCategory: number;
  mustInclude: string[];
  exclude: string[];
  weights: { crowdPenalty: number; travelPenalty: number };
  seed: number;
  costing?: TrailCosting;
}

export interface TrailLeg { minutes: number; km: number; approximate: boolean }
export type TrailLegLookup = (from: string, to: string) => TrailLeg | undefined;

export interface TrailSolution {
  stops: Array<{ spotId: string; arriveMin: number; departMin: number }>;
  objective: number;
  totalMin: number;
  totalKm: number;
  feasible: boolean;
  solver: 'local' | 'exact' | 'cuopt';
  ms: number;
}

export const DEFAULT_SIGNAL_WEIGHTS = Object.freeze({ quality: 0.2, popularity: 0.25, trend: 0.2, fit: 0.3, novelty: 0.05 });

export interface SpotSignalInput {
  spotId: string;
  category: string;
  goodFor: string[];
  description: string;
  approvedPhotoCount: number;
  sourceType: string;
  saves30d: number;
  interactions30d: number;
  questCompletions30d: number;
  priorVisit?: boolean;
  lat?: number;
  lng?: number;
  municipality?: string;
  bestTime?: string[];
  crowdByHour?: number[];
  title?: string;
}

export interface TrailSignalRequest { themes?: string[]; goodFor?: string[]; trendThemes?: Array<{ label?: string; categories?: string[]; good_for?: string[]; weight?: number }> }
export interface TrailSignal { spotId: string; components: { quality: number; popularity: number; trend: number; fit: number; novelty: number }; value: number }
