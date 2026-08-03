-- ===========================================================================
-- Fase 4.3 — Detector semanal de recibos ambiguos (Stephy)
-- ===========================================================================
-- Proyecto Supabase: pdjxswivcgiwzrfexiiw
-- REQUISITO: correr ANTES `sql/fase4-1-guard-recibo-mismo-cliente.sql`
-- (usa `public.norm_tracking_master`). Es idempotente.
--
-- POR QUÉ ESTE Y NO OTRO
-- De los tres detectores del bug, este es el único que NO depende de una
-- ventana de tiempo: mira el ESTADO de `shipping_groups`, no la bitácora.
-- `auditoria_tracking_stephy` se purga y solo ve lo que pasó por el bot; el
-- correo de corrida (Fase 4.2) solo ve la corrida que acaba de terminar. Si un
-- recibo quedó cruzado hace tres meses, este es el que lo sigue viendo.
--
-- QUÉ ES UN "RECIBO AMBIGUO"
-- Un recibo (5-7 dígitos) que aparece en dos o más `shipping_groups` cuyos
-- `tracking_master` son envíos DISTINTOS de verdad (`norm_tracking_master`
-- descarta el ruido de los couriers que anteponen su prefijo al mismo número).
-- Un recibo describe UN bulto recibido en Miami: si cuelga de dos envíos
-- distintos, uno de los dos está mal.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) La vista — el detector de BD
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_recibos_ambiguos_stephy
WITH (security_invoker = true)
AS
WITH g AS (
  SELECT sg.tracking_master_courier AS recibo,
         sg.id_grupo,
         sg.id_venta,
         sg.nombre_grupo,
         sg.tracking_master,
         public.norm_tracking_master(sg.tracking_master) AS tm,
         v.user_id
  FROM public.shipping_groups sg
  JOIN public.venta v ON v.id_venta = sg.id_venta
  WHERE sg.tracking_master_courier ~ '^[0-9]{5,7}$'
),
conflictos AS (
  SELECT DISTINCT a.recibo
  FROM g a
  JOIN g b ON b.recibo = a.recibo
          AND b.id_grupo <> a.id_grupo
          AND a.tm IS NOT NULL
          AND b.tm IS NOT NULL
          AND position(b.tm IN a.tm) = 0
          AND position(a.tm IN b.tm) = 0
)
SELECT g.recibo,
       count(DISTINCT g.id_grupo)                  AS grupos,
       count(DISTINCT g.id_venta)                  AS ventas,
       count(DISTINCT g.user_id)                   AS clientes,
       (count(DISTINCT g.user_id) > 1)             AS cruce_entre_clientes,
       string_agg(DISTINCT 'v' || g.id_venta || '/u' || g.user_id || ': ' ||
                  coalesce(g.tracking_master, '—'), ' · ' ORDER BY 'v' || g.id_venta || '/u' || g.user_id || ': ' ||
                  coalesce(g.tracking_master, '—')) AS detalle
FROM g
JOIN conflictos c ON c.recibo = g.recibo
GROUP BY g.recibo;

COMMENT ON VIEW public.v_recibos_ambiguos_stephy IS
  'Fase 4.3 — recibos de Stephy que cuelgan de dos o más envíos distintos. Detector de estado (no depende de la ventana de auditoria_tracking_stephy).';

-- ---------------------------------------------------------------------------
-- 2) La alerta — arma el correo y lo manda por el webhook de siempre
-- ---------------------------------------------------------------------------
-- Reusa `enviar-log-stephy` (el mismo n8n → Gmail que usa el bot), así que el
-- payload es el de siempre: {asunto, cuerpo, html}.
--
-- Manda correo SIEMPRE, aunque no haya nada: una vez por semana el silencio no
-- distingue "todo bien" de "el job murió". Con hallazgos el asunto va en 🚨.
CREATE OR REPLACE FUNCTION public.alerta_recibos_ambiguos_stephy()
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  c_webhook  constant text := 'https://n8n-n8n.40j1oe.easypanel.host/webhook/enviar-log-stephy';
  v_n        integer;
  v_n_cruce  integer;
  v_bloq     integer;
  v_avis     integer;
  v_asunto   text;
  v_cuerpo   text;
  v_html     text;
  v_filas    text := '';
  v_hoy      text := to_char(now() AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD HH24:MI');
  r          record;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE cruce_entre_clientes)
    INTO v_n, v_n_cruce
  FROM public.v_recibos_ambiguos_stephy;

  -- Lo que el guard cazó en caliente durante la semana (Fase 4.1).
  SELECT count(*) FILTER (WHERE accion LIKE 'bloqueado%'),
         count(*) FILTER (WHERE accion = 'avisado')
    INTO v_bloq, v_avis
  FROM public.auditoria_recibo_duplicado
  WHERE ocurrido_at >= now() - interval '7 days';

  v_asunto := CASE
    WHEN v_n > 0 THEN format('🚨 Stephy — %s recibo(s) ambiguo(s) en BD', v_n)
    ELSE '✅ Stephy — sin recibos ambiguos en BD'
  END;

  v_cuerpo := format(
    E'DETECTOR SEMANAL DE RECIBOS AMBIGUOS\n'
    '────────────────────────────────────\n'
    'Corrido:            %s\n'
    'Recibos ambiguos:   %s (%s con cruce entre clientes)\n'
    'Guard últimos 7 d:  %s bloqueado(s), %s avisado(s)\n\n'
    'Un recibo ambiguo es un recibo que cuelga de dos o más envíos distintos.\n'
    'Describe UN bulto recibido en Miami: si aparece en dos, uno está mal.\n\n',
    v_hoy, v_n, v_n_cruce, coalesce(v_bloq, 0), coalesce(v_avis, 0));

  FOR r IN
    SELECT * FROM public.v_recibos_ambiguos_stephy
    ORDER BY cruce_entre_clientes DESC, recibo
  LOOP
    v_cuerpo := v_cuerpo || format(
      E'· %s — %s grupo(s), %s cliente(s)%s\n    %s\n',
      r.recibo, r.grupos, r.clientes,
      CASE WHEN r.cruce_entre_clientes THEN '  ⚠ CRUCE ENTRE CLIENTES' ELSE '' END,
      r.detalle);

    v_filas := v_filas || format(
      '<tr style="background:%s"><td style="padding:8px 14px;font-weight:700;color:#0f172a;white-space:nowrap;vertical-align:top">%s</td>'
      '<td style="padding:8px 14px;color:#0f172a">%s grupo(s), %s cliente(s)%s'
      '<div style="color:#64748b;font-size:12px;margin-top:4px">%s</div></td></tr>',
      CASE WHEN r.cruce_entre_clientes THEN '#fef2f2' ELSE '#ffffff' END,
      r.recibo, r.grupos, r.clientes,
      CASE WHEN r.cruce_entre_clientes
           THEN ' <b style="color:#b91c1c">⚠ cruce entre clientes</b>' ELSE '' END,
      replace(replace(coalesce(r.detalle, ''), '&', '&amp;'), '<', '&lt;'));
  END LOOP;

  v_html :=
    '<div style="margin:0;padding:24px 12px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,''Segoe UI'',Roboto,Helvetica,Arial,sans-serif">'
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08)">'
    || format('<tr><td style="height:6px;background:%s"></td></tr>',
              CASE WHEN v_n > 0 THEN '#dc2626' ELSE '#16a34a' END)
    || format('<tr><td style="padding:22px 24px 14px;background:%s">'
              '<div style="font-size:21px;font-weight:700;color:#0f172a">%s Recibos ambiguos en BD</div>'
              '<div style="font-size:13px;color:#64748b;margin-top:6px">Detector semanal · %s</div></td></tr>',
              CASE WHEN v_n > 0 THEN '#fef2f2' ELSE '#ecfdf5' END,
              CASE WHEN v_n > 0 THEN '🚨' ELSE '✅' END,
              v_hoy)
    || format('<tr><td style="padding:18px 18px 4px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%%"><tr>'
              '<td style="padding:0 6px"><div style="background:%s;border-radius:10px;padding:12px 16px;text-align:center">'
              '<div style="font-size:26px;font-weight:700;color:%s;line-height:1">%s</div>'
              '<div style="font-size:12px;color:#64748b;margin-top:4px">recibos ambiguos</div></div></td>'
              '<td style="padding:0 6px"><div style="background:#f1f5f9;border-radius:10px;padding:12px 16px;text-align:center">'
              '<div style="font-size:26px;font-weight:700;color:#475569;line-height:1">%s</div>'
              '<div style="font-size:12px;color:#64748b;margin-top:4px">bloqueados por el guard (7 d)</div></div></td>'
              '<td style="padding:0 6px"><div style="background:#fffbeb;border-radius:10px;padding:12px 16px;text-align:center">'
              '<div style="font-size:26px;font-weight:700;color:#d97706;line-height:1">%s</div>'
              '<div style="font-size:12px;color:#64748b;margin-top:4px">avisados mismo cliente (7 d)</div></div></td>'
              '</tr></table></td></tr>',
              CASE WHEN v_n > 0 THEN '#fef2f2' ELSE '#ecfdf5' END,
              CASE WHEN v_n > 0 THEN '#dc2626' ELSE '#16a34a' END,
              v_n, coalesce(v_bloq, 0), coalesce(v_avis, 0))
    || CASE WHEN v_filas = '' THEN
         '<tr><td style="padding:14px 24px 4px"><div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:12px 14px;color:#065f46;font-size:13px">'
         'Ningún recibo cuelga de dos envíos distintos. Nada que hacer.</div></td></tr>'
       ELSE
         '<tr><td style="padding:14px 24px 4px">'
         '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid #e2e8f0;border-radius:8px;border-collapse:separate;overflow:hidden;font-size:13px">'
         || v_filas || '</table></td></tr>'
       END
    || '<tr><td style="padding:14px 24px 22px;border-top:1px solid #f1f5f9">'
       '<div style="font-size:12px;color:#94a3b8">MamaSAN · detector semanal (Fase 4.3) · v_recibos_ambiguos_stephy</div>'
       '</td></tr></table></div>';

  PERFORM net.http_post(
    url     := c_webhook,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := jsonb_build_object('asunto', v_asunto, 'cuerpo', v_cuerpo, 'html', v_html)
  );
END;
$function$;

COMMENT ON FUNCTION public.alerta_recibos_ambiguos_stephy() IS
  'Fase 4.3 — manda por el webhook enviar-log-stephy el estado de v_recibos_ambiguos_stephy + lo que cazó el guard en 7 días. Lo dispara el job semanal alerta-recibos-ambiguos-stephy.';

-- ---------------------------------------------------------------------------
-- 3) El job semanal
-- ---------------------------------------------------------------------------
-- La BD corre en UTC y Caracas es UTC-4: '0 12 * * 1' = lunes 8:00 de la mañana,
-- misma convención que los jobs `actualizar-binance-*` que ya viven aquí.
SELECT cron.unschedule('alerta-recibos-ambiguos-stephy')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alerta-recibos-ambiguos-stephy');

SELECT cron.schedule(
  'alerta-recibos-ambiguos-stephy',
  '0 12 * * 1',
  $$SELECT public.alerta_recibos_ambiguos_stephy();$$
);

-- ---------------------------------------------------------------------------
-- 4) Verificación
-- ---------------------------------------------------------------------------
-- 4.a) Lo que ve el detector hoy. Al 2026-08-03 son 3 filas — 325920 y 326092
--      con cruce entre clientes, 326250 dentro del mismo cliente. Las tres son
--      de la era 3xxxxx, anteriores a este bot: sirven de línea base. Si en una
--      semana aparece un 4xxxxx nuevo, eso sí es regresión.
SELECT * FROM public.v_recibos_ambiguos_stephy
ORDER BY cruce_entre_clientes DESC, recibo;

-- 4.b) El job quedó armado.
SELECT jobid, jobname, schedule, active FROM cron.job
WHERE jobname = 'alerta-recibos-ambiguos-stephy';

-- 4.c) Prueba de fuego — manda el correo AHORA (no escribe nada en las tablas).
--      Descomentar solo si se quiere ver el correo sin esperar al lunes.
-- SELECT public.alerta_recibos_ambiguos_stephy();
-- SELECT id, status_code, created FROM net._http_response ORDER BY id DESC LIMIT 3;
