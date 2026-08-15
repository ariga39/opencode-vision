import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promises as fsp } from "node:fs"

const HINT_PREFIX = "[opencode-vision]"
const DEFAULT_MODEL = "opencode/mimo-v2.5-free"
const MAX_IMAGES = 200
const FETCH_TIMEOUT_MS = 90000
const MAX_TOKENS = 2048

const IMAGE_TMP_DIR = join(tmpdir(), "opencode-vision")

type Backend = { baseURL: string; apiKey: string; model: string }

let mode: "replace" | "delegate" = "replace"
let subagent = "vision"
let createdAgent = false
let backend: Backend | null = null
let providerConfigs: Record<string, any> = {}
let currentModelSupportsImage = false
const sessionCapability = new Map<string, boolean>()
const descCache = new Map<string, string>()

function homeDir(): string {
  return process.env.OPENCODE_TEST_HOME ?? homedir()
}

function xdgPath(kind: string, fallback: string): string {
  return process.env[kind] ?? join(homeDir(), fallback)
}

function configDir(): string {
  return process.env.OPENCODE_CONFIG_DIR ?? join(xdgPath("XDG_CONFIG_HOME", ".config"), "opencode")
}

function dataDir(): string {
  return process.env.OPENCODE_DATA_DIR ?? join(xdgPath("XDG_DATA_HOME", ".local/share"), "opencode")
}

function cacheDir(): string {
  return process.env.OPENCODE_CACHE_DIR ?? join(xdgPath("XDG_CACHE_HOME", ".cache"), "opencode")
}

function modelsFile(): string {
  return join(cacheDir(), "models.json")
}

function authFile(): string {
  return join(dataDir(), "auth.json")
}

function choiceFile(): string {
  return join(configDir(), "vision-model.txt")
}

function firstRunFile(): string {
  return join(configDir(), ".vision-onboarded")
}

let onboarded: boolean | null = null

async function isOnboarded(): Promise<boolean> {
  if (onboarded !== null) return onboarded
  try {
    await fsp.access(firstRunFile())
    onboarded = true
  } catch {
    onboarded = false
  }
  return onboarded
}

async function markOnboarded(): Promise<void> {
  onboarded = true
  await fsp.writeFile(firstRunFile(), new Date().toISOString(), "utf8").catch(() => {})
}

const VISION_AGENT_PROMPT = `You are a vision subagent. Use the read tool to view the image at the given path, then objectively describe its content (visible text, layout, objects, colors) in detail. Reply in the language used by the main conversation. If your model cannot read images, say so honestly; never invent content.`

async function ensureVisionAgent(name: string, explicitModel?: string): Promise<string | null> {
  const dir = join(configDir(), "agent")
  const file = join(dir, `${name}.md`)
  try {
    await fsp.access(file)
    return null
  } catch {}
  const agentModel =
    explicitModel ||
    (await fsp.readFile(choiceFile(), "utf8").catch(() => "")).trim() ||
    DEFAULT_MODEL
  const content = `---\ndescription: Vision subagent (auto-created by opencode-vision). Describes images using ${agentModel}.\nmode: subagent\nmodel: ${agentModel}\n---\n\n${VISION_AGENT_PROMPT}\n`
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(file, content, "utf8")
    return file
  } catch {
    return null
  }
}

async function readJSON<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

function supportsImage(provider: Record<string, any>, modelID: string): boolean {
  const m = provider?.models?.[modelID]
  if (!m) return false
  const input = Array.isArray(m.modalities?.input) ? m.modalities.input : []
  if (input.includes("image")) return true
  return input.length === 0 && m.attachment === true
}

function modelSupportsImage(def: Record<string, any> | undefined): boolean {
  if (!def) return false
  const input = Array.isArray(def.modalities?.input) ? def.modalities.input : []
  if (input.includes("image")) return true
  return def.attachment === true
}

const ZEN_CHAT_FAMILIES = /^(deepseek|minimax|glm|kimi|mimo|hy3|laguna|nemotron|big-pickle)[-.]/i

function isZenGateway(api: string | undefined): boolean {
  return typeof api === "string" && api.includes("opencode.ai/zen")
}

function usableForChatCompletions(api: string | undefined, modelID: string): boolean {
  if (!isZenGateway(api)) return true
  return ZEN_CHAT_FAMILIES.test(modelID)
}

async function resolveProviderModel(id: string): Promise<Backend | null> {
  const slash = id.indexOf("/")
  if (slash <= 0 || slash === id.length - 1) return null
  const providerID = id.slice(0, slash)
  const modelID = id.slice(slash + 1)
  const configured = providerConfigs[providerID]
  if (configured) {
    const def = configured.models?.[modelID]
    if (!modelSupportsImage(def)) return null
    const auth = await readJSON<Record<string, any>>(authFile())
    const apiKey = configured.options?.apiKey ?? auth?.[providerID]?.key
    const baseURL = configured.options?.baseURL ?? configured.api
    if (!apiKey || !baseURL) return null
    if (!usableForChatCompletions(baseURL, modelID)) return null
    return { baseURL, apiKey, model: modelID }
  }
  const [catalog, auth] = await Promise.all([
    readJSON<Record<string, any>>(modelsFile()),
    readJSON<Record<string, any>>(authFile()),
  ])
  const provider = catalog?.[providerID]
  if (!provider || !provider.api) return null
  if (!supportsImage(provider, modelID)) return null
  if (!usableForChatCompletions(provider.api, modelID)) return null
  const apiKey = auth?.[providerID]?.key
  if (!apiKey) return null
  return { baseURL: provider.api, apiKey, model: modelID }
}

async function resolveBackend(cfg: Record<string, any>): Promise<Backend | null> {
  const v = cfg?.experimental?.vision ?? {}
  const explicit = typeof v.model === "string" && v.model ? v.model : null
  if (explicit) {
    const resolved = await resolveProviderModel(explicit)
    if (resolved) return resolved
  }
  const aux = cfg?.provider?.["vision-aux"]
  if (aux) {
    const o = aux.options ?? {}
    const baseURL = o.baseURL ?? o.api
    const apiKey = o.apiKey
    const model = o.model ?? Object.keys(aux.models ?? {})[0]
    if (baseURL && apiKey && model) return { baseURL, apiKey, model }
  }
  try {
    const choice = (await fsp.readFile(choiceFile(), "utf8")).trim()
    if (choice) {
      const resolved = await resolveProviderModel(choice)
      if (resolved) return resolved
    }
  } catch {}
  return resolveProviderModel(DEFAULT_MODEL)
}

async function discoverVisionModels(): Promise<Array<{ provider: string; model: string; name: string; label: string }>> {
  const [catalog, auth] = await Promise.all([
    readJSON<Record<string, any>>(modelsFile()),
    readJSON<Record<string, any>>(authFile()),
  ])
  const configured = Object.keys(auth ?? {}).filter((id) => Boolean(auth?.[id]?.key))
  const preferred = ["opencode", "opencode-go"]
  const ranked = [...preferred, ...configured.filter((id) => !preferred.includes(id))]
  const out: Array<{ provider: string; model: string; name: string; label: string }> = []
  for (const providerID of ranked) {
    const provider = catalog?.[providerID]
    if (!provider) continue
    const perProvider = Object.entries(provider.models ?? {})
      .filter(([mid, m]: [string, any]) => supportsImage(provider, mid) && m.status !== "deprecated")
      .filter(([mid]: [string, any]) => usableForChatCompletions(provider.api, mid))
      .slice(0, 4)
      .map(([mid, m]: [string, any]) => ({
        provider: providerID,
        model: mid,
        name: m.name ?? mid,
        label: `${providerID}/${mid}`,
      }))
    out.push(...perProvider)
    if (out.length >= 10) break
  }
  if (out.length < 10) {
    for (const [providerID, configured] of Object.entries(providerConfigs)) {
      if (out.some((e) => e.provider === providerID)) continue
      const apiKey = configured.options?.apiKey ?? auth?.[providerID]?.key
      if (!apiKey) continue
      const perProvider = Object.entries(configured.models ?? {})
        .filter(([mid, def]: [string, any]) => modelSupportsImage(def))
        .slice(0, 4)
        .map(([mid, def]: [string, any]) => ({
          provider: providerID,
          model: mid,
          name: def.name ?? mid,
          label: `${providerID}/${mid}`,
        }))
      out.push(...perProvider)
      if (out.length >= 10) break
    }
  }
  return out
}

function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png"
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg"
  if (mime.includes("webp")) return "webp"
  if (mime.includes("gif")) return "gif"
  return "png"
}

async function ensureImage(url: string, mime: string): Promise<{ hash: string; path: string; dataUrl: string }> {
  let buf: Buffer
  let dataUrl: string
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",")
    buf = Buffer.from(url.slice(comma + 1), "base64")
    dataUrl = url
  } else {
    const src = url.startsWith("file://") ? fileURLToPath(url) : url
    buf = await fsp.readFile(src)
    dataUrl = `data:${mime};base64,${buf.toString("base64")}`
  }
  const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16)
  const path = join(IMAGE_TMP_DIR, `${hash}.${mimeToExt(mime)}`)
  await fsp.mkdir(IMAGE_TMP_DIR, { recursive: true }).catch(() => {})
  await fsp.writeFile(path, buf).catch(() => {})
  void lruCleanup()
  return { hash, path, dataUrl }
}

async function lruCleanup() {
  try {
    const files = await fsp.readdir(IMAGE_TMP_DIR)
    if (files.length <= MAX_IMAGES) return
    const entries = await Promise.all(
      files.map(async (f) => ({ f, st: await fsp.stat(join(IMAGE_TMP_DIR, f)).catch(() => null) })),
    )
    const valid = entries
      .filter((e) => e.st)
      .sort((a, b) => (a.st!.mtimeMs ?? 0) - (b.st!.mtimeMs ?? 0))
    for (const e of valid.slice(0, valid.length - MAX_IMAGES)) {
      await fsp.unlink(join(IMAGE_TMP_DIR, e.f)).catch(() => {})
    }
  } catch {}
}

async function callVision(backend: Backend, image: { mime: string; dataUrl: string }, prompt: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${backend.baseURL.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${backend.apiKey}` },
      body: JSON.stringify({
        model: backend.model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: image.dataUrl } },
            ],
          },
        ],
        max_tokens: MAX_TOKENS,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300)
      return `Vision API error (${res.status}): ${text}`
    }
    const data = await res.json().catch(() => null)
    const content = data?.choices?.[0]?.message?.content
    return typeof content === "string" && content.trim() ? content.trim() : "No description returned."
  } catch (err) {
    const e = err as Error
    if (e.name === "AbortError") return `Vision API error: request timed out after ${FETCH_TIMEOUT_MS}ms`
    return `Vision API error: ${e.message}`
  } finally {
    clearTimeout(timer)
  }
}

function buildContext(msgs: any[], currentIndex: number): string {
  const parts: string[] = []
  const start = Math.max(0, currentIndex - 5)
  for (let i = start; i < currentIndex; i++) {
    const m = msgs[i]
    if (!m) continue
    const text = (m.parts ?? [])
      .filter((p: any) => p.type === "text" && typeof p.text === "string" && !p.text.startsWith(HINT_PREFIX))
      .map((p: any) => p.text)
      .join("\n")
      .trim()
    if (text) parts.push(`[${m.info.role}]: ${text.slice(0, 600)}`)
  }
  return parts.join("\n").slice(0, 4000)
}

function buildPrompt(context: string, userText: string): string {
  return [
    "You are an image analyst helping a coding assistant whose model cannot see images directly.",
    context ? `\nConversation context:\n${context}` : "",
    `\nLatest user request:\n${userText || "(none)"}`,
    "\n\nDescribe the attached image accurately and in detail, focusing on what the conversation asks about.",
    "If the user asked a question, answer it directly from the image.",
    "If the image shows game UI or software screenshots, transcribe visible text faithfully and report rendering issues (missing glyphs, boxes, overlap, overflow) factually.",
    "Structure your response clearly. Reply in the same language as the user's request.",
  ].join("")
}

function cacheDescription(hash: string, desc: string) {
  descCache.set(hash, desc)
  if (descCache.size > 500) {
    const oldest = descCache.keys().next().value
    if (oldest !== undefined) descCache.delete(oldest)
  }
}

const plugin: Plugin = async () => ({
  config: async (cfg: Record<string, any>) => {
    providerConfigs = cfg?.provider ?? {}
    const v = cfg?.experimental?.vision ?? {}
    mode = v.mode === "delegate" ? "delegate" : "replace"
    subagent = typeof v.subagent === "string" && v.subagent ? v.subagent : "vision"
    backend = await resolveBackend(cfg)
    if (mode === "replace" && !backend) mode = "delegate"
    createdAgent =
      mode === "delegate"
        ? (await ensureVisionAgent(subagent, typeof v.model === "string" ? v.model : undefined)) !== null
        : false
  },
  "experimental.chat.system.transform": async (input, output) => {
    const model = input.model as any
    const hasImage =
      model?.capabilities?.input?.image === true ||
      (Array.isArray(model?.modalities?.input) && model.modalities.input.includes("image"))
    currentModelSupportsImage = hasImage
    if (input.sessionID) sessionCapability.set(input.sessionID, hasImage)
    if (hasImage) return
    if (mode === "delegate") {
      output.system.push(
        `IMPORTANT: You cannot see images directly. When the user attaches an image, a plugin saves it and injects a line like "[opencode-vision]:image <path>". You MUST delegate image analysis to the @${subagent} subagent via the Task tool, passing the saved path. Never try to read the image yourself with the read tool.`,
      )
    } else {
      const notice = [
        `Image attachments are described for you by a vision model; each is injected as "[opencode-vision] Image: <description> (saved: <path>)". Use those descriptions as the image content. If you need more detail about a described image, you may delegate to a vision subagent such as @vision, passing the saved path. To change which vision model describes images, list candidates with the vision_models tool, ask the user to pick, then persist with vision_set_model.`,
      ]
      if (!(await isOnboarded())) {
        notice.push(
          `First-time notice: images are described by a default vision model (${backend?.model ?? "unset"}) served through the free opencode gateway (opencode auth login). Briefly mention this to the user once, in their language, and that they can switch models anytime via the vision_models / vision_set_model tools.`,
        )
      }
      output.system.push(notice.join("\n\n"))
    }
    if (createdAgent) {
      output.system.push(
        `Note: the vision subagent '@${subagent}' was just auto-created by opencode-vision. Tell the user once, in their language, that a single restart of opencode is needed for it to take effect.`,
      )
      createdAgent = false
    }
  },
  "experimental.chat.messages.transform": async (_input, output) => {
    const msgs = output.messages as any[]
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.info.role !== "user") continue
      const sessionID: string | undefined = m.info?.sessionID
      const capable = sessionID ? (sessionCapability.get(sessionID) ?? currentModelSupportsImage) : currentModelSupportsImage
      if (capable) continue
      const parts = m.parts as any[]
      for (let j = parts.length - 1; j >= 0; j--) {
        const p = parts[j]
        if (p.type === "text" && typeof p.text === "string" && p.text.startsWith(HINT_PREFIX)) parts.splice(j, 1)
      }
      const imageParts = parts
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => p.type === "file" && typeof p.mime === "string" && p.mime.startsWith("image/"))
      if (imageParts.length === 0) continue
      if (mode === "delegate") {
        for (const { p } of imageParts) {
          try {
            const { path } = await ensureImage(p.url, p.mime)
            p.type = "text"
            p.text = `${HINT_PREFIX}:image ${path}`
            p.synthetic = true
          } catch (err) {
            p.type = "text"
            p.text = `${HINT_PREFIX}:image-error ${(err as Error).message}`
            p.synthetic = true
          }
        }
        continue
      }
      const userText = parts
        .filter((p: any) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
      const context = buildContext(msgs, i)
      const prompt = buildPrompt(context, userText)
      for (let k = 0; k < imageParts.length; k++) {
        const { p } = imageParts[k]
        const label = imageParts.length > 1 ? `Image ${k + 1}` : "Image"
        try {
          const { hash, path, dataUrl } = await ensureImage(p.url, p.mime)
          let desc = descCache.get(hash)
          if (!desc) {
            desc = backend
              ? await callVision(backend, { mime: p.mime, dataUrl }, prompt)
              : `<vision backend unavailable. No vision model configured. Run 'opencode auth login' for free access, or ask the agent to run vision_set_model to pick one.>`
            cacheDescription(hash, desc)
          }
          p.type = "text"
          p.text = `${HINT_PREFIX} ${label}: ${desc}\n(saved: ${path})`
          p.synthetic = true
        } catch (err) {
          p.type = "text"
          p.text = `${HINT_PREFIX} ${label}: <error describing image: ${(err as Error).message}>`
          p.synthetic = true
        }
      }
      void markOnboarded()
    }
  },
  tool: {
    vision_models: tool({
      description:
        "List image-capable models available from your configured providers for describing user-attached images. Returns JSON {ok, count, models:[{provider, model, name, label}]}.",
      args: {},
      async execute() {
        const models = await discoverVisionModels()
        return JSON.stringify({ ok: true, count: models.length, models }, null, 2)
      },
    }),
    vision_set_model: tool({
      description:
        "Persist the vision model used to auto-describe user-attached images. model must be in provider/model form, e.g. 'opencode-go/kimi-k3'. Returns JSON {ok:true} on success or an error object.",
      args: { model: tool.schema.string() },
      async execute(args) {
        const resolved = await resolveProviderModel(args.model)
        if (!resolved) {
          return JSON.stringify({
            ok: false,
            error: `No image-capable model '${args.model}' found in your configured providers. Use vision_models to list candidates.`,
          })
        }
        await fsp.writeFile(choiceFile(), args.model, "utf8").catch(() => {})
        backend = resolved
        return JSON.stringify({ ok: true, model: args.model })
      },
    }),
  },
})

export default { id: "opencode-vision", server: plugin }
