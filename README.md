# NFC Recordatorio

Aplicación web sencilla para recordar tomas de medicación usando una etiqueta NFC y un contador visual.

## Qué hace

- Permite añadir un medicamento.
- Permite indicar cada cuántos días debe tomarse.
- Permite indicar a qué horas debe tomarse.
- Muestra una esfera con el tiempo restante hasta la siguiente toma.
- Cuando se supera la hora, puede recordar periódicamente cada cierto número de minutos.
- Genera un enlace por medicamento para grabarlo en una etiqueta NFC.
- Al leer el NFC con el móvil, la app registra que la medicación ha sido tomada y reinicia el contador.

## Tecnologías

- Vite
- JavaScript
- Supabase

## Configuración

Crea un archivo `.env` con estas variables:

```env
VITE_SUPABASE_URL=TU_URL_DE_SUPABASE
VITE_SUPABASE_PUBLISHABLE_KEY=TU_CLAVE_PUBLICABLE
