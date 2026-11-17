// List input price in $/Mtok by model family. Output is 5x, cache read 0.1x and
// cache write 1.25x of the input price, so the ratios between families cancel
// those multipliers out.
const PRICE: Array<[RegExp, number]> = [
  [/opus/i, 5],
  [/sonnet/i, 3],
  [/haiku/i, 1],
]

export const inputPrice = (model: string): number | undefined =>
  PRICE.find(([re]) => re.test(model))?.[1]

export type Usage = {
  input: number
  output: number
  cache: { read: number; write: number }
}

/** List-price USD for one step's token usage, or undefined for an unknown model family. */
export function listCostUsd(model: string, usage: Usage): number | undefined {
  const p = inputPrice(model)
  if (p === undefined) return undefined
  return (
    (usage.input * p +
      usage.output * 5 * p +
      usage.cache.read * 0.1 * p +
      usage.cache.write * 1.25 * p) /
    1e6
  )
}

/**
 * What the step would have cost less (positive) or more (negative) on another
 * model, assuming the same tokens: cost x (1 - price(would) / price(actual)).
 */
export function savingUsd(
  cost: number,
  actual: string,
  would: string,
): number | undefined {
  const a = inputPrice(actual)
  const w = inputPrice(would)
  if (a === undefined || w === undefined) return undefined
  return cost * (1 - w / a)
}
