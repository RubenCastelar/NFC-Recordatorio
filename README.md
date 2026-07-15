# NFC Recordatorio

Aplicacion web sencilla para registrar tomas de medicacion usando una etiqueta NFC y ver el tiempo restante hasta la siguiente toma.

## Que hace

- Permite anadir un medicamento y como tomarlo.
- Permite definir cada cuantos dias debe tomarse.
- Permite anadir una o varias horas concretas para las tomas.
- Muestra una esfera con cuenta atras hasta la siguiente toma.
- Puede repetir avisos cada cierto numero de minutos una vez se ha excedido la hora.
- Genera un enlace por medicamento para grabarlo en una etiqueta NFC.
- Al leer el NFC con el movil, la app marca la toma y reinicia el contador.

## Como funciona el proyecto

Esta version esta preparada para funcionar como web estatica, sin necesidad de compilar con Vite para subirla a GitHub Pages.

Solo necesita estos archivos:

- `index.html`
- `src/main.js`
- `src/styles.css`
- `src/config.js`

Supabase se carga desde CDN directamente en el navegador.

## Configuracion

La configuracion de Supabase esta en:

```bash
src/config.js
```

Si alguna vez cambias de proyecto de Supabase, solo tendras que actualizar ahi:

- `supabaseUrl`
- `supabaseKey`

## Subida a GitHub Pages

Si quieres subirla manualmente desde GitHub web, publica el repositorio desde la raiz y asegurate de tener:

- `index.html`
- carpeta `src/`

No hace falta subir `dist/` para esta version.

En GitHub:

1. Abre el repositorio.
2. Ve a `Settings`.
3. Ve a `Pages`.
4. En `Build and deployment`, elige `Deploy from a branch`.
5. Selecciona la rama principal.
6. Selecciona la carpeta `/(root)`.
7. Guarda los cambios.

## Flujo NFC recomendado

1. Crea un medicamento en la app.
2. Pulsa `Copiar enlace NFC`.
3. Graba ese enlace en la etiqueta NFC.
4. Cuando el telefono lea la etiqueta, se abrira la app y registrara la toma.

## Supabase

La app usa Supabase si existe la tabla `medications`. Si no, funciona con `localStorage`.

SQL sugerido:

```sql
create extension if not exists "pgcrypto";

create table if not exists public.medications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  dosage text not null,
  frequency_hours integer not null check (frequency_hours > 0),
  interval_days integer check (interval_days > 0),
  intake_times text[],
  schedule_anchor_at timestamptz,
  reminder_minutes integer not null default 30 check (reminder_minutes >= 5),
  last_taken_at timestamptz
);

alter table public.medications
  add column if not exists interval_days integer check (interval_days > 0),
  add column if not exists intake_times text[],
  add column if not exists schedule_anchor_at timestamptz;

create table if not exists public.intake_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  medication_id uuid not null references public.medications(id) on delete cascade,
  taken_at timestamptz not null,
  source text not null default 'nfc'
);

grant usage on schema public to anon;
grant usage on schema public to authenticated;

grant select, insert, update on public.medications to anon;
grant select, insert, update on public.medications to authenticated;
grant insert, select on public.intake_logs to anon;
grant insert, select on public.intake_logs to authenticated;

alter table public.medications enable row level security;
alter table public.intake_logs enable row level security;

drop policy if exists "public can read medications" on public.medications;
drop policy if exists "public can insert medications" on public.medications;
drop policy if exists "public can update medications" on public.medications;
drop policy if exists "public can insert intake logs" on public.intake_logs;

create policy "public can read medications"
on public.medications
for select
to anon
using (true);

create policy "public can insert medications"
on public.medications
for insert
to anon
with check (true);

create policy "public can update medications"
on public.medications
for update
to anon
using (true)
with check (true);

create policy "public can insert intake logs"
on public.intake_logs
for insert
to anon
with check (true);
```

## Nota importante

Para que las notificaciones funcionen, la app debe estar abierta en el navegador y el usuario debe aceptar permisos.

Si ves el aviso de que no se pudo leer Supabase, casi siempre significa una de estas dos cosas:

1. Aun no has creado las tablas `medications` e `intake_logs`.
2. Las tablas existen, pero RLS esta activo sin politicas para `anon`.

Si actualizas la app desde la version anterior, ejecuta de nuevo el SQL para anadir `interval_days`, `intake_times` y `schedule_anchor_at`.

## Archivos que no debes subir

No hace falta subir:

- `node_modules/`
- `dist/`
- `.DS_Store`

Solo evita subir `.env` si lo mantienes por referencia local, aunque esta version ya no depende de el para funcionar en GitHub Pages.
