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

export function relocate(current: string, counts: Record<string, number>, eligible: string[]): string {
  const remaining = eligible.filter((id) => id !== current)
  return remaining.length === 0 ? current : pickLeastLoaded(counts, remaining)
}

export interface SelectProfileInput {
  explicit?: string
  mapped?: string
  counts: Record<string, number>
  eligible: string[]
  activeId?: string
  defaultId?: string
}

export function selectProfileForRoot(
  input: SelectProfileInput,
): { profileId: string; firstSeen: boolean } {
  if (input.explicit) {
    return { profileId: input.explicit, firstSeen: false }
  }
  if (input.mapped) {
    return { profileId: input.mapped, firstSeen: false }
  }
  if (input.eligible.length > 0) {
    return { profileId: pickLeastLoaded(input.counts, input.eligible), firstSeen: true }
  }

  const profileId = input.activeId ?? input.defaultId
  if (profileId === undefined) {
    throw new Error("selectProfileForRoot: no profile available")
  }
  return { profileId, firstSeen: true }
}
