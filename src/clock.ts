/**
 * Wall-clock milliseconds with a sub-millisecond fraction. `performance.timeOrigin +
 * performance.now()` stops advancing while the machine sleeps, so on a long-lived server it
 * falls behind real time; Date.now() does not.
 */
export const wallNow = (): number => Date.now() + (performance.now() % 1)
