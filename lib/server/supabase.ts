import { createAdminClient } from "@supabase/server/core"
import { CITIES, type WeatherRecord } from "@/lib/etl"

export function requireLocalDevelopment(request: Request) {
  if (process.env.NODE_ENV !== "development") throw new Error("Este servicio solo está habilitado en desarrollo local.")
  const host = request.headers.get("host")?.split(":")[0]
  const origin = request.headers.get("origin")
  if (!host || !["localhost", "127.0.0.1"].includes(host)) throw new Error("El servicio solo admite conexiones locales.")
  if (origin && new URL(origin).host !== request.headers.get("host")) throw new Error("Origen no permitido.")
}

export function supabaseConfig() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error("Falta configurar SUPABASE_URL y SUPABASE_SECRET_KEY en .env.local.")
  return { url: url.replace(/\/$/, ""), key }
}

export function createSupabaseAdmin() {
  const { url, key } = supabaseConfig()
  return createAdminClient({ env: { url, publishableKeys: {}, secretKeys: { default: key } } })
}

export function isCity(value: unknown): value is (typeof CITIES)[number]["name"] {
  return typeof value === "string" && CITIES.some((city) => city.name === value)
}

export function isWeatherRecord(value: unknown): value is WeatherRecord {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return isCity(row.ciudad) && typeof row.fecha_hora === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(row.fecha_hora) && Number.isFinite(Date.parse(row.fecha_hora)) &&
    [row.temperatura_c, row.humedad_pct, row.precipitacion_mm].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (row.humedad_pct as number) >= 0 && (row.humedad_pct as number) <= 100 && (row.precipitacion_mm as number) >= 0
}
