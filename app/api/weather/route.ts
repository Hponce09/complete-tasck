import { CITIES, validatePeriod } from "@/lib/etl"

export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: unknown
  try { body = await request.json() } catch { return Response.json({ error: "El cuerpo de la petición no es JSON válido." }, { status: 400 }) }
  const input = body as { ciudad?: unknown; fechaInicio?: unknown; fechaFin?: unknown }
  const city = CITIES.find((candidate) => candidate.name === input.ciudad)
  if (!city || typeof input.fechaInicio !== "string" || typeof input.fechaFin !== "string" || !validatePeriod(input.fechaInicio, input.fechaFin)) {
    return Response.json({ error: "Indica una ciudad válida y un intervalo de 1 a 31 días." }, { status: 400 })
  }
  const url = new URL("https://archive-api.open-meteo.com/v1/archive")
  url.search = new URLSearchParams({
    latitude: String(city.latitude), longitude: String(city.longitude),
    start_date: input.fechaInicio, end_date: input.fechaFin,
    hourly: "temperature_2m,relative_humidity_2m,precipitation",
    timezone: "UTC", temperature_unit: "celsius", precipitation_unit: "mm", timeformat: "iso8601",
  }).toString()
  try {
    const response = await fetch(url, { cache: "no-store" })
    const data = await response.json()
    if (!response.ok) return Response.json({ error: typeof data.reason === "string" ? data.reason : "Open-Meteo rechazó la extracción." }, { status: 502 })
    return Response.json({ ciudad: city.name, raw: data })
  } catch {
    return Response.json({ error: "No se pudo conectar con Open-Meteo." }, { status: 502 })
  }
}
