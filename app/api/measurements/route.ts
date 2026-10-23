import { createSupabaseAdmin, requireLocalDevelopment, supabaseConfig } from "@/lib/server/supabase"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  try { requireLocalDevelopment(request); supabaseConfig() } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Servicio no disponible." }, { status: 403 })
  }
  const incoming = new URL(request.url).searchParams
  const page = Math.max(0, Number(incoming.get("page") || 0) || 0)
  const pageSize = Math.min(100, Math.max(1, Number(incoming.get("pageSize") || 25) || 25))
  const orderBy = ["ciudad", "fecha_hora", "temperatura_c", "humedad_pct", "precipitacion_mm"].includes(incoming.get("orderBy") || "") ? incoming.get("orderBy")! : "fecha_hora"
  const direction = incoming.get("direction") === "desc" ? "desc" : "asc"
  try {
    let query = createSupabaseAdmin().from("mediciones_meteorologicas").select("*", { count: "exact" })
    if (incoming.get("ciudad")) query = query.eq("ciudad", incoming.get("ciudad")!)
    if (incoming.get("desde")) query = query.gte("fecha_hora", incoming.get("desde")!)
    if (incoming.get("hasta")) query = query.lte("fecha_hora", incoming.get("hasta")!)
    const { data, error, count } = await query.order(orderBy, { ascending: direction === "asc" }).range(page * pageSize, (page + 1) * pageSize - 1)
    if (error || !data) return Response.json({ error: "No se pudieron leer los datos. Comprueba que la migración esté aplicada." }, { status: 502 })
    return Response.json({ registros: data, total: count || 0, page, pageSize })
  } catch {
    return Response.json({ error: "No se pudo conectar con Supabase. Comprueba la configuración y la migración." }, { status: 502 })
  }
}
