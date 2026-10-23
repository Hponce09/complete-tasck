import { createSupabaseAdmin, isWeatherRecord, requireLocalDevelopment, supabaseConfig } from "@/lib/server/supabase"

export const dynamic = "force-dynamic"
const MAX_BODY_BYTES = 1_500_000

export async function POST(request: Request) {
  try { requireLocalDevelopment(request); supabaseConfig() } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Servicio no disponible." }, { status: 403 })
  }
  const contentLength = Number(request.headers.get("content-length") || 0)
  if (contentLength > MAX_BODY_BYTES) return Response.json({ error: "La petición supera el tamaño máximo permitido." }, { status: 413 })
  let text = ""
  if (request.body) {
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel()
        return Response.json({ error: "La petición supera el tamaño máximo permitido." }, { status: 413 })
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
    text = new TextDecoder().decode(merged)
  }
  let body: unknown
  try { body = JSON.parse(text) } catch { return Response.json({ error: "El cuerpo de la petición no es JSON válido." }, { status: 400 }) }
  const rows = (body as { registros?: unknown })?.registros
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500 || !rows.every(isWeatherRecord)) {
    return Response.json({ error: "Envía entre 1 y 500 registros válidos." }, { status: 400 })
  }
  const keys = new Set(rows.map((row) => `${row.ciudad}|${row.fecha_hora}`))
  if (keys.size !== rows.length) return Response.json({ error: "El lote contiene claves ciudad/fecha duplicadas." }, { status: 400 })
  try {
    const supabase = createSupabaseAdmin()
    const { error: upsertError } = await supabase.from("mediciones_meteorologicas").upsert(rows, { onConflict: "ciudad,fecha_hora" })
    if (upsertError) return Response.json({ error: "Supabase rechazó el lote. Comprueba que la migración esté aplicada." }, { status: 502 })

    const verified = new Set<string>()
    for (const city of [...new Set(rows.map((row) => row.ciudad))]) {
      const cityRows = rows.filter((row) => row.ciudad === city)
      const timestamps = cityRows.map((row) => row.fecha_hora).sort()
      for (let offset = 0; ; offset += 1000) {
        const { data: found, error } = await supabase.from("mediciones_meteorologicas").select("ciudad,fecha_hora")
          .eq("ciudad", city).gte("fecha_hora", timestamps[0]).lte("fecha_hora", timestamps[timestamps.length - 1])
          .order("fecha_hora", { ascending: true }).range(offset, offset + 999)
        if (error || !found) return Response.json({ error: "El lote se procesó, pero falló la consulta de verificación." }, { status: 502 })
        for (const row of found) verified.add(`${row.ciudad}|${row.fecha_hora}`)
        if (found.length < 1000) break
      }
    }
    const missing = [...keys].filter((key) => !verified.has(key))
    if (missing.length) return Response.json({ error: `Verificación incompleta: ${missing.length} claves no aparecen en destino.`, verificados: rows.length - missing.length }, { status: 502 })
    return Response.json({ procesadosCorrectamente: rows.length, verificados: rows.length })
  } catch {
    return Response.json({ error: "No se pudo completar la operación con Supabase. Comprueba URL, clave y migración." }, { status: 502 })
  }
}
