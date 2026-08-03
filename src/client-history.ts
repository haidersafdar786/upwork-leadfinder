import type { ClientHistory, PastContract } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = nonNegativeNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function workHistory(record: unknown): unknown[] | null {
  const history = at(record, "details", "buyer", "workHistory");
  return Array.isArray(history) ? history : null;
}

function workHistoryReviews(history: readonly unknown[] | null): { count: number | null; rating: number | null } {
  if (!history) return { count: null, rating: null };
  const reviews = history.flatMap((entry) => {
    const review = isRecord(entry) && isRecord(entry.feedbackToClient) ? entry.feedbackToClient : null;
    return review ? [review] : [];
  });
  const scores = reviews.flatMap((review) => {
    const score = nonNegativeNumber(review.score);
    return score === null ? [] : [score];
  });
  return {
    count: reviews.length,
    rating: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
  };
}

export function clientHistoryFromRecord(record: unknown): ClientHistory {
  const history = workHistory(record);
  const reviewFallback = workHistoryReviews(history);
  const totalReviews = firstNumber(
    at(record, "details", "buyer", "info", "stats", "feedbackCount"),
    at(record, "feed", "client", "totalReviews"),
    reviewFallback.count,
  );
  const rawRating = firstNumber(
    at(record, "details", "buyer", "info", "stats", "score"),
    at(record, "feed", "client", "totalFeedback"),
    reviewFallback.rating,
  );

  return {
    totalSpent: firstNumber(
      at(record, "details", "buyer", "info", "stats", "totalCharges", "amount"),
      at(record, "feed", "client", "totalSpent"),
    ),
    totalHires: firstNumber(
      at(record, "feed", "client", "totalHires"),
      at(record, "details", "buyer", "info", "stats", "totalAssignments"),
      history?.length,
    ),
    totalReviews,
    rating: totalReviews === 0 ? null : rawRating,
  };
}

export function clientHistoryFromContracts(contracts: readonly PastContract[]): ClientHistory {
  const reviews = contracts.flatMap((contract) => contract.reviewToClient ? [contract.reviewToClient] : []);
  const scores = reviews.flatMap((review) => review.score === null ? [] : [review.score]);
  return {
    totalSpent: null,
    totalHires: contracts.length,
    totalReviews: reviews.length,
    rating: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null,
  };
}
