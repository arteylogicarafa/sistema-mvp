-- Esquema para PostgreSQL / Neon (https://console.neon.tech/)
-- Ejecútalo en el SQL Editor de Neon. El servidor también lo aplica al iniciar (CREATE ... IF NOT EXISTS).

-- Un equipo = un proyecto. El código de acceso del equipo no se guarda: solo su hash SHA-256.
CREATE TABLE IF NOT EXISTS equipos (
  id             uuid         PRIMARY KEY,
  codigo_hash    varchar(64)  NOT NULL UNIQUE,
  proyecto       varchar(80)  NOT NULL CHECK (char_length(btrim(proyecto)) >= 3),
  creado_en      timestamptz  NOT NULL DEFAULT now(),
  actualizado_en timestamptz  NOT NULL DEFAULT now()
);

-- Hasta 5 integrantes por equipo (posición 1 a 5).
CREATE TABLE IF NOT EXISTS integrantes (
  equipo_id uuid         NOT NULL REFERENCES equipos(id) ON DELETE CASCADE,
  posicion  smallint     NOT NULL CHECK (posicion BETWEEN 1 AND 5),
  nombre    varchar(60)  NOT NULL CHECK (char_length(btrim(nombre)) >= 3),
  PRIMARY KEY (equipo_id, posicion)
);

-- Autoevaluación enviada por el equipo (una por equipo; reenviar la reemplaza).
CREATE TABLE IF NOT EXISTS autoevaluaciones (
  equipo_id          uuid          PRIMARY KEY REFERENCES equipos(id) ON DELETE CASCADE,
  comentario_general varchar(1000) NOT NULL DEFAULT '',
  enviado_en         timestamptz   NOT NULL DEFAULT now()
);

-- Calificación (0 a 20) y avance declarado (0 a 100) por cada uno de los 11 módulos.
CREATE TABLE IF NOT EXISTS autoevaluacion_modulos (
  equipo_id  uuid          NOT NULL REFERENCES autoevaluaciones(equipo_id) ON DELETE CASCADE,
  modulo     smallint      NOT NULL CHECK (modulo BETWEEN 1 AND 11),
  nota       numeric(4,2)  NOT NULL CHECK (nota >= 0 AND nota <= 20),
  avance     smallint      NOT NULL CHECK (avance BETWEEN 0 AND 100),
  comentario varchar(500)  NOT NULL DEFAULT '',
  PRIMARY KEY (equipo_id, modulo)
);

-- Bitácora de acciones del administrador (inicios de sesión, borrados, exportaciones).
CREATE TABLE IF NOT EXISTS bitacora (
  id        bigserial    PRIMARY KEY,
  usuario   varchar(60)  NOT NULL,
  accion    varchar(40)  NOT NULL,
  detalle   varchar(200) NOT NULL DEFAULT '',
  resultado varchar(10)  NOT NULL CHECK (resultado IN ('exito', 'fallido')),
  ip        varchar(60)  NOT NULL DEFAULT '',
  fecha     timestamptz  NOT NULL DEFAULT now()
);
