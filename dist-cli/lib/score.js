"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WEIGHTS = void 0;
exports.mergeWeights = mergeWeights;
exports.temporal = temporal;
exports.scoreItem = scoreItem;
exports.scoreAll = scoreAll;
const item_1 = require("./item");
const DAY = 24 * 60 * 60 * 1000;
exports.DEFAULT_WEIGHTS = {
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
function mergeWeights(partial) {
    if (partial === null || typeof partial !== "object")
        return exports.DEFAULT_WEIGHTS;
    const given = partial;
    return {
        ...exports.DEFAULT_WEIGHTS,
        ...given,
        signals: { ...exports.DEFAULT_WEIGHTS.signals, ...(given.signals ?? {}) },
    };
}
function signalMatches(signal, item) {
    if (signal.itemIds?.includes(item.id))
        return true;
    if (signal.project && item.project === signal.project)
        return true;
    if (signal.cluster && item.cluster === signal.cluster)
        return true;
    if (signal.tags?.some((tag) => item.tags.includes(tag)))
        return true;
    if (signal.match && (0, item_1.matches)(item, signal.match))
        return true;
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
function temporal(signal, weights, now) {
    if (signal.expiresAt !== undefined && now > signal.expiresAt)
        return 0;
    if (signal.at !== undefined) {
        const daysUntil = (signal.at - now) / DAY;
        if (daysUntil > weights.meetingHorizonDays)
            return 0;
        if (daysUntil >= 0)
            return 1 - daysUntil / weights.meetingHorizonDays;
        // Just happened: follow-ups are the most live thing on the list.
        if (daysUntil > -1)
            return 1;
        return Math.pow(0.5, (-daysUntil - 1) / weights.decayHalfLifeDays);
    }
    const daysSince = (now - signal.ts) / DAY;
    if (daysSince <= 0)
        return 1;
    return Math.pow(0.5, daysSince / weights.decayHalfLifeDays);
}
function isStale(item, weights, now) {
    return item.status === "todo" && now - item.createdAt > weights.staleDays * DAY;
}
/**
 * Combines contributions so that several weak signals can add up to something
 * meaningful without any single one ever pushing past 1. Two 0.6s make 0.84, not
 * 1.2 — accumulation with a natural ceiling, and no clamping artefacts.
 */
function combine(amounts) {
    return 1 - amounts.reduce((remaining, amount) => remaining * (1 - amount), 1);
}
function scoreItem(item, signals, weights, now = Date.now()) {
    const contributions = [];
    for (const signal of signals) {
        if (!signalMatches(signal, item))
            continue;
        const base = weights.signals[signal.kind] ?? weights.default;
        const amount = base * (signal.weight ?? 1) * temporal(signal, weights, now);
        if (amount > 0.001)
            contributions.push({ signal, amount });
    }
    contributions.sort((a, b) => b.amount - a.amount);
    const amounts = contributions.map((c) => c.amount);
    if (isStale(item, weights, now))
        amounts.push(weights.stale);
    const priority = combine(amounts);
    // The reasoning the owner actually reads, assembled from what fired rather than
    // narrated by a model. Two signals is plenty; more reads as noise.
    const why = contributions
        .slice(0, 2)
        .map((c) => c.signal.note)
        .join(" · ");
    return { priority, why, contributions };
}
/**
 * Rescores every eligible item.
 *
 * Priority is wholly derived, so this clears it where nothing applies — otherwise
 * last week's meeting would pin something to the top of the list forever. Pinned
 * and done items are left exactly as they are.
 */
function scoreAll(items, signals, weights, now = Date.now()) {
    return items.map((item) => {
        if (item.pinned || item.status === "done")
            return { item, score: { priority: 0, why: "", contributions: [] }, changed: false };
        const score = scoreItem(item, signals, weights, now);
        const priority = score.priority < 0.01 ? undefined : Math.round(score.priority * 100) / 100;
        const why = priority === undefined ? undefined : score.why || undefined;
        return { item: { ...item, priority, why }, score, changed: item.priority !== priority || item.why !== why };
    });
}
