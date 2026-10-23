"use client"

import { useMemo, useRef, useState } from "react"
import { CITIES, createLoadSnapshot, expectedHours, failedBatchIndices, filterSort, makeFixtureCheck, partitionBatches, selectFilteredRows, transformAndClean, utcDateTimeInputToIso, validatePeriod, type Filters, type RawWeather, type TransformedRecord, type WeatherRecord } from "@/lib/etl"

type CityState = { status: "pendiente" | "en curso" | "completada" | "error"; error?: string; elapsed?: number; start?: string; end?: string }
type Tab = "original" | "transformados" | "validos" | "rechazados" | "vista previa" | "destino"
type BatchState = { status: "pendiente" | "en curso" | "completado" | "error"; error?: string; count: number; elapsed?: number }
const defaultFilters = (): Filters => ({ cities: [], from: "", to: "", temperatureMin: "", temperatureMax: "", humidityMin: "", humidityMax: "", precipitationMin: "", precipitationMax: "", rainOnly: false, orderBy: "fecha_hora", direction: "asc" })
const tabs: Tab[] = ["original", "transformados", "validos", "rechazados", "vista previa", "destino"]
const pageSize = 12
const keyOf = (row: WeatherRecord) => `${row.ciudad}|${row.fecha_hora}`
const initialCities = Object.fromEntries(CITIES.map((city) => [city.name, { status: "pendiente" as const }]))

function displayDate(value: string) { return new Date(value).toLocaleString("es-ES", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" }) + " UTC" }
function number(value: number | null | undefined, suffix = "") { return value == null ? "—" : `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(value)}${suffix}` }

export default function Page() {
  const [selectedCities, setSelectedCities] = useState<string[]>(["Barcelona"])
  const [start, setStart] = useState("2026-09-01")
  const [end, setEnd] = useState("2026-09-30")
  const [rawByCity, setRawByCity] = useState<Record<string, RawWeather>>({})
  const [cityStates, setCityStates] = useState<Record<string, CityState>>(initialCities)
  const [extracting, setExtracting] = useState(false)
  const [runProgress, setRunProgress] = useState<{ processed: string[]; pending: string[]; current: string | null }>({ processed: [], pending: [], current: null })
  const [extractMessage, setExtractMessage] = useState("")
  const [filters, setFilters] = useState<Filters>(defaultFilters)
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<Tab>("validos")
  const [page, setPage] = useState(0)
  const [originalCity, setOriginalCity] = useState("Barcelona")
  const [loading, setLoading] = useState(false)
  const [batches, setBatches] = useState<BatchState[]>([])
  const [loadMessage, setLoadMessage] = useState("")
  const [frozen, setFrozen] = useState<WeatherRecord[]>([])
  const [destination, setDestination] = useState<WeatherRecord[]>([])
  const [destinationTotal, setDestinationTotal] = useState(0)
  const [destinationPage, setDestinationPage] = useState(0)
  const [destinationCity, setDestinationCity] = useState("")
  const [destinationStart, setDestinationStart] = useState("")
  const [destinationEnd, setDestinationEnd] = useState("")
  const [destinationOrder, setDestinationOrder] = useState<Filters["orderBy"]>("fecha_hora")
  const [destinationDirection, setDestinationDirection] = useState<Filters["direction"]>("asc")
  const [destinationMessage, setDestinationMessage] = useState("")
  const inFlight = useRef(false)
  const extractionInFlight = useRef(false)

  const results = useMemo(() => transformAndClean(rawByCity), [rawByCity])
  const filterError = [
    ["temperatura", filters.temperatureMin, filters.temperatureMax],
    ["humedad", filters.humidityMin, filters.humidityMax],
    ["precipitación", filters.precipitationMin, filters.precipitationMax],
  ].find(([, min, max]) => min !== "" && max !== "" && Number(min) > Number(max))?.[0]
    || (filters.humidityMin !== "" && Number(filters.humidityMin) < 0 ? "humedad mínima no puede ser menor que 0 %" : "")
    || (filters.humidityMin !== "" && Number(filters.humidityMin) > 100 ? "humedad mínima no puede superar 100 %" : "")
    || (filters.humidityMax !== "" && Number(filters.humidityMax) < 0 ? "humedad máxima no puede ser menor que 0 %" : "")
    || (filters.humidityMax !== "" && Number(filters.humidityMax) > 100 ? "humedad máxima no puede superar 100 %" : "")
    || (filters.precipitationMin !== "" && Number(filters.precipitationMin) < 0 ? "precipitación mínima no puede ser negativa" : "")
    || (filters.precipitationMax !== "" && Number(filters.precipitationMax) < 0 ? "precipitación máxima no puede ser negativa" : "")
  const resolvedFilterError = filterError ? (filterError.includes(" ") ? filterError : `el mínimo de ${filterError} no puede superar el máximo`) : ""
  const filteredResult = useMemo(() => {
    const started = performance.now()
    return { rows: resolvedFilterError ? [] : filterSort(results.valid, filters), duration: performance.now() - started }
  }, [results.valid, filters, resolvedFilterError])
  const filtered = filteredResult.rows
  const visibleSelected = useMemo(() => selectFilteredRows(filtered, selectedRows), [filtered, selectedRows])
  const validKeys = useMemo(() => new Set(results.valid.map(keyOf)), [results.valid])
  const filteredKeys = useMemo(() => new Set(filtered.map(keyOf)), [filtered])
  const outsideCount = [...selectedRows].filter((key) => validKeys.has(key) && !filteredKeys.has(key)).length
  const previewRows = loading ? frozen : visibleSelected
  const inspectRows = tab === "transformados" ? results.transformed : tab === "validos" ? filtered : tab === "rechazados" ? results.rejected : tab === "vista previa" ? previewRows : []
  const pages = Math.max(1, Math.ceil(inspectRows.length / pageSize))
  const shownRows = inspectRows.slice(page * pageSize, (page + 1) * pageSize)
  const selectedCitiesHours = selectedCities.length * expectedHours(start, end)
  const validPeriod = validatePeriod(start, end)
  const extractionDone = Object.values(rawByCity).some(Boolean)

  function updateFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }))
    setPage(0)
  }

  async function extract(cities: string[], retry = false, range = { start, end }) {
    if (!validatePeriod(range.start, range.end) || !cities.length || extractionInFlight.current) return
    extractionInFlight.current = true
    if (!retry) {
      setRawByCity({}); setSelectedRows(new Set()); setPage(0); setBatches([]); setFrozen([]); setLoadMessage(""); setCityStates(initialCities)
    }
    setExtracting(true)
    setExtractMessage("")
    setRunProgress({ processed: [], pending: cities, current: null })
    for (const [index, city] of cities.entries()) {
      setRunProgress((current) => ({ processed: current.processed, pending: cities.slice(index + 1), current: city }))
      setCityStates((current) => ({ ...current, [city]: { status: "en curso" } }))
      const started = performance.now()
      try {
        const response = await fetch("/api/weather", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ciudad: city, fechaInicio: range.start, fechaFin: range.end }) })
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || "Error al descargar los datos.")
        setRawByCity((current) => ({ ...current, [city]: payload.raw }))
        setOriginalCity(city)
        const replacement = transformAndClean({ ...rawByCity, [city]: payload.raw })
        const retainedKeys = new Set(replacement.valid.filter((row) => row.ciudad === city).map(keyOf))
        setSelectedRows((current) => new Set([...current].filter((key) => !key.startsWith(`${city}|`) || retainedKeys.has(key))))
        setCityStates((current) => ({ ...current, [city]: { status: "completada", elapsed: performance.now() - started, ...range } }))
      } catch (error) {
        setCityStates((current) => ({ ...current, [city]: { status: "error", error: error instanceof Error ? error.message : "Error de red.", elapsed: performance.now() - started, ...range } }))
        setExtractMessage(`Falló la descarga de ${city}. Puedes reintentar solo esa ciudad.`)
      }
      setRunProgress((current) => ({ processed: [...current.processed, city], pending: cities.slice(index + 1), current: null }))
    }
    setRunProgress((current) => ({ ...current, pending: [], current: null }))
    setExtracting(false); extractionInFlight.current = false
  }

  function downloadOriginal(city: string) {
    const raw = rawByCity[city]
    if (!raw) return
    const href = URL.createObjectURL(new Blob([JSON.stringify(raw, null, 2)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = href; link.download = `open-meteo-${city.toLowerCase()}-${start}-${end}.json`; link.click()
    window.setTimeout(() => URL.revokeObjectURL(href), 1000)
  }

  async function loadDestination(targetPage = 0) {
    setDestinationMessage("")
    const query = new URLSearchParams({ page: String(targetPage), pageSize: String(pageSize) })
    if (destinationCity) query.set("ciudad", destinationCity)
    if (destinationStart) query.set("desde", utcDateTimeInputToIso(destinationStart))
    if (destinationEnd) query.set("hasta", utcDateTimeInputToIso(destinationEnd))
    query.set("orderBy", destinationOrder); query.set("direction", destinationDirection)
    try {
      const response = await fetch(`/api/measurements?${query}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || "No se pudo consultar Supabase.")
      setDestination(payload.registros); setDestinationTotal(payload.total); setDestinationPage(targetPage)
    } catch (error) { setDestinationMessage(error instanceof Error ? error.message : "No se pudo consultar Supabase.") }
  }

  async function runBatches(snapshot: WeatherRecord[], retryOnly = false) {
    if (inFlight.current) return
    inFlight.current = true; setLoading(true); setLoadMessage("")
    const currentBatches = retryOnly ? [...batches] : partitionBatches(snapshot).map((rows) => ({ status: "pendiente" as const, count: rows.length }))
    if (!retryOnly) { setFrozen(snapshot); setBatches(currentBatches) }
    const failed: string[] = []
    const indices = retryOnly ? failedBatchIndices(currentBatches) : currentBatches.map((_, index) => index)
    for (const index of indices) {
      currentBatches[index] = { ...currentBatches[index], status: "en curso", error: undefined }; setBatches([...currentBatches])
      const batchRows = (retryOnly ? frozen : snapshot).slice(index * 500, index * 500 + 500)
      const batchStarted = performance.now()
      try {
        const response = await fetch("/api/measurements/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ registros: batchRows }) })
        const payload = await response.json()
        if (!response.ok) throw new Error(payload.error || "Falló la carga del lote.")
        currentBatches[index] = { ...currentBatches[index], status: "completado", elapsed: performance.now() - batchStarted }
      } catch (error) {
        currentBatches[index] = { ...currentBatches[index], status: "error", error: error instanceof Error ? error.message : "Error de red.", elapsed: performance.now() - batchStarted }
        failed.push(`Lote ${index + 1}`)
      }
      setBatches([...currentBatches])
    }
    const succeeded = currentBatches.filter((batch) => batch.status === "completado").reduce((sum, batch) => sum + batch.count, 0)
    const failedCount = currentBatches.filter((batch) => batch.status === "error").reduce((sum, batch) => sum + batch.count, 0)
    setLoadMessage(failed.length ? `${succeeded} registros procesados y verificados; ${failedCount} fallidos. Lotes: ${failed.join(", ")}. Puedes reintentar los fallidos.` : `${succeeded} registros procesados y verificados en destino. Supabase no informa aquí cuántos fueron inserciones frente a actualizaciones.`)
    setLoading(false); inFlight.current = false
  }

  const phases = [
    { name: "Extracción", status: extracting ? "en curso" : extractionDone ? selectedCities.some((name) => cityStates[name].status === "error") ? "con errores" : "completada" : "pendiente", input: "Open-Meteo", output: results.totalExtracted, explanation: "Descarga los arrays horarios originales en UTC.", duration: Object.values(cityStates).reduce((n, state) => n + (state.elapsed || 0), 0) },
    { name: "Transformación", status: extracting ? "en curso" : extractionDone ? "completada" : "pendiente", input: results.totalExtracted, output: results.transformed.length, explanation: "Combina arrays paralelos en una fila por ciudad y hora.", duration: results.transformationMs },
    { name: "Limpieza", status: extracting ? "en curso" : extractionDone ? results.rejected.length || results.malformedArrays ? "con errores" : "completada" : "pendiente", input: results.transformed.length, output: results.valid.length, explanation: "Rechaza valores inválidos; conserva la primera clave válida.", duration: results.cleaningMs },
    { name: "Filtrado y selección", status: extracting ? "en curso" : extractionDone ? "completada" : "pendiente", input: results.valid.length, output: visibleSelected.length, explanation: "Aplica filtros, ordena y respeta selección manual.", duration: filteredResult.duration },
    { name: "Carga", status: loading ? "en curso" : batches.some((batch) => batch.status === "error") ? "con errores" : batches.some((batch) => batch.status === "completado") ? "completada" : "pendiente", input: visibleSelected.length, output: batches.filter((batch) => batch.status === "completado").reduce((sum, batch) => sum + batch.count, 0), explanation: "Upsert por ciudad y fecha/hora en lotes de hasta 500.", duration: batches.reduce((sum, batch) => sum + (batch.elapsed || 0), 0) },
  ]

  return <main className="workspace">
    <header className="topbar"><div className="brand"><span className="brand-mark">M</span><span>meteorología <b>/ laboratorio ETL</b></span></div><span className="practice-tag">PRÁCTICA 01 <i>●</i> BIG DATA</span></header>
    <section className="intro"><div><div className="eyebrow">PIPELINE DE DATOS · OPEN-METEO → SUPABASE</div><h1>Del dato crudo al dato confiable.</h1><p>Extrae, transforma, limpia y decide qué registros cargar. Cada paso es visible y verificable.</p></div><div className="intro-meta"><span className="live-dot"/> ENTORNO DE PRÁCTICA <small>Datos horarios · UTC</small></div></section>

    <section className="configuration panel"><div className="section-heading"><div><span className="step-label">01 / ORIGEN</span><h2>Configuración de extracción</h2></div><span className="api-badge">OPEN-METEO ARCHIVE API ↗</span></div>
      <div className="config-grid"><div className="field-group"><label>Ciudades <span>· {selectedCities.length} seleccionadas</span></label><div className="city-grid">{CITIES.map((city) => <label className="city-option" key={city.name}><input type="checkbox" checked={selectedCities.includes(city.name)} disabled={extracting} onChange={(event) => setSelectedCities((current) => event.target.checked ? [...current, city.name] : current.filter((name) => name !== city.name))}/><span>{city.name}</span></label>)}</div></div>
      <div className="field-group dates"><label>Intervalo horario <span>· UTC</span></label><div className="date-row"><label>Desde<input type="date" disabled={extracting} value={start} onChange={(event) => setStart(event.target.value)}/></label><span className="date-arrow">→</span><label>Hasta<input type="date" disabled={extracting} value={end} onChange={(event) => setEnd(event.target.value)}/></label></div><small>Máximo 31 días por extracción.</small></div>
      <div className="volume-card"><span>VOLUMEN PREVISTO</span><strong>{new Intl.NumberFormat("es-ES").format(selectedCitiesHours)}</strong><small>filas horarias · {selectedCities.length} ciudades</small><button className="primary-button" disabled={!validPeriod || !selectedCities.length || extracting} onClick={() => extract(selectedCities)}>{extracting ? "Extrayendo…" : "Extraer datos"}<span>↗</span></button></div></div>
      {!validPeriod && <div className="alert error-alert">Selecciona fechas válidas; el intervalo debe ser de 1 a 31 días.</div>}
      {extractMessage && <div className="alert error-alert">{extractMessage}</div>}
      <div className="city-progress">{CITIES.filter((city) => selectedCities.includes(city.name)).map((city) => { const state = cityStates[city.name]; return <div className="city-progress-item" key={city.name}><span className={`status-dot ${state.status.replace(" ", "-")}`}/><b>{city.name}</b><span className={`state-text ${state.status === "error" ? "error-text" : ""}`}>{state.status}{state.elapsed != null ? ` · ${(state.elapsed / 1000).toFixed(2)} s` : ""}</span>{state.status === "error" && <><span className="row-error">{state.error}</span><button className="text-button" disabled={extracting} onClick={() => extract([city.name], true, { start: state.start || start, end: state.end || end })}>Reintentar</button></>}</div> })}</div>
    </section>

    <section className="pipeline-section"><div className="section-heading"><div><span className="step-label">02 / PROCESO</span><h2>Visualización del pipeline</h2></div><span className="realtime-label"><span className="live-dot"/> ESTADOS EN TIEMPO REAL</span></div>
      <div className="pipeline">{phases.map((phase, index) => <article className={`phase-card ${index === 0 ? "phase-first" : ""}`} key={phase.name}><div className="phase-top"><span className="phase-index">0{index + 1}</span><span className={`phase-state ${phase.status.replaceAll(" ", "-")}`}>{phase.status}</span></div><h3>{phase.name}</h3><p>{phase.explanation}</p><div className="phase-counts"><span>ENTRADA <b>{typeof phase.input === "number" ? phase.input.toLocaleString("es-ES") : phase.input}</b></span><span>SALIDA <b>{typeof phase.output === "number" ? phase.output.toLocaleString("es-ES") : phase.output}</b></span></div><div className="phase-foot"><span>Duración real</span><b>{phase.duration > 0 ? `${(phase.duration / 1000).toFixed(2)} s` : extractionDone && phase.name !== "Carga" ? "< 0,01 s" : "—"}</b></div>{index < phases.length - 1 && <span className="phase-arrow">→</span>}</article>)}</div>
      {extracting && <div className="processing-note"><span className="spinner"/> Procesando: {runProgress.processed.join(", ") || "ninguna ciudad terminada"}{runProgress.current && ` · en curso: ${runProgress.current}`}<span> · pendientes: {runProgress.pending.join(", ") || "ninguna"}</span></div>}
    </section>

    <section className="data-section panel"><div className="section-heading data-heading"><div><span className="step-label">03 / INSPECCIÓN</span><h2>Explorador de datos</h2></div><div className="counter-strip"><div><span>TOTAL EXTRAÍDO</span><b>{results.totalExtracted.toLocaleString("es-ES")}</b></div><div><span>VÁLIDOS</span><b>{results.valid.length.toLocaleString("es-ES")}</b></div><div><span>RECHAZADOS</span><b>{results.rejected.length.toLocaleString("es-ES")}</b></div><div><span>COINCIDEN</span><b>{filtered.length.toLocaleString("es-ES")}</b></div><div><span>SELECCIONADOS</span><b>{visibleSelected.length.toLocaleString("es-ES")}</b></div></div></div>
      <div className="tab-list" role="tablist">{tabs.map((name) => <button role="tab" aria-selected={tab === name} className={tab === name ? "active-tab" : ""} key={name} onClick={() => { setTab(name); setPage(0); if (name === "destino") void loadDestination() }}>{name === "original" ? "JSON original" : name === "transformados" ? "Transformados" : name === "validos" ? "Registros válidos" : name === "rechazados" ? "Rechazados" : name === "vista previa" ? "Vista previa de carga" : "Datos en Supabase"}{name === "destino" && <span className="persisted-pill">DESTINO</span>}</button>)}</div>
      {tab === "original" && <div className="raw-inspector"><aside><label>Ciudad<select value={originalCity} onChange={(event) => setOriginalCity(event.target.value)}>{CITIES.filter((city) => rawByCity[city.name]).map((city) => <option key={city.name}>{city.name}</option>)}</select></label><button className="secondary-button" disabled={!rawByCity[originalCity]} onClick={() => downloadOriginal(originalCity)}>Descargar JSON ↓</button><p>Se conserva la respuesta íntegra de la API durante esta sesión de trabajo.</p></aside><pre>{rawByCity[originalCity] ? JSON.stringify(rawByCity[originalCity], null, 2) : "Aún no hay JSON. Extrae una ciudad para inspeccionar la respuesta original."}</pre></div>}
      {tab === "destino" && <div className="destination-panel"><div className="filters compact-filters"><label>Ciudad<select value={destinationCity} onChange={(event) => setDestinationCity(event.target.value)}><option value="">Todas</option>{CITIES.map((city) => <option key={city.name}>{city.name}</option>)}</select></label><label>Desde UTC<input type="datetime-local" value={destinationStart} onChange={(event) => setDestinationStart(event.target.value)}/></label><label>Hasta UTC<input type="datetime-local" value={destinationEnd} onChange={(event) => setDestinationEnd(event.target.value)}/></label><label>Ordenar por<select value={destinationOrder} onChange={(event) => setDestinationOrder(event.target.value as Filters["orderBy"])}><option value="ciudad">Ciudad</option><option value="fecha_hora">Fecha/hora</option><option value="temperatura_c">Temperatura</option><option value="humedad_pct">Humedad</option><option value="precipitacion_mm">Precipitación</option></select></label><label>Dirección<select value={destinationDirection} onChange={(event) => setDestinationDirection(event.target.value as Filters["direction"])}><option value="asc">Ascendente</option><option value="desc">Descendente</option></select></label><button className="secondary-button" onClick={() => void loadDestination(0)}>Actualizar datos</button></div>{destinationMessage && <div className="alert error-alert">{destinationMessage}</div>}<p className="table-note">Datos leídos de Supabase · {destinationTotal.toLocaleString("es-ES")} persistidos. La carga local sin subir permanece separada.</p><RecordsTable rows={destination} selectable={false}/><Pagination page={destinationPage} pages={Math.max(1, Math.ceil(destinationTotal / pageSize))} setPage={(next) => void loadDestination(next)}/></div>}
      {tab !== "original" && tab !== "destino" && <>
        {(tab === "validos" || tab === "vista previa") && <div className="filters"><label>Ciudades<select multiple value={filters.cities} onChange={(event) => updateFilter("cities", Array.from(event.target.selectedOptions, (option) => option.value))}>{CITIES.map((city) => <option key={city.name}>{city.name}</option>)}</select></label><label>Fecha/hora desde (UTC)<input type="datetime-local" value={filters.from} onChange={(event) => updateFilter("from", event.target.value)}/></label><label>Hasta (UTC)<input type="datetime-local" value={filters.to} onChange={(event) => updateFilter("to", event.target.value)}/></label><label>Temperatura °C<input type="number" placeholder="mín." value={filters.temperatureMin} onChange={(event) => updateFilter("temperatureMin", event.target.value)}/><input type="number" placeholder="máx." value={filters.temperatureMax} onChange={(event) => updateFilter("temperatureMax", event.target.value)}/></label><label>Humedad %<span className="range-inputs"><input type="number" placeholder="mín." value={filters.humidityMin} onChange={(event) => updateFilter("humidityMin", event.target.value)}/><input type="number" placeholder="máx." value={filters.humidityMax} onChange={(event) => updateFilter("humidityMax", event.target.value)}/></span></label><label>Precipitación mm<span className="range-inputs"><input type="number" placeholder="mín." value={filters.precipitationMin} onChange={(event) => updateFilter("precipitationMin", event.target.value)}/><input type="number" placeholder="máx." value={filters.precipitationMax} onChange={(event) => updateFilter("precipitationMax", event.target.value)}/></span></label><label className="rain-check"><input type="checkbox" checked={filters.rainOnly} onChange={(event) => updateFilter("rainOnly", event.target.checked)}/> Solo registros con lluvia</label><label>Ordenar por<select value={filters.orderBy} onChange={(event) => updateFilter("orderBy", event.target.value as Filters["orderBy"])}><option value="ciudad">Ciudad</option><option value="fecha_hora">Fecha/hora</option><option value="temperatura_c">Temperatura</option><option value="humedad_pct">Humedad</option><option value="precipitacion_mm">Precipitación</option></select></label><label>Dirección<select value={filters.direction} onChange={(event) => updateFilter("direction", event.target.value as Filters["direction"])}><option value="asc">Ascendente</option><option value="desc">Descendente</option></select></label><button className="link-button" onClick={() => { setFilters(defaultFilters()); setPage(0) }}>Restablecer filtros ↺</button></div>}{resolvedFilterError && <div className="alert error-alert">Revisa el filtro: {resolvedFilterError}.</div>}
        <div className="selection-toolbar"><div><b>{filtered.length.toLocaleString("es-ES")}</b> coinciden con los filtros <span>·</span> <b>{visibleSelected.length.toLocaleString("es-ES")}</b> seleccionados <span>·</span> <b>{outsideCount.toLocaleString("es-ES")}</b> seleccionados fuera de filtros</div><div className="selection-actions"><button className="text-button" disabled={!filtered.length} onClick={() => setSelectedRows((current) => new Set([...current, ...filtered.map(keyOf)]))}>Seleccionar todos los resultados</button><button className="text-button" disabled={!selectedRows.size} onClick={() => setSelectedRows(new Set())}>Vaciar selección</button></div></div>
        <div className="table-scroll">{tab === "rechazados" ? <table><thead><tr><th>Ciudad</th><th>Fecha/hora recibida</th><th>Motivo del rechazo</th></tr></thead><tbody>{shownRows.length ? shownRows.map((row, i) => <tr key={`${row.ciudad}-${row.fecha_hora}-${i}`}><td>{row.ciudad}</td><td>{row.fecha_hora}</td><td className="error-text">{"motivo" in row ? row.motivo : ""}</td></tr>) : <EmptyRow text="No hay registros rechazados." columns={3}/>}</tbody></table> : tab === "transformados" ? <TransformedTable rows={shownRows as TransformedRecord[]}/> : <RecordsTable rows={shownRows as WeatherRecord[]} selectable={tab === "validos" || tab === "vista previa"} selectedRows={selectedRows} toggle={(row) => setSelectedRows((current) => { const next = new Set(current); if (next.has(keyOf(row))) next.delete(keyOf(row)); else next.add(keyOf(row)); return next })}/>}</div>
        <div className="table-footer"><span>{inspectRows.length ? `Mostrando ${page * pageSize + 1}–${Math.min(inspectRows.length, (page + 1) * pageSize)} de ${inspectRows.length.toLocaleString("es-ES")}` : "Sin filas para mostrar"}{tab === "vista previa" && " · este es el conjunto congelado al iniciar la carga"}</span><Pagination page={page} pages={pages} setPage={setPage}/></div>
        {tab === "vista previa" && <div className="load-footer"><p>La base de datos no conserva el orden de inserción. Las consultas posteriores necesitan <code>ORDER BY</code> para reproducir este orden.</p><button className="primary-button" disabled={!visibleSelected.length || loading || extracting || !!resolvedFilterError} onClick={() => void runBatches(createLoadSnapshot(visibleSelected))}>{loading ? "Subiendo…" : `Subir ${visibleSelected.length} registros a Supabase`} <span>↗</span></button>{batches.some((batch) => batch.status === "error") && <button className="secondary-button" disabled={loading} onClick={() => void runBatches(frozen, true)}>Reintentar lotes fallidos</button>}{loadMessage && <div className={`load-message ${batches.some((batch) => batch.status === "error") ? "error-text" : ""}`}>{loadMessage}</div>}</div>}
      </>}
    </section>
    <section className="quality-footer"><div><span className="step-label">CALIDAD DE DATOS</span><p>Los valores ausentes no se convierten en cero. Se excluyen por calidad y se detallan arriba; los filtros solo determinan la selección de carga.</p></div><div className="quality-actions"><span>{batches.filter((batch) => batch.status === "completado").length} lotes completados</span>{batches.map((batch, index) => <span className={`batch-chip ${batch.status}`} title={batch.error} key={index}>Lote {index + 1}: {batch.status} ({batch.count}){batch.error ? ` · ${batch.error}` : ""}</span>)}</div></section>
    <footer><span>LABORATORIO ETL · ESPECIALIZACIÓN BIG DATA</span><span>FUENTE: OPEN-METEO ARCHIVE API · DESTINO: SUPABASE</span><button className="link-button" onClick={() => { const check = makeFixtureCheck(); alert(`Fixture controlado: ${check.totalExtracted} extraídas, ${check.valid.length} válidas y ${check.rejected.length} rechazadas. Nulos preservados y duplicado detectado. No se mezcló con la extracción real.`) }}>Verificar fixture controlado</button></footer>
  </main>
}

function RecordsTable({ rows, selectable, selectedRows = new Set(), toggle }: { rows: WeatherRecord[]; selectable: boolean; selectedRows?: Set<string>; toggle?: (row: WeatherRecord) => void }) {
  return <table><thead><tr>{selectable && <th className="check-col"><span className="sr-only">Seleccionar</span></th>}<th>Ciudad</th><th>Fecha/hora <small>UTC</small></th><th>Temperatura <small>°C</small></th><th>Humedad <small>%</small></th><th>Precipitación <small>mm</small></th>{!selectable && <th>Importado en</th>}</tr></thead><tbody>{rows.length ? rows.map((row) => <tr key={keyOf(row)}>{selectable && <td><input type="checkbox" aria-label={`Seleccionar ${row.ciudad} ${row.fecha_hora}`} checked={selectedRows.has(keyOf(row))} onChange={() => toggle?.(row)}/></td>}<td><span className="city-cell">{row.ciudad}</span></td><td>{displayDate(row.fecha_hora)}</td><td>{number(row.temperatura_c)}</td><td>{number(row.humedad_pct)}</td><td>{number(row.precipitacion_mm)}</td>{!selectable && "importado_en" in row && <td>{String((row as WeatherRecord & { importado_en?: string }).importado_en || "—")}</td>}</tr>) : <EmptyRow text="No hay registros. Extrae datos o cambia los filtros." columns={selectable ? 6 : 6}/>}</tbody></table>
}
function TransformedTable({ rows }: { rows: TransformedRecord[] }) {
  const show = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? number(value) : value === null ? "null" : value === undefined ? "ausente" : String(value)
  return <table><thead><tr><th>Ciudad</th><th>Fecha/hora <small>UTC</small></th><th>Temperatura <small>°C</small></th><th>Humedad <small>%</small></th><th>Precipitación <small>mm</small></th></tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr key={`${row.ciudad}-${row.fecha_hora}-${index}`}><td><span className="city-cell">{row.ciudad}</span></td><td>{row.fecha_hora}</td><td>{show(row.temperatura_c)}</td><td>{show(row.humedad_pct)}</td><td>{show(row.precipitacion_mm)}</td></tr>) : <EmptyRow text="Aún no hay filas transformadas." columns={5}/>}</tbody></table>
}
function EmptyRow({ text, columns }: { text: string; columns: number }) { return <tr><td className="empty-cell" colSpan={columns}>{text}</td></tr> }
function Pagination({ page, pages, setPage }: { page: number; pages: number; setPage: (page: number) => void }) { return <div className="pagination"><button aria-label="Página anterior" disabled={page <= 0} onClick={() => setPage(Math.max(0, page - 1))}>←</button><span>{page + 1} / {pages}</span><button aria-label="Página siguiente" disabled={page + 1 >= pages} onClick={() => setPage(Math.min(pages - 1, page + 1))}>→</button></div> }
