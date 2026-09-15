import { Item, matches } from "./item";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Something an agent observed in the world that should bear on what matters now.
 *
 * Agents emit these; they do not set priority. The split is deliberate — an
 * observation ("there's a trading-fee meeting Thursday") is a fact a model is good
 * at noticing, while turning facts into a ranking is arithmetic the owner should be
 * able to read, retune and reproduce.
 */
export interface Signal {
  id: string;
  ts: number;
  kind: string;
  source: string;
  note: string;

  // Targeting — at least one. A signal matches an item if any of these do.
  itemIds?: string[];
  project?: string;
  cluster?: string;
  tags?: string[];
  match?: string;

  // Temporal shape.
  at?: number;
  expiresAt?: number;
  weight?: number;
}

export interface Weights {
  signals: Record<string, number>;
  default: number;
  stale: number;
  decayHalfLifeDays: number;
  meetingHorizonDays: number;
  staleDays: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  signals: {
    deadline: 0.9,
    meeting: 0.8,
    blocking: 0.7,
    unblocked: 0.6,
    mentioned: 0.3,
  },
  default: 0.4,
  stale: 0.15,
  decayHalfLifeDays: 3,
  meetingHorizonDays: 7,
  staleDays: 14,
};

export function mergeWeights(partial: unknown): Weights {
  if (partial === null || typeof partial !== "object") return DEFAULT_WEIGHTS;
  const given = partial as Partial<Weights>;
  return {
    ...DEFAULT_WEIGHTS,
    ...given,
    signals: { ...DEFAULT_WEIGHTS.signals, ...(given.signals ?? {}) },
  };
}

function signalMatches(signal: Signal, item: Item): boolean {
  if (signal.itemIds?.includes(item.id)) return true;
  if (signal.project && item.project === signal.project) return true;
  if (signal.cluster && item.cluster === signal.cluster) return true;
  if (signal.tags?.some((tag) => item.tags.includes(tag))) return true;
  if (signal.match && matches(item, signal.match)) return true;
  return false;
}

/**
 * How much of a signal's weight still applies, between 0 and 1.
 *
 * Two different shapes, because two different things are being modelled. A meeting
 * gets *more* urgent as it approaches and stays hot briefly afterwards for the
 * follow-ups. An observation — a review landing, a mention — is most informative
 * the moment it happens and fades from there.
 */
export function temporal(signal: Signal, weights: Weights, now: number): number {
  if (signal.expiresAt !== undefined && now > signal.expiresAt) return 0;

  if (signal.at !== undefined) {
    const daysUntil = (signal.at - now) / DAY;
    if (daysUntil > weights.meetingHorizonDays) return 0;
    if (daysUntil >= 0) return 1 - daysUntil / weights.meetingHorizonDays;
    // Just happened: follow-ups are the most live thing on the list.
    if (daysUntil > -1) return 1;
    return Math.pow(0.5, (-daysUntil - 1) / weights.decayHalfLifeDays);
  }

  const daysSince = (now - signal.ts) / DAY;
  if (daysSince <= 0) return 1;
  return Math.pow(0.5, daysSince / weights.decayHalfLifeDays);
}

export interface Contribution {
  signal: Signal;
  amount: number;
}

export interface Score {
  priority: number;
  why: string;
  contributions: Contribution[];
}

function isStale(item: Item, weights: Weights, now: number): boolean {
  return item.status === "todo" && now - item.createdAt > weights.staleDays * DAY;
}

/**
 * Combines contributions so that several weak signals can add up to something
 * meaningful without any single one ever pushing past 1. Two 0.6s make 0.84, not
 * 1.2 — accumulation with a natural ceiling, and no clamping artefacts.
 */
function combine(amounts: number[]): number {
  return 1 - amounts.reduce((remaining, amount) => remaining * (1 - amount), 1);
}

export function scoreItem(item: Item, signals: Signal[], weights: Weights, now = Date.now()): Score {
  const contributions: Contribution[] = [];

  for (const signal of signals) {
    if (!signalMatches(signal, item)) continue;
    const base = weights.signals[signal.kind] ?? weights.default;
    const amount = base * (signal.weight ?? 1) * temporal(signal, weights, now);
    if (amount > 0.001) contributions.push({ signal, amount });
  }

  contributions.sort((a, b) => b.amount - a.amount);

  const amounts = contributions.map((c) => c.amount);
  if (isStale(item, weights, now)) amounts.push(weights.stale);

  const priority = combine(amounts);

  // The reasoning the owner actually reads, assembled from what fired rather than
  // narrated by a model. Two signals is plenty; more reads as noise.
  const why = contributions
    .slice(0, 2)
    .map((c) => c.signal.note)
    .join(" · ");

  return { priority, why, contributions };
}

export interface Scored {
  item: Item;
  score: Score;
  changed: boolean;
}

/**
 * Rescores every eligible item.
 *
 * Priority is wholly derived, so this clears it where nothing applies — otherwise
 * last week's meeting would pin something to the top of the list forever. Pinned
 * and done items are left exactly as they are.
 */
export function scoreAll(items: Item[], signals: Signal[], weights: Weights, now = Date.now()): Scored[] {
  return items.map((item) => {
    if (item.pinned || item.status === "done")
      return { item, score: { priority: 0, why: "", contributions: [] }, changed: false };

    const score = scoreItem(item, signals, weights, now);
    const priority = score.priority < 0.01 ? undefined : Math.round(score.priority * 100) / 100;
    const why = priority === undefined ? undefined : score.why || undefined;

    return { item: { ...item, priority, why }, score, changed: item.priority !== priority || item.why !== why };
  });
}
