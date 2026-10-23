# Laboratorio ETL meteorológico

Práctica de Big Data que extrae datos horarios históricos de Open-Meteo, los convierte a filas normalizadas, rechaza problemas de calidad y permite filtrar y seleccionar exactamente qué enviar a Supabase.

## Instalación y ejecución

1. Usa Node.js compatible con Next.js 16 e instala dependencias con `npm install`.
2. Usa `.env.example` como referencia y añade `SUPABASE_URL` y `SUPABASE_SECRET_KEY` a `.env.local` desde **Supabase → Project Settings → API Keys**. Si aún no existe `.env.local`, puedes copiar el ejemplo como punto de partida. Usa la Secret key (`sb_secret_...`) del servidor. No la pongas en una variable `NEXT_PUBLIC_*` ni la compartas.
3. Ejecuta la migración `supabase/migrations/20261023000000_create_mediciones_meteorologicas.sql` en Supabase SQL Editor o con Supabase CLI.
4. Ejecuta `npm run dev` y abre `http://localhost:3000`.

La extracción de Open-Meteo funciona sin credenciales. Si no configuras Supabase o no aplicas la migración, la app mostrará el error real de configuración/esquema y no simulará una carga.

## Pipeline

La aplicación consulta Open-Meteo Archive en UTC, con °C y mm; transforma arrays horarios paralelos en registros; rechaza fechas/mediciones inválidas y conserva la primera aparición válida de duplicados por ciudad y hora. Los filtros se aplican sobre válidos antes de ordenar, seleccionar y paginar. La selección manual persiste al cambiar filtros, pero solo las filas seleccionadas que siguen cumpliéndolos entran a la vista previa y a la carga.

La carga congela el orden elegido, envía lotes de hasta 500 con upsert por `(ciudad, fecha_hora)` y consulta Supabase para verificar sus claves. Las respuestas no permiten distinguir inserciones de actualizaciones, por lo que solo se informa de filas procesadas y verificadas. La pestaña de destino lee datos persistidos con paginación.

## Seguridad y límites

No hay autenticación en esta práctica. Las rutas que leen/escriben con la clave de servidor aceptan solo `localhost`/`127.0.0.1` en entorno de desarrollo; no publiques este flujo sin protegerlo con autenticación y autorización en servidor. La tabla mantiene RLS activado sin políticas públicas. No se registran secretos en logs.

El archivo `.env.local` está excluido de Git. Nunca subas credenciales. Los datos originales se mantienen en memoria durante la sesión del navegador y se pueden descargar como JSON. El fixture de calidad disponible en la pantalla es aislado y no forma parte de las extracciones reales.

## Verificaciones

`npm run typecheck` y `npm run build` comprueban tipos y compilación. El botón **Verificar fixture controlado** comprueba null y duplicados sin mezclar filas de fixture con Open-Meteo. Para verificar una extracción real de un día, selecciona una ciudad y una sola fecha: se esperan 24 horas UTC según la respuesta de la API. La integración con Supabase requiere credenciales válidas y la migración aplicada.
