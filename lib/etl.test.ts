import assert from "node:assert/strict"
import test from "node:test"
import {
  createLoadSnapshot,
  expectedHours,
  failedBatchIndices,
  filterSort,
  makeFixtureCheck,
  partitionBatches,
  selectFilteredRows,
  transformAndClean,
  utcDateTimeInputToIso,
  validatePeriod,
  type Filters,
  type RawWeather,
  type WeatherRecord,
} from "./etl.ts"

const noFilters: Filters = {
  cities: [], from: "", to: "", temperatureMin: "", temperatureMax: "", humidityMin: "", humidityMax: "",
  precipitationMin: "", precipitationMax: "", rainOnly: false, orderBy: "fecha_hora", direction: "asc",
}

test("un día tiene 24 horas previstas y no supera el máximo de 31 días", () => {
  assert.equal(expectedHours("2026-09-01", "2026-09-01"), 24)
  assert.equal(validatePeriod("2026-09-01", "2026-09-01"), true)
  assert.equal(validatePeriod("2026-09-01", "2026-10-02"), false)
})

test("transforma arrays paralelos en horas UTC normalizadas", () => {
  const times = Array.from({ length: 24 }, (_, hour) => `2026-09-01T${String(hour).padStart(2, "0")}:00`)
  const raw: Record<string, RawWeather> = { Barcelona: { hourly: {
    time: times, temperature_2m: times.map((_, i) => i), relative_humidity_2m: times.map(() => 60), precipitation: times.map(() => 0),
  } } }
  const result = transformAndClean(raw)
  assert.equal(result.totalExtracted, 24)
  assert.equal(result.transformed.length, 24)
  assert.equal(result.valid.length, 24)
  assert.equal(result.valid[0].fecha_hora, "2026-09-01T00:00:00.000Z")
  assert.equal(result.valid[23].fecha_hora, "2026-09-01T23:00:00.000Z")
})

test("el null se conserva en transformados y se rechaza sin convertirlo a cero", () => {
  const result = makeFixtureCheck()
  assert.equal(result.transformed[0].humedad_pct, null)
  assert.equal(result.valid.some((row) => row.fecha_hora === "2026-09-01T00:00:00.000Z"), false)
  assert.match(result.rejected[0].motivo, /nula/)
})

test("detecta duplicados y conserva la primera fila por ciudad y hora", () => {
  const result = makeFixtureCheck()
  assert.equal(result.valid.length, 1)
  assert.equal(result.valid[0].temperatura_c, 21)
  assert.match(result.rejected[1].motivo, /Duplicado/)
})

test("filtra y ordena antes de paginar; una fila posterior puede estar seleccionada", () => {
  const rows: WeatherRecord[] = Array.from({ length: 30 }, (_, i) => ({
    ciudad: i % 2 ? "Madrid" : "Barcelona", fecha_hora: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
    temperatura_c: i, humedad_pct: 50, precipitacion_mm: i % 3 ? 0 : 0.5,
  }))
  const filtered = filterSort(rows, { ...noFilters, temperatureMin: "10", rainOnly: true, orderBy: "temperatura_c", direction: "desc" })
  assert.deepEqual(filtered.map((row) => row.temperatura_c), [27, 24, 21, 18, 15, 12])
  const allOrdered = filterSort(rows, noFilters)
  const laterPageRow = allOrdered[20]
  assert.equal(allOrdered.slice(0, 12).includes(laterPageRow), false)
  const selected = selectFilteredRows(allOrdered, new Set([`${laterPageRow.ciudad}|${laterPageRow.fecha_hora}`]))
  assert.equal(selected.length, 1)
  assert.equal(selected[0].fecha_hora, laterPageRow.fecha_hora)
})

test("la vista previa clonada coincide en filas y orden con la carga congelada", () => {
  const raw: Record<string, RawWeather> = { Madrid: { hourly: { time: ["2026-09-01T00:00", "2026-09-01T01:00"], temperature_2m: [20, 21], relative_humidity_2m: [50, 50], precipitation: [0, 1] } } }
  const rows = filterSort(transformAndClean(raw).valid, { ...noFilters, orderBy: "temperatura_c", direction: "desc" })
  const selected = selectFilteredRows(rows, new Set(rows.map((row) => `${row.ciudad}|${row.fecha_hora}`)))
  const frozen = createLoadSnapshot(selected)
  assert.deepEqual(JSON.stringify(frozen), JSON.stringify(selected))
})

test("los lotes no superan 500 y reintentar conserva los fallidos", () => {
  const lots = partitionBatches(Array.from({ length: 1101 }, (_, i) => i))
  assert.deepEqual(lots.map((lot) => lot.length), [500, 500, 101])
  assert.deepEqual(failedBatchIndices([{ status: "completado" }, { status: "error" }, { status: "pendiente" }, { status: "error" }]), [1, 3])
})

test("las fechas elegidas por el usuario se interpretan como UTC", () => {
  assert.equal(utcDateTimeInputToIso("2026-09-01T06:00"), "2026-09-01T06:00:00.000Z")
})
