import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

import { dashboard } from "../scripts/gen-grafana.ts"

const read = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8")

/** Prometheus series names the example collector config produces. */
function collectorSeries(): Set<string> {
  const names = new Set<string>()
  for (const block of read("grafana/otel-collector.example.yaml")
    .split(/^\s+- name: /m)
    .slice(1)) {
    const base = block.split("\n")[0].trim().replaceAll(".", "_")
    if (/^\s+sum:/m.test(block)) names.add(`${base}_total`)
    else if (/^\s+histogram:/m.test(block))
      for (const s of ["_bucket", "_sum", "_count"]) names.add(base + s)
    else if (/^\s+gauge:/m.test(block)) names.add(base)
  }
  return names
}

/** Metrics the plugin itself sends, from the README table. */
function pluginSeries(): Set<string> {
  const names = new Set<string>()
  for (const m of read("README.md").matchAll(
    /^\| `(model_advisor\.[\w.]+)`\s*\| counter/gm,
  ))
    names.add(`${m[1].replaceAll(".", "_")}_total`)
  return names
}

const exprs = () =>
  (dashboard().panels as any[]).flatMap((p) =>
    (p.targets ?? []).map((t: any) => [p.title, t.expr]),
  )

describe("grafana dashboard", () => {
  it("only queries metrics the collector config or the plugin defines", () => {
    const known = new Set([...collectorSeries(), ...pluginSeries()])
    assert.ok(known.size > 20)
    const all = exprs()
    assert.ok(all.length > 20)
    for (const [title, expr] of all) {
      const used = String(expr).match(/\bmodel_(?:router|advisor)_\w+/g) ?? []
      assert.ok(used.length, `${title}: no metric in ${expr}`)
      for (const name of used)
        assert.ok(known.has(name), `${title}: unknown metric ${name}`)
    }
  })

  it("has the rows, the datasource variable and the uid", () => {
    const d = dashboard() as any
    assert.equal(d.uid, "model-router-v2")
    assert.equal(d.schemaVersion, 39)
    assert.equal(d.templating.list[0].name, "DS_PROMETHEUS")
    assert.deepEqual(
      d.panels.filter((p: any) => p.type === "row").map((p: any) => p.title),
      ["Levels", "Score", "Sources", "Connectors", "Calibration", "Advisor"],
    )
    const ids = d.panels.map((p: any) => p.id)
    assert.equal(new Set(ids).size, ids.length)
  })

  it("matches the committed JSON", () => {
    assert.deepEqual(
      JSON.parse(read("grafana/model-router.json")),
      JSON.parse(JSON.stringify(dashboard())),
    )
  })
})
