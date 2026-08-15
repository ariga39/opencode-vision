import { afterAll, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:net"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"

const require = createRequire(import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const MOCK_DESC = "MOCK VISION DESCRIPTION: a red pixel."
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function ocodeBin(): string {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN
  try {
    const pkgJson = require.resolve("opencode-ai/package.json")
    const pkg = require(pkgJson) as { bin: string | Record<string, string> }
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.opencode
    const candidate = join(dirname(pkgJson), rel)
    if (existsSync(candidate)) return candidate
  } catch {}
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const names = process.platform === "win32" ? ["opencode.exe", "opencode"] : ["opencode"]
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error("opencode binary not found; set OPENCODE_BIN or install opencode-ai")
}function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s: Server = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

function startMock() {
  const visionCalls: any[] = []
  const mainCalls: any[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (req.method === "POST" && url.pathname === "/chat/completions") {
        const body: any = await req.json()
        const headers = { "content-type": "application/json" }
        if (body.model === "vision") {
          visionCalls.push(body)
          return Response.json(
            { id: "mock-vision", choices: [{ index: 0, message: { role: "assistant", content: MOCK_DESC } }] },
            { headers },
          )
        }
        mainCalls.push(body)
        return Response.json(
          { id: "mock-main", choices: [{ index: 0, message: { role: "assistant", content: "understood" } }] },
          { headers },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { port: server.port, visionCalls, mainCalls, stop: () => server.stop(true) }
}

async function waitReady(baseUrl: string, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(baseUrl)
      if (res.status !== 502 && res.status !== 503) return
    } catch {}
    await sleep(300)
  }
  throw new Error("opencode serve did not become ready")
}

type Mock = ReturnType<typeof startMock>

type Harness = {
  client: OpencodeClient
  mock: Mock
  proc: ChildProcess
  logs: () => string
  cleanup: () => Promise<void>
}

async function startServer(mode: "replace" | "delegate"): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "ov-it-"))
  const configDir = join(home, "xdg-config", "opencode")
  const dataDir = join(home, "xdg-data", "opencode")
  const cacheDir = join(home, "xdg-cache", "opencode")
  await mkdir(join(configDir, "plugins"), { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })

  const mock = startMock()

  await symlink(join(REPO_ROOT, "node_modules"), join(configDir, "node_modules"), process.platform === "win32" ? "junction" : "dir").catch(() => {})

  const providers: Record<string, any> = {
    "test-main": {
      options: { baseURL: `http://127.0.0.1:${mock.port}`, apiKey: "test-key" },
      models: { main: { name: "Test Main" } },
    },
  }
  if (mode === "replace") {
    providers["vision-aux"] = {
      options: { baseURL: `http://127.0.0.1:${mock.port}`, apiKey: "test-key", model: "vision" },
    }
  }
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    provider: providers,
    experimental: { small_model: "test-main/main" },
  }
  await writeFile(join(configDir, "opencode.json"), JSON.stringify(cfg, null, 2))
  await writeFile(
    join(configDir, "plugins", "opencode-vision.ts"),
    await readFile(join(REPO_ROOT, "opencode-vision.ts"), "utf8"),
  )

  const port = await freePort()
  const bin = ocodeBin()
  const proc = spawn(bin, ["serve", "--port", String(port), "--print-logs"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(home, "xdg-config"),
      XDG_DATA_HOME: join(home, "xdg-data"),
      XDG_CACHE_HOME: join(home, "xdg-cache"),
      XDG_STATE_HOME: join(home, "xdg-state"),
      OPENCODE_TEST_HOME: home,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const logBuf: string[] = []
  proc.stdout.on("data", (d) => logBuf.push(d.toString()))
  proc.stderr.on("data", (d) => logBuf.push(d.toString()))
  proc.on("exit", (code, signal) => logBuf.push(`[serve exited code=${code} signal=${signal}]`))
  proc.on("error", (err) => logBuf.push(`[serve spawn error: ${err.message}]`))

  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitReady(baseUrl)
  } catch (err) {
    const logs = logBuf.join("").slice(-4000)
    const binExists = existsSync(bin)
    throw new Error(`serve not ready; bin=${bin} exists=${binExists}\nlogs:\n${logs}\noriginal: ${(err as Error).message}`)
  }
  const client = createOpencodeClient({ baseUrl })

  const cleanup = async () => {
    try {
      proc.kill()
    } catch {}
    mock.stop()
    await rm(home, { recursive: true, force: true })
  }

  return { client, mock, proc, logs: () => logBuf.join(""), cleanup }
}

async function sendImagePrompt(client: OpencodeClient, sessionID: string) {
  await client.session.prompt({
    sessionID,
    parts: [
      { type: "file", mime: "image/png", url: `data:image/png;base64,${PNG_B64}` },
      { type: "text", text: "Describe this image." },
    ],
  })
}

function agentMainRequest(mock: Mock): any {
  return mock.mainCalls.find((c) => Array.isArray(c.messages?.[0]?.content) || Array.isArray(c.messages?.find((m: any) => m.role === "user")?.content))
}

function userContentOf(call: any): any[] {
  const user = call.messages?.find((m: any) => m.role === "user")
  return Array.isArray(user?.content) ? user.content : []
}

function textParts(call: any): string[] {
  return userContentOf(call)
    .filter((p: any) => p.type === "text")
    .map((p: any) => String(p.text))
}

const servers: Harness[] = []

afterAll(async () => {
  await Promise.all(servers.map((s) => s.cleanup()))
})

async function boot(mode: "replace" | "delegate"): Promise<Harness> {
  const h = await startServer(mode)
  servers.push(h)
  return h
}

describe("integration", () => {
  test("replace mode replaces the image with an injected vision description", async () => {
    const h = await boot("replace")
    const sessionID = (await h.client.session.create({ model: { providerID: "test-main", id: "main" } })).data.id

    await sendImagePrompt(h.client, sessionID)

    const main = agentMainRequest(h.mock)
    expect(
      main,
      `expected an agent request against the main model\nmainCalls: ${JSON.stringify(h.mock.mainCalls).slice(0, 2000)}\nlogs:\n${h.logs().slice(-2000)}`,
    ).toBeTruthy()

    const injected = textParts(main).find((t) => t.startsWith("[opencode-vision] Image:"))
    expect(
      injected,
      `expected injected vision description in the model request\nuser parts: ${JSON.stringify(userContentOf(main), null, 2)}`,
    ).toBeTruthy()
    expect(injected).toContain(MOCK_DESC)
    expect(injected).toContain("(saved:")
    expect(userContentOf(main).some((p) => p.type === "file")).toBe(false)
    expect(h.mock.visionCalls.length).toBe(1)
  }, 120000)

  test("delegate mode injects a delegation hint and does not call the vision API", async () => {
    const h = await boot("delegate")
    const sessionID = (await h.client.session.create({ model: { providerID: "test-main", id: "main" } })).data.id

    await sendImagePrompt(h.client, sessionID)

    const main = agentMainRequest(h.mock)
    expect(
      main,
      `expected an agent request against the main model\nmainCalls: ${JSON.stringify(h.mock.mainCalls).slice(0, 2000)}\nlogs:\n${h.logs().slice(-2000)}`,
    ).toBeTruthy()

    const hint = textParts(main).find((t) => t.startsWith("[opencode-vision]:image "))
    expect(
      hint,
      `expected delegation hint in the model request\nuser parts: ${JSON.stringify(userContentOf(main), null, 2)}`,
    ).toBeTruthy()
    expect(userContentOf(main).some((p) => p.type === "file")).toBe(false)
    expect(h.mock.visionCalls.length).toBe(0)
  }, 120000)
})
