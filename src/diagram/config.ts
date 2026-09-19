import { z } from "zod"

export const ConfigSchema = z.object({
  backend: z.enum(["manual", "openai-compatible", "opencode"]).optional(),
  baseURL: z.string().url().optional(),
  model: z.string().min(1).max(200).optional(),
  providerID: z.string().min(1).max(120).optional(),
  variant: z.string().min(1).max(80).optional(),
  responseFormat: z.enum(["json-object", "json-schema"]).default("json-schema"),
  allowRemote: z.boolean().default(false),
  apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  intervalMs: z.number().int().min(1000).max(300_000).default(20_000),
  debounceMs: z.number().int().min(100).max(30_000).default(1500),
  timeoutMs: z.number().int().min(1000).max(180_000).default(90_000),
  maxTokens: z.number().int().min(256).max(8192).default(6144),
  // Adapter-owned generation hints; cannot replace prompts, model, or transport.
  thinkingBudget: z.number().int().min(0).max(2048).optional(),
  enableThinking: z.boolean().optional(),
  cachePrompt: z.boolean().optional(),
}).strict().transform((config) => ({ ...config, backend: config.backend ?? (config.baseURL ? "openai-compatible" : config.providerID ? "opencode" : "manual") })).superRefine((config, ctx) => {
  if (config.backend === "openai-compatible" && (!config.baseURL || !config.model)) ctx.addIssue({ code: "custom", message: "Endpoint backend requires baseURL and model" })
  if (config.backend === "opencode" && (!config.providerID || !config.model)) ctx.addIssue({ code: "custom", message: "OpenCode backend requires providerID and model" })
  if (!config.baseURL) return
  const url = new URL(config.baseURL)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    ctx.addIssue({ code: "custom", message: "baseURL must be HTTP(S) without credentials, query, or fragment" })
  }
  if (!config.allowRemote && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    ctx.addIssue({ code: "custom", message: "Non-loopback endpoint requires allowRemote: true" })
  }
})
export type DiagramConfig = z.infer<typeof ConfigSchema>
