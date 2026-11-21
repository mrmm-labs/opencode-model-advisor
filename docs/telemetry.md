# Telemetry for routing v2

Telemetry is optional. Nothing is sent until `otel.endpoint` or `OTEL_EXPORTER_OTLP_ENDPOINT` is
set; see the Telemetry section of the README for the transport and the existing `route.*` span
attributes and `model_advisor.*` metrics. This page covers what routing v2 adds. Prompt text is
never exported.

## Decision span

The `route <agent>` span keeps its existing attributes. A decision made by the v2 path adds:

| Attribute                           | Meaning                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `route.level`                       | Level after floor and retry steps                                               |
| `route.matrix_level`                | Level the risk × difficulty matrix gave                                         |
| `route.risk`, `route.difficulty`    | The two matrix inputs                                                           |
| `route.score`                       | Difficulty score                                                                |
| `route.score.breakdown`             | Rubric lines that added points, e.g. `files+2 migration+2`                      |
| `route.steps`                       | Why the level moved, joined with `; `                                           |
| `route.disagreements`               | Number of facts whose sources disagreed                                         |
| `route.disagreement.facts`          | Those facts, comma separated                                                    |
| `route.fact.<name>`                 | The chosen value of a fact; arrays are joined with `,`                          |
| `route.fact.<name>.source`          | `<kind>:<source>`, e.g. `connector:github`, `caller:hint`, `default:config`     |
| `connector.<id>.ms`                 | Latency of the connector call                                                   |
| `connector.<id>.ok`, `.cached`      | Outcome and whether the cache answered                                          |
| `connector.<id>.error`              | Error text, when it failed                                                      |

`<name>` is one of `task`, `risk`, `files`, `modules`, `kind`, `migration`, `unknowns`, `retry`,
`priorFailures`, `promptTokens`, `paths`; a fact the decision did not use has no attribute. Free
text is cut to 200 characters. At most 8 connectors are listed. A decision without v2 detail has
none of these attributes.

## Connector spans

Each connector call also becomes its own span `connector <id>`, in the same trace, with
`connector.id`, `connector.ms`, `connector.ok`, `connector.cached` and `connector.error`. A failed
call is an error span. These are what the collector counts and times per connector, because a
metric label needs one attribute name, not one per connector.

## Calibration spans

`exportCalibration(target)` reads the calibration report and sends it as spans. The file is
`OPENCODE_MODEL_ADVISOR_CALIBRATION`, or `calibration.json` next to `advisor.log`. With no file, a
file that does not parse, or no endpoint, it does nothing.

| Span                                 | Attributes                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `model-advisor calibration bucket`   | `risk`, `difficulty`, `level`, `tasks`, `first_pass`, `avg_retries`, `cost_per_task` |
| `model-advisor calibration summary`  | `monotonic`, `suggestions` (count), `tasks`, `window_days`                    |

## Metrics

The collector derives these from the spans, so the plugin sends no new metric. The advisor metrics
are the existing `model_advisor.advisor.*` ones. Names below are as Prometheus shows them.

| Metric                                   | Type      | Labels                                           |
| ---------------------------------------- | --------- | ------------------------------------------------ |
| `model_router_decisions_total`           | counter   | `route_level`, `route_risk`, `route_difficulty`, `opencode_agent` |
| `model_router_score`                     | histogram | `route_level`                                    |
| `model_router_score_breakdown_total`     | counter   | `route_score_breakdown`                          |
| `model_router_disagreements_total`       | counter   | `route_level`; counts facts                      |
| `model_router_disagreement_facts_total`  | counter   | `route_disagreement_facts` (comma list)          |
| `model_router_fact_sources_total`        | counter   | `route_fact_<name>_source`                       |
| `model_router_connector_calls_total`     | counter   | `connector_id`, `connector_ok`, `connector_cached` |
| `model_router_connector_duration`        | histogram | `connector_id`; ms, cache hits excluded          |
| `model_router_calibration_first_pass`    | gauge     | `risk`, `difficulty`, `level`                    |
| `model_router_calibration_cost_per_task` | gauge     | `risk`, `difficulty`, `level`                    |
| `model_router_calibration_avg_retries`   | gauge     | `risk`, `difficulty`, `level`                    |
| `model_router_calibration_tasks`         | gauge     | `risk`, `difficulty`, `level`                    |
| `model_router_calibration_monotonic`     | gauge     | 1 when higher levels did not do worse            |
| `model_router_calibration_suggestions`   | gauge     | open suggestions                                 |

## Usage metrics

Counted by the plugin itself (delta counters), one point per executor step and advisor call. Names
as Prometheus shows them; every metric has `model`, `role` (`executor` or `advisor`) and `agent`.

| Metric                              | Extra label | Notes                                                    |
| ----------------------------------- | ----------- | -------------------------------------------------------- |
| `model_advisor_usage_requests_total` |             | steps and advisor calls                                  |
| `model_advisor_usage_tokens_total`   | `kind`      | `input`, `output`, `reasoning`, `cache_read`, `cache_write` |
| `model_advisor_usage_cost_usd_total` |             | reported cost, else list price from tokens               |

## Collector and dashboard

1. Run an OpenTelemetry Collector contrib build, version 0.165 or newer, with
   `grafana/otel-collector.example.yaml`. It uses the `signal_to_metrics` connector to turn spans
   into metrics, `delta_to_cumulative` because both the connector and the plugin send delta
   temporality, and a Prometheus exporter on `:8889`. Add your trace backend to the `traces`
   pipeline exporters if you keep spans too. `otelcol-contrib validate --config=<file>` checks it.
2. Point Prometheus at the exporter (`127.0.0.1:8889`). The example keeps series for 48 hours so
   the calibration gauges outlive the gap between runs.
3. In Grafana, import `grafana/model-router.json` (Dashboards, New, Import) and pick the Prometheus
   data source in `DS_PROMETHEUS`. The dashboard uid is `model-router-v2`.
4. Send data: set `otel.endpoint` to the collector's `:4318`. `pnpm run smoke:telemetry` sends
   synthetic decisions, including one v2 decision and one calibration bucket tagged `smoke-rv2`.

The dashboard is generated: edit `scripts/gen-grafana.ts`, then run
`node --experimental-strip-types scripts/gen-grafana.ts && pnpm exec oxfmt --write grafana`.
A test checks that the committed JSON matches and that every panel queries a metric the example
config or the README defines.

Calibration reaches the dashboard only if the calibrate command calls `exportCalibration` after writing the report.
