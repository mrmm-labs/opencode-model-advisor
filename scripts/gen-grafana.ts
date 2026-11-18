/**
 * Generates grafana/model-router.json, the dashboard for the routing metrics in
 * grafana/otel-collector.example.yaml. Edit this file, not the JSON:
 *
 *   node --experimental-strip-types scripts/gen-grafana.ts && pnpm exec oxfmt --write grafana
 */
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const FACTS = [
  "task",
  "risk",
  "files",
  "modules",
  "kind",
  "migration",
  "unknowns",
  "retry",
  "priorFailures",
  "promptTokens",
  "paths",
]

const ds = { type: "prometheus", uid: "${DS_PROMETHEUS}" }
const W = 24

type Target = {
  expr: string
  legend?: string
  instant?: boolean
  format?: string
}

let nextId = 1
let y = 0
const panels: object[] = []

const row = (title: string) => {
  panels.push({
    id: nextId++,
    type: "row",
    title,
    collapsed: false,
    gridPos: { x: 0, y: y++, w: W, h: 1 },
    panels: [],
  })
}

const panel = (
  type: string,
  title: string,
  pos: { x: number; w: number; h?: number },
  targets: Target[],
  extra: Record<string, unknown> = {},
) => {
  panels.push({
    id: nextId++,
    type,
    title,
    datasource: ds,
    gridPos: { x: pos.x, y, w: pos.w, h: pos.h ?? 8 },
    targets: targets.map((t, i) => ({
      refId: String.fromCharCode(65 + i),
      datasource: ds,
      expr: t.expr,
      legendFormat: t.legend,
      instant: t.instant,
      range: !t.instant,
      format: t.format,
    })),
    ...extra,
  })
}

const endRow = (h = 8) => {
  y += h
}

const stacked = {
  fieldConfig: {
    defaults: {
      custom: {
        drawStyle: "bars",
        fillOpacity: 70,
        stacking: { mode: "normal" },
      },
    },
    overrides: [],
  },
  options: { legend: { displayMode: "list", placement: "bottom" } },
}
const lines = {
  fieldConfig: {
    defaults: { custom: { drawStyle: "line", fillOpacity: 10 } },
    overrides: [],
  },
  options: { legend: { displayMode: "list", placement: "bottom" } },
}
const bars = {
  options: {
    displayMode: "gradient",
    orientation: "horizontal",
    showUnfilled: true,
  },
  fieldConfig: { defaults: {}, overrides: [] },
}

row("Levels")
panel(
  "timeseries",
  "Decisions by agent and level",
  { x: 0, w: 14 },
  [
    {
      expr: "sum by (opencode_agent, route_level) (increase(model_router_decisions_total[$__rate_interval]))",
      legend: "{{opencode_agent}} · {{route_level}}",
    },
  ],
  stacked,
)
panel(
  "table",
  "Risk × difficulty → level (selected range)",
  { x: 14, w: 10 },
  [
    {
      expr: "sum by (route_risk, route_difficulty, route_level) (increase(model_router_decisions_total[$__range]))",
      instant: true,
      format: "table",
    },
  ],
  {
    transformations: [
      {
        id: "organize",
        options: {
          excludeByName: { Time: true },
          renameByName: {
            route_risk: "risk",
            route_difficulty: "difficulty",
            route_level: "level",
            Value: "decisions",
          },
        },
      },
    ],
    fieldConfig: { defaults: { decimals: 0 }, overrides: [] },
  },
)
endRow()

row("Score")
panel(
  "heatmap",
  "Score distribution",
  { x: 0, w: 14 },
  [
    {
      expr: "sum by (le) (increase(model_router_score_bucket[$__rate_interval]))",
      legend: "{{le}}",
      format: "heatmap",
    },
  ],
  { options: { calculate: false, yAxis: { axisLabel: "score" } } },
)
panel(
  "bargauge",
  "Top score breakdowns (selected range)",
  { x: 14, w: 10 },
  [
    {
      expr: "topk(10, sum by (route_score_breakdown) (increase(model_router_score_breakdown_total[$__range])))",
      legend: "{{route_score_breakdown}}",
      instant: true,
    },
  ],
  bars,
)
endRow()

row("Sources")
panel(
  "timeseries",
  "Disagreements by fact",
  { x: 0, w: 12 },
  FACTS.map((f) => ({
    expr: `sum (increase(model_router_disagreement_facts_total{route_disagreement_facts=~"(.*,)?${f}(,.*)?"}[$__rate_interval]))`,
    legend: f,
  })),
  stacked,
)
panel(
  "bargauge",
  "Fact source mix (selected range)",
  { x: 12, w: 12 },
  FACTS.map((f) => ({
    expr: `sum by (route_fact_${f}_source) (increase(model_router_fact_sources_total{route_fact_${f}_source!=""}[$__range]))`,
    legend: `${f} · {{route_fact_${f}_source}}`,
    instant: true,
  })),
  bars,
)
endRow()

row("Connectors")
panel(
  "timeseries",
  "Calls per second",
  { x: 0, w: 8 },
  [
    {
      expr: "sum by (connector_id, connector_cached) (rate(model_router_connector_calls_total[$__rate_interval]))",
      legend: "{{connector_id}} cached={{connector_cached}}",
    },
  ],
  lines,
)
panel(
  "timeseries",
  "Errors",
  { x: 8, w: 8 },
  [
    {
      expr: 'sum by (connector_id) (increase(model_router_connector_calls_total{connector_ok="false"}[$__rate_interval]))',
      legend: "{{connector_id}}",
    },
  ],
  stacked,
)
panel(
  "timeseries",
  "p95 latency (ms)",
  { x: 16, w: 8 },
  [
    {
      expr: "histogram_quantile(0.95, sum by (le, connector_id) (rate(model_router_connector_duration_bucket[$__rate_interval])))",
      legend: "{{connector_id}}",
    },
  ],
  {
    ...lines,
    fieldConfig: {
      ...lines.fieldConfig,
      defaults: { ...lines.fieldConfig.defaults, unit: "ms" },
    },
  },
)
endRow()

row("Calibration")
const bucket = (metric: string, instant = true): Target => ({
  expr: `max by (risk, difficulty, level) (${metric})`,
  instant,
  format: "table",
})
panel(
  "table",
  "Buckets",
  { x: 0, w: 16 },
  [
    bucket("model_router_calibration_first_pass"),
    bucket("model_router_calibration_cost_per_task"),
    bucket("model_router_calibration_tasks"),
    bucket("model_router_calibration_avg_retries"),
  ],
  {
    transformations: [
      { id: "merge", options: {} },
      {
        id: "organize",
        options: {
          excludeByName: { Time: true },
          renameByName: {
            "Value #A": "first pass",
            "Value #B": "cost per task",
            "Value #C": "tasks",
            "Value #D": "avg retries",
          },
        },
      },
    ],
    fieldConfig: {
      defaults: {},
      overrides: [
        {
          matcher: { id: "byName", options: "first pass" },
          properties: [{ id: "unit", value: "percentunit" }],
        },
        {
          matcher: { id: "byName", options: "cost per task" },
          properties: [{ id: "unit", value: "currencyUSD" }],
        },
      ],
    },
  },
)
panel(
  "stat",
  "Monotonic",
  { x: 16, w: 4 },
  [{ expr: "max(model_router_calibration_monotonic)", instant: true }],
  {
    fieldConfig: {
      defaults: {
        mappings: [
          {
            type: "value",
            options: {
              "0": { text: "no", color: "red" },
              "1": { text: "yes", color: "green" },
            },
          },
        ],
      },
      overrides: [],
    },
  },
)
panel(
  "stat",
  "Suggestions",
  { x: 20, w: 4 },
  [{ expr: "max(model_router_calibration_suggestions)", instant: true }],
  {
    fieldConfig: {
      defaults: {
        thresholds: {
          mode: "absolute",
          steps: [
            { color: "green", value: null },
            { color: "orange", value: 1 },
          ],
        },
      },
      overrides: [],
    },
  },
)
endRow()

row("Advisor")
panel(
  "timeseries",
  "Advisor calls by agent",
  { x: 0, w: 12 },
  [
    {
      expr: "sum by (agent) (increase(model_advisor_advisor_calls_total[$__rate_interval]))",
      legend: "{{agent}}",
    },
  ],
  stacked,
)
panel(
  "timeseries",
  "Advisor cost by agent (USD)",
  { x: 12, w: 12 },
  [
    {
      expr: "sum by (agent) (increase(model_advisor_advisor_cost_usd_total[$__rate_interval]))",
      legend: "{{agent}}",
    },
  ],
  {
    ...stacked,
    fieldConfig: {
      ...stacked.fieldConfig,
      defaults: { ...stacked.fieldConfig.defaults, unit: "currencyUSD" },
    },
  },
)
endRow()

export const dashboard = () => ({
  uid: "model-router-v2",
  title: "Model router",
  tags: ["opencode", "model-advisor"],
  schemaVersion: 39,
  version: 1,
  editable: true,
  time: { from: "now-24h", to: "now" },
  refresh: "1m",
  templating: {
    list: [
      {
        name: "DS_PROMETHEUS",
        label: "Prometheus",
        type: "datasource",
        query: "prometheus",
        current: {},
        hide: 0,
      },
    ],
  },
  panels,
})

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = new URL("../grafana/model-router.json", import.meta.url)
  writeFileSync(out, `${JSON.stringify(dashboard(), null, 2)}\n`)
  console.log("wrote grafana/model-router.json")
}
