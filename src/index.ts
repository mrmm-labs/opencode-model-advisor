// One default export serves both plugin generations: V1 calls server() and
// uses the hooks it returns; V2 reads id and setup() and ignores server().
// Only the default is exported: V1's loader also invokes named function
// exports, which would initialise the plugin twice.
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"

import { server } from "./v1.ts"

const plugin: {
  id: string
  setup: V2Plugin.Plugin["setup"]
  server: V1Plugin
} = {
  id: "model-advisor",
  async setup(ctx) {
    // Loaded lazily so V1 never evaluates the V2 adapter.
    const { setup } = await import("./v2.ts")
    return setup(ctx)
  },
  server,
}

export default plugin
