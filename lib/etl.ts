export const CITIES = [
  { name: "Barcelona", latitude: 41.3874, longitude: 2.1686 },
  { name: "Madrid", latitude: 40.4168, longitude: -3.7038 },
  { name: "Sevilla", latitude: 37.3891, longitude: -5.9845 },
  { name: "Bilbao", latitude: 43.263, longitude: -2.935 },
  { name: "Valencia", latitude: 39.4699, longitude: -0.3763 },
] as const

export type City = (typeof CITIES)[number]["name"]
export type WeatherRecord = {
  ciudad: string
  fecha_hora: string
  temperatura_c: number
  humedad_pct: number
  precipitacion_mm: number
}
export type TransformedRecord = Omit<WeatherRecord, "temperatura_c" | "humedad_pct" | "precipitacion_mm"> & {
  temperatura_c: unknown
  humedad_pct: unknown
  precipitacion_mm: unknown
}
export type RejectedRecord = { ciudad: string; fecha_hora: string; motivo: string }
export type RawWeather = {
  hourly?: Record<string, unknown>
  [key: string]: unknown
}

export function expectedHours(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 0
  const from = Date.parse(`${start}T00:00:00Z`)
  const to = Date.parse(`${end}T00:00:00Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  if (new Date(from).toISOString().slice(0, 10) !== start || new Date(to).toISOString().slice(0, 10) !== end) return 0
  if (to < from) return 0
  return Math.floor((to - from) / 3_600_000) + 24
}

export function validatePeriod(start: string, end: string) {
  const count = expectedHours(start, end)
  return count > 0 && count <= 31 * 24
}

export function utcDateTimeInputToIso(value: string) {
  if (!value) return ""
  const timestamp = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ""
}

export function transformAndClean(rawByCity: Record<string, RawWeather>) {
  const transformed: TransformedRecord[] = []
  const rejected: RejectedRecord[] = []
  let totalExtracted = 0
  let malformedArrays = 0
  const transformationStarted = performance.now()

  for (const [city, raw] of Object.entries(rawByCity)) {
    const hourly = raw.hourly
    const times = hourly?.time
    const temps = hourly?.temperature_2m
    const humidities = hourly?.relative_humidity_2m
    const precipitation = hourly?.precipitation
    if (Array.isArray(times)) totalExtracted += times.length
    const arrays = [times, temps, humidities, precipitation]
    if (!arrays.every(Array.isArray)) {
      malformedArrays++
      rejected.push({ ciudad: city, fecha_hora: "—", motivo: "Faltan uno o más arrays horarios." })
      continue
    }
    const timeValues = times as unknown[]
    const tempValues = temps as unknown[]
    const humidityValues = humidities as unknown[]
    const precipitationValues = precipitation as unknown[]
    if (arrays.some((array) => array.length !== timeValues.length)) {
      malformedArrays++
      rejected.push({ ciudad: city, fecha_hora: "—", motivo: "Los arrays horarios tienen longitudes distintas." })
      continue
    }

    for (let index = 0; index < timeValues.length; index++) {
      const time = timeValues[index]
      const rawTime = typeof time === "string" ? time : ""
      const iso = rawTime.endsWith("Z") ? rawTime : `${rawTime}Z`
      const timestamp = Date.parse(iso)
      const values = [tempValues[index], humidityValues[index], precipitationValues[index]]
      transformed.push({
        ciudad: city,
        fecha_hora: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : rawTime || "—",
        temperatura_c: values[0], humedad_pct: values[1], precipitacion_mm: values[2],
      })
    }
  }
  const transformationMs = performance.now() - transformationStarted
  const cleaningStarted = performance.now()
  const candidates: WeatherRecord[] = []
  let transformedOffset = 0

  for (const [city, raw] of Object.entries(rawByCity)) {
    const hourly = raw.hourly
    const arrays = [hourly?.time, hourly?.temperature_2m, hourly?.relative_humidity_2m, hourly?.precipitation]
    if (!arrays.every(Array.isArray) || arrays.some((array) => array.length !== (arrays[0] as unknown[]).length)) continue
    const rowCount = (arrays[0] as unknown[]).length
    for (let index = 0; index < rowCount; index++) {
      const row = transformed[transformedOffset++]
      const rawTime = row.fecha_hora
      const timestamp = Date.parse(rawTime)
      const values = [row.temperatura_c, row.humedad_pct, row.precipitacion_mm]
      const reasons: string[] = []
      if (!CITIES.some((candidate) => candidate.name === city)) reasons.push("ciudad no reconocida")
      if (!rawTime || !Number.isFinite(timestamp)) reasons.push("fecha/hora UTC no válida")
      if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) reasons.push("medición nula, ausente o no numérica")
      const [temperature, humidity, rain] = values
      if (typeof humidity === "number" && Number.isFinite(humidity) && (humidity < 0 || humidity > 100)) reasons.push("humedad fuera del intervalo 0–100 %")
      if (typeof rain === "number" && Number.isFinite(rain) && rain < 0) reasons.push("precipitación negativa")
      if (reasons.length) {
        rejected.push({ ciudad: city || "—", fecha_hora: rawTime || "—", motivo: reasons.join("; ") })
        continue
      }
      candidates.push({
        ciudad: city, fecha_hora: new Date(timestamp).toISOString(),
        temperatura_c: temperature as number, humedad_pct: humidity as number, precipitacion_mm: rain as number,
      })
    }
  }

  const seen = new Set<string>()
  const valid: WeatherRecord[] = []
  for (const row of candidates) {
    const key = `${row.ciudad}|${row.fecha_hora}`
    if (seen.has(key)) {
      rejected.push({ ciudad: row.ciudad, fecha_hora: row.fecha_hora, motivo: "Duplicado: se conserva la primera aparición válida por ciudad y fecha/hora." })
    } else {
      seen.add(key)
      valid.push(row)
    }
  }
  return { totalExtracted, transformed, valid, rejected, malformedArrays, transformationMs, cleaningMs: performance.now() - cleaningStarted }
}

export type Filters = {
  cities: string[]
  from: string
  to: string
  temperatureMin: string
  temperatureMax: string
  humidityMin: string
  humidityMax: string
  precipitationMin: string
  precipitationMax: string
  rainOnly: boolean
  orderBy: "ciudad" | "fecha_hora" | "temperatura_c" | "humedad_pct" | "precipitacion_mm"
  direction: "asc" | "desc"
}

export function matchesFilters(row: WeatherRecord, filters: Filters) {
  const from = filters.from ? utcDateTimeInputToIso(filters.from) : ""
  const to = filters.to ? utcDateTimeInputToIso(filters.to) : ""
  const numberMatches = (value: number, min: string, max: string) =>
    (!min || value >= Number(min)) && (!max || value <= Number(max))
  return (
    (!filters.cities.length || filters.cities.includes(row.ciudad)) &&
    (!filters.from || (!!from && row.fecha_hora >= from)) &&
    (!filters.to || (!!to && row.fecha_hora <= to)) &&
    numberMatches(row.temperatura_c, filters.temperatureMin, filters.temperatureMax) &&
    numberMatches(row.humedad_pct, filters.humidityMin, filters.humidityMax) &&
    numberMatches(row.precipitacion_mm, filters.precipitationMin, filters.precipitationMax) &&
    (!filters.rainOnly || row.precipitacion_mm > 0)
  )
}

export function selectFilteredRows(filteredRows: WeatherRecord[], selectedKeys: Set<string>) {
  return filteredRows.filter((row) => selectedKeys.has(`${row.ciudad}|${row.fecha_hora}`))
}

export function createLoadSnapshot(rows: WeatherRecord[]) {
  return rows.map((row) => ({ ...row }))
}

export function partitionBatches<T>(rows: T[], size = 500) {
  const batches: T[][] = []
  for (let index = 0; index < rows.length; index += size) batches.push(rows.slice(index, index + size))
  return batches
}

export function failedBatchIndices<T extends { status: string }>(batches: T[]) {
  return batches.flatMap((batch, index) => batch.status === "error" ? [index] : [])
}

export function filterSort(rows: WeatherRecord[], filters: Filters) {
  return rows.filter((row) => matchesFilters(row, filters)).sort((a, b) => {
    const left = a[filters.orderBy]
    const right = b[filters.orderBy]
    const comparison = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right))
    return filters.direction === "asc" ? comparison : -comparison
  })
}

export function makeFixtureCheck() {
  const fixture: Record<string, RawWeather> = {
    Madrid: { hourly: { time: ["2026-09-01T00:00", "2026-09-01T01:00", "2026-09-01T01:00"], temperature_2m: [20, 21, 22], relative_humidity_2m: [null, 50, 50], precipitation: [0, 0.2, 0.2] } },
  }
  return transformAndClean(fixture)
}
