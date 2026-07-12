export type QueryReleaseOutcome = "rate_limit" | "ok"

type GatedCall = {
  readonly configDir: string | undefined
  readonly release: (outcome: QueryReleaseOutcome) => void
  released: boolean
}

type CallWaiter = {
  readonly count: number
  readonly resolve: () => void
}

let gatingEnabled = false
let gatedCalls: GatedCall[] = []
let callWaiters: CallWaiter[] = []

export function enableQueryGating(): void {
  gatingEnabled = true
}

export function resetQueryGating(): void {
  for (const call of gatedCalls) {
    if (!call.released) call.release("ok")
  }
  for (const waiter of callWaiters) waiter.resolve()
  gatingEnabled = false
  gatedCalls = []
  callWaiters = []
}

export async function enterGatedCall(configDir: string | undefined): Promise<QueryReleaseOutcome | undefined> {
  if (!gatingEnabled) return undefined

  const deferred = Promise.withResolvers<QueryReleaseOutcome>()
  gatedCalls.push({ configDir, release: deferred.resolve, released: false })
  const ready = callWaiters.filter((waiter) => waiter.count <= gatedCalls.length)
  callWaiters = callWaiters.filter((waiter) => waiter.count > gatedCalls.length)
  for (const waiter of ready) waiter.resolve()
  return deferred.promise
}

export function waitForActiveCalls(count: number): Promise<void> {
  if (gatedCalls.length >= count) return Promise.resolve()
  const deferred = Promise.withResolvers<void>()
  callWaiters.push({ count, resolve: deferred.resolve })
  return deferred.promise
}

export function releaseCall(
  configDirOrIndex: string | number,
  outcome: QueryReleaseOutcome,
): void {
  const call = typeof configDirOrIndex === "number"
    ? gatedCalls[configDirOrIndex]
    : gatedCalls.find((candidate) => !candidate.released && candidate.configDir === configDirOrIndex)
  if (!call || call.released) {
    throw new Error(`No blocked gated query call found for ${configDirOrIndex}`)
  }
  call.released = true
  call.release(outcome)
}
