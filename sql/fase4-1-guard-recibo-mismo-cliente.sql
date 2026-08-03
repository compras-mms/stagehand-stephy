-- ===========================================================================
-- Fase 4.1 — Blindaje del bug de recibos cruzados de Stephy
-- ===========================================================================
-- Proyecto Supabase: pdjxswivcgiwzrfexiiw
-- Correr COMPLETO, de una sentada (SQL Editor de Supabase). Es idempotente.
--
-- QUÉ ARREGLA
-- El guard histórico (`guard_recibo_duplicado` sobre `shipping_groups`) solo
-- actuaba cuando el recibo caía en un grupo de OTRO cliente
-- (`v.user_id IS DISTINCT FROM v_user_new`). Los cruces DENTRO de un mismo
-- cliente pasaban limpios — y son los más probables, porque los trackings de una
-- venta se buscan seguidos. Ese hueco es el que dejó invisible el caso 449829.
--
-- QUÉ HACE AHORA
--   (A) recibo ya usado por OTRO cliente  ⇒ BLOQUEA (revierte) + audita 'bloqueado'
--   (B) mismo cliente, tracking_master distinto ⇒ SOLO AVISA + audita 'avisado'
--
-- Por qué (B) no revierte: un mismo cliente sí puede tener legítimamente el mismo
-- recibo en dos grupos (los consolidados bajo MAMA SAN / JAIME MOLINA). Revertir
-- ahí rompería datos buenos; el aviso queda en `auditoria_recibo_duplicado` y lo
-- levanta el detector semanal (Fase 4.3).
--
-- Se conservan intactos el filtro `~ '^[0-9]{5,7}$'` y el escape
-- `app.bypass_recibo_guard`.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1) Normalizador de tracking_master
-- ---------------------------------------------------------------------------
-- Mayúsculas y sin separadores. Devuelve NULL si queda vacío o con menos de 8
-- caracteres (demasiado corto para comparar con confianza).
--
-- Existe para que dos formas del MISMO envío no se cuenten como distintas: hay
-- couriers que anteponen su prefijo al número (p.ej. '517967985475' y
-- '9622001900005890833200517967985475', o '9361289677063201119748' y
-- 'C14203312693612896770632...'). Sin esto, esos casos serían aviso falso.
CREATE OR REPLACE FUNCTION public.norm_tracking_master(p_tm text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(
           regexp_replace(upper(coalesce(p_tm, '')), '[^A-Z0-9]', '', 'g'),
           ''
         )
  WHERE length(regexp_replace(upper(coalesce(p_tm, '')), '[^A-Z0-9]', '', 'g')) >= 8
$$;

COMMENT ON FUNCTION public.norm_tracking_master(text) IS
  'Fase 4.1 — normaliza tracking_master para comparar (mayúsculas, sin separadores, NULL si <8 chars).';

-- ---------------------------------------------------------------------------
-- 2) El guard extendido
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_guard_recibo_duplicado()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  v_bypass   text := current_setting('app.bypass_recibo_guard', true);
  v_user_new integer;
  v_tm_new   text;
  v_conf     record;
BEGIN
  IF NEW.tracking_master_courier IS NULL
     OR NEW.tracking_master_courier !~ '^[0-9]{5,7}$'
     OR (v_bypass IS NOT NULL AND v_bypass = 'on')
     OR (TG_OP = 'UPDATE' AND NEW.tracking_master_courier IS NOT DISTINCT FROM OLD.tracking_master_courier)
  THEN
    RETURN NEW;
  END IF;

  SELECT v.user_id INTO v_user_new FROM public.venta v WHERE v.id_venta = NEW.id_venta;

  -- (A) Recibo ya usado por OTRO cliente ⇒ se BLOQUEA (comportamiento histórico).
  SELECT sg.id_grupo, sg.id_venta, v.user_id
    INTO v_conf
  FROM public.shipping_groups sg
  JOIN public.venta v ON v.id_venta = sg.id_venta
  WHERE sg.tracking_master_courier = NEW.tracking_master_courier
    AND sg.id_grupo <> NEW.id_grupo
    AND v.user_id IS DISTINCT FROM v_user_new
  LIMIT 1;

  IF FOUND THEN
    BEGIN
      INSERT INTO public.auditoria_recibo_duplicado
        (tabla, id_grupo, id_venta, user_id_nuevo, recibo,
         id_grupo_existente, id_venta_existente, user_id_existente, accion,
         application_name, session_user_name, client_addr, top_query)
      VALUES
        (TG_TABLE_NAME, NEW.id_grupo, NEW.id_venta, v_user_new, NEW.tracking_master_courier,
         v_conf.id_grupo, v_conf.id_venta, v_conf.user_id, 'bloqueado',
         current_setting('application_name', true), session_user, inet_client_addr(),
         left(current_query(), 2000));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    IF TG_OP = 'UPDATE' THEN
      NEW.tracking_master_courier := OLD.tracking_master_courier;
    ELSE
      NEW.tracking_master_courier := NULL;
    END IF;

    RETURN NEW;
  END IF;

  -- (B) Fase 4.1 — MISMO cliente con tracking_master distinto ⇒ se AVISA.
  -- Un recibo describe UN bulto recibido en Miami: si aparece en dos grupos del
  -- mismo cliente cuyos tracking_master no son el mismo envío, uno de los dos
  -- está mal. Solo se audita — ver la nota de arriba sobre los consolidados.
  v_tm_new := public.norm_tracking_master(NEW.tracking_master);

  IF v_tm_new IS NOT NULL THEN
    SELECT sg.id_grupo, sg.id_venta, v.user_id
      INTO v_conf
    FROM public.shipping_groups sg
    JOIN public.venta v ON v.id_venta = sg.id_venta
    WHERE sg.tracking_master_courier = NEW.tracking_master_courier
      AND sg.id_grupo <> NEW.id_grupo
      AND v.user_id IS NOT DISTINCT FROM v_user_new
      AND public.norm_tracking_master(sg.tracking_master) IS NOT NULL
      -- distintos de verdad: ninguno contiene al otro.
      AND position(public.norm_tracking_master(sg.tracking_master) IN v_tm_new) = 0
      AND position(v_tm_new IN public.norm_tracking_master(sg.tracking_master)) = 0
    LIMIT 1;

    IF FOUND THEN
      BEGIN
        INSERT INTO public.auditoria_recibo_duplicado
          (tabla, id_grupo, id_venta, user_id_nuevo, recibo,
           id_grupo_existente, id_venta_existente, user_id_existente, accion,
           application_name, session_user_name, client_addr, top_query)
        VALUES
          (TG_TABLE_NAME, NEW.id_grupo, NEW.id_venta, v_user_new, NEW.tracking_master_courier,
           v_conf.id_grupo, v_conf.id_venta, v_conf.user_id, 'avisado',
           current_setting('application_name', true), session_user, inet_client_addr(),
           left(current_query(), 2000));
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_guard_recibo_duplicado() IS
  'Guard de recibos de Stephy. (A) otro cliente => bloquea y audita. (B) Fase 4.1: mismo cliente con tracking_master distinto => solo audita (accion=avisado).';

-- El trigger no cambia (BEFORE INSERT OR UPDATE OF tracking_master_courier);
-- se recrea solo si no existiera.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'shipping_groups' AND t.tgname = 'guard_recibo_duplicado'
  ) THEN
    CREATE TRIGGER guard_recibo_duplicado
      BEFORE INSERT OR UPDATE OF tracking_master_courier ON public.shipping_groups
      FOR EACH ROW EXECUTE FUNCTION public.trg_guard_recibo_duplicado();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Verificación (no escribe nada)
-- ---------------------------------------------------------------------------
-- 3.a) El normalizador hace lo suyo: los tres primeros deben dar TRUE
--      (mismo envío) y el último FALSE (envíos distintos de verdad).
SELECT
  position(public.norm_tracking_master('517967985475')
           IN public.norm_tracking_master('9622001900005890833200517967985475')) > 0
    AS prefijo_courier_es_el_mismo_envio,
  position(public.norm_tracking_master('9361289677063201119748')
           IN public.norm_tracking_master('C1420331269361289677063201119748')) > 0
    AS prefijo_c14_es_el_mismo_envio,
  public.norm_tracking_master('') IS NULL
    AS vacio_es_null,
  position(public.norm_tracking_master('GFUS01041890819392')
           IN public.norm_tracking_master('GFUS01041890863680')) = 0
    AS gfus_distintos_si_avisan;

-- 3.b) Lo que la rama (B) habría avisado con los datos de hoy.
--      Al 2026-08-03 son 3 filas — recibos 325920 (venta 6438), 326092 (7170) y
--      326250 (6815). Los tres son de la era 3xxxxx, anteriores a este bot; los
--      dos de ruido por prefijo de courier (442482, 442495) quedan fuera gracias
--      a `norm_tracking_master`, que era el punto.
WITH g AS (
  SELECT sg.tracking_master_courier AS recibo, sg.id_grupo, sg.id_venta,
         public.norm_tracking_master(sg.tracking_master) AS tm, v.user_id
  FROM public.shipping_groups sg
  JOIN public.venta v ON v.id_venta = sg.id_venta
  WHERE sg.tracking_master_courier ~ '^[0-9]{5,7}$'
)
SELECT a.recibo, a.user_id, count(*) AS grupos, count(DISTINCT a.tm) AS masters
FROM g a
JOIN g b ON b.recibo = a.recibo
        AND b.id_grupo <> a.id_grupo
        AND b.user_id IS NOT DISTINCT FROM a.user_id
        AND a.tm IS NOT NULL AND b.tm IS NOT NULL
        AND position(b.tm IN a.tm) = 0
        AND position(a.tm IN b.tm) = 0
GROUP BY a.recibo, a.user_id
ORDER BY a.recibo;
