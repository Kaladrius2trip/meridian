export function pickLeastLoaded(counts: Record<string, number>, eligible: string[]): string {
  const [first, ...rest] = eligible
  if (first === undefined) {
    throw new Error("pickLeastLoaded: eligible must be non-empty")
  }

  let leastLoaded = first
  for (const id of rest) {
    if ((counts[id] ?? 0) < (counts[leastLoaded] ?? 0)) {
      leastLoaded = id
    }
  }
  return leastLoaded
}
