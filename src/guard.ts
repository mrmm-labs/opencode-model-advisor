/**
 * Process-wide state. OpenCode loads a plugin once per open project instance,
 * all in one process, and every instance sees the same hook registry and the
 * same events. Anything that must happen once per process lives here.
 */
const KEY = Symbol.for("opencode-model-advisor.shared")
const MAX_SEEN = 5000

type Shared = { seen: Set<string>; live: Set<object>; once: Set<string> }

const shared = (): Shared =>
  ((globalThis as Record<symbol, unknown>)[KEY] ??= {
    seen: new Set(),
    live: new Set(),
    once: new Set(),
  }) as Shared

/** True the first time a key is seen in this process (a dispatch seen by every instance counts once). */
export function firstSeen(key: string): boolean {
  const { seen } = shared()
  if (seen.has(key)) return false
  seen.add(key)
  if (seen.size > MAX_SEEN) {
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

/** True the first time a name is claimed in this process. */
export function claimOnce(name: string): boolean {
  const { once } = shared()
  if (once.has(name)) return false
  once.add(name)
  return true
}

/** Registers a live instance; the returned function removes it. */
export function track<T extends object>(instance: T): () => void {
  const { live } = shared()
  live.add(instance)
  return () => void live.delete(instance)
}

/** The oldest instance still alive, so a hook registered once outlives the instance that registered it. */
export function liveInstance<T extends object>(): T | undefined {
  return shared().live.values().next().value as T | undefined
}

/** Test hook. */
export function resetShared(): void {
  delete (globalThis as Record<symbol, unknown>)[KEY]
}
