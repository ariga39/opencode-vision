import { createRequire } from "node:module"
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const REPO_ROOT = dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ocodeBin() {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN
  try {
    const pkgJson = require.resolve("opencode-ai/package.json")
    const pkg = require(pkgJson)
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
  throw new Error("no opencode binary")
}

const home = await mkdtemp(join(tmpdir(), "ov-diag-"))
const configDir = join(home, "xdg-config", "opencode")
await mkdir(join(configDir, "plugins"), { recursive: true })
await mkdir(join(home, "xdg-data", "opencode"), { recursive: true })
await mkdir(join(home, "xdg-cache", "opencode"), { recursive: true })
await writeFile(join(configDir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))

const port = 46000 + Math.floor(Math.random() * 1000)
const bin = ocodeBin()
console.log("BIN:", bin)
const proc = spawn(bin, ["serve", "--port", String(port), "--print-logs"], {
  cwd: REPO_ROOT,
  env: { ...process.env, XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_DATA_HOME: join(home, "xdg-data"), XDG_CACHE_HOME: join(home, "xdg-cache"), XDG_STATE_HOME: join(home, "xdg-state"), OPENCODE_TEST_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
})
let logs = ""
proc.stdout.on("data", (d) => (logs += d.toString()))
proc.stderr.on("data", (d) => (logs += d.toString()))

await sleep(6000)
const url = `http://127.0.0.1:${port}/`
console.log("PROXY env:", JSON.stringify({ HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, http_proxy: process.env.http_proxy, https_proxy: process.env.https_proxy, no_proxy: process.env.no_proxy }))
console.log("alive:", proc.exitCode === null)
try {
  const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "12", url], { encoding: "utf8", timeout: 20000 })
  console.log("CURL status:", code)
} catch (e) {
  console.log("CURL error:", e.message.split("\n")[0])
}
try {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 12000)
  const res = await fetch(url, { signal: ac.signal })
  clearTimeout(t)
  console.log("BUN fetch status:", res.status)
} catch (e) {
  console.log("BUN fetch error:", e.name, "|", e.message)
}
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
  console.log("BUN fetch(AbortSignal.timeout) status:", res.status)
} catch (e) {
  console.log("BUN fetch(timeout) error:", e.name, "|", e.message)
}
console.log("--- serve logs ---\n" + logs.slice(-3000))
try { proc.kill() } catch {}
await rm(home, { recursive: true, force: true })
process.exit(0)
