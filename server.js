"use strict";
/* Servidor de la guía: API + archivos estáticos. Base de datos: PostgreSQL (compatible con Neon). */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

// Carga mínima de .env para desarrollo local (en el hosting se usan variables de entorno reales)
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch (e) { /* sin .env */ }

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const MODULOS = 11, NOTA_MAX = 20;

const ADMIN_USER = process.env.ADMIN_USER || (PROD ? "" : "admin");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (PROD ? "" : "admin123");
const SESSION_SECRET = process.env.SESSION_SECRET || (PROD ? "" : "secreto-solo-desarrollo");
const FALTAN = PROD ? ["DATABASE_URL", "ADMIN_USER", "ADMIN_PASSWORD", "SESSION_SECRET"].filter(k => !process.env[k]) : [];
if (FALTAN.length && require.main === module) {
  console.error("Faltan variables de entorno: " + FALTAN.join(", ") + ". Son obligatorias en producción.");
  process.exit(1);
}

/* ---------- Base de datos ---------- */
let pool, modoMemoria = false;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  // En Vercel cada instancia atiende pocas peticiones: una conexión basta (Neon ya hace el pooling con -pooler)
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: process.env.VERCEL ? 1 : 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
} else {
  const { newDb } = require("pg-mem"); // solo desarrollo: base en memoria, se borra al reiniciar
  const mem = newDb();
  // pg-mem implementa pocas funciones nativas; se registran las que usa schema.sql (en PostgreSQL/Neon ya existen)
  mem.public.registerFunction({ name: "btrim", args: ["text"], returns: "text", implementation: s => String(s).trim() });
  mem.public.registerFunction({ name: "char_length", args: ["text"], returns: "integer", implementation: s => String(s).length });
  pool = new (mem.adapters.createPg().Pool)();
  modoMemoria = true;
  console.warn("AVISO: sin DATABASE_URL. Usando una base en memoria (los datos se pierden al reiniciar).");
}
const q = (text, params) => pool.query(text, params);
async function tx(fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
  catch (e) { try { await c.query("ROLLBACK"); } catch (_) {} throw e; }
  finally { c.release(); }
}
async function initDb() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  for (const stmt of sql.replace(/--.*$/gm, "").split(";").map(s => s.trim()).filter(Boolean)) await q(stmt);
}
// Prepara la base una sola vez por instancia (en Vercel, en la primera petición tras un arranque en frío)
let listo = null;
const dbLista = () => { if (!listo) listo = initDb().catch(e => { listo = null; throw e; }); return listo; };

/* ---------- Utilidades ---------- */
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const safeEq = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(String(a)).digest(), crypto.createHash("sha256").update(String(b)).digest());
const ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function nuevoCodigo() { const b = crypto.randomBytes(12); let s = ""; for (let i = 0; i < 12; i++) s += ALFABETO[b[i] % ALFABETO.length]; return s.slice(0,4)+"-"+s.slice(4,8)+"-"+s.slice(8,12); }
const normCodigo = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashCodigo = c => sha256("equipo:" + normCodigo(c));
const limpio = s => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const ipDe = req => String(req.ip || req.socket.remoteAddress || "").slice(0, 60);
class HttpError extends Error { constructor(status, mensaje, campos) { super(mensaje); this.status = status; this.campos = campos; } }

// Límite sencillo de peticiones por IP (en memoria)
const cubos = new Map();
function limite(nombre, max, ventanaMs) {
  return (req, res, next) => {
    const k = nombre + ":" + ipDe(req), ahora = Date.now(); let c = cubos.get(k);
    if (!c || c.hasta < ahora) c = { n: 0, hasta: ahora + ventanaMs };
    c.n++; cubos.set(k, c);
    if (c.n > max) return next(new HttpError(429, "Demasiadas solicitudes. Intenta más tarde."));
    next();
  };
}
setInterval(() => { const t = Date.now(); for (const [k, v] of cubos) if (v.hasta < t) cubos.delete(k); }, 60000).unref();

/* ---------- Validaciones ---------- */
function validarEquipo(b) {
  const campos = {}; b = b || {};
  const proyecto = limpio(b.proyecto);
  if (proyecto.length < 3 || proyecto.length > 80) campos.proyecto = "El nombre del proyecto debe tener entre 3 y 80 caracteres.";
  const lista = Array.isArray(b.integrantes) ? b.integrantes.map(limpio).filter(Boolean) : [];
  if (lista.length < 1) campos.integrantes = "Registra al menos un integrante.";
  else if (lista.length > 5) campos.integrantes = "El máximo es de 5 integrantes.";
  else if (lista.some(n => n.length < 3 || n.length > 60)) campos.integrantes = "Cada nombre debe tener entre 3 y 60 caracteres.";
  else if (new Set(lista.map(n => n.toLowerCase())).size !== lista.length) campos.integrantes = "Hay nombres repetidos.";
  if (Object.keys(campos).length) throw new HttpError(400, "Revisa los datos del equipo.", campos);
  return { proyecto, integrantes: lista };
}
function validarAutoeval(b) {
  const campos = {}; b = b || {};
  const mods = Array.isArray(b.modulos) ? b.modulos : [];
  const out = [], vistos = new Set();
  for (const m of mods) {
    const modulo = Number(m && m.modulo), nota = Number(m && m.nota), avance = Math.round(Number(m && m.avance));
    if (!Number.isInteger(modulo) || modulo < 1 || modulo > MODULOS || vistos.has(modulo)) { campos.modulos = "Módulo inválido o repetido."; break; }
    vistos.add(modulo);
    if (m.nota === "" || m.nota === null || !Number.isFinite(nota) || nota < 0 || nota > NOTA_MAX) { campos["m" + modulo] = "La nota debe estar entre 0 y " + NOTA_MAX + "."; continue; }
    if (!Number.isFinite(avance) || avance < 0 || avance > 100) { campos["m" + modulo] = "Avance inválido."; continue; }
    const comentario = limpio(m.comentario);
    if (comentario.length > 500) { campos["m" + modulo] = "El comentario admite hasta 500 caracteres."; continue; }
    out.push({ modulo, nota: Math.round(nota * 100) / 100, avance, comentario });
  }
  if (!campos.modulos && vistos.size !== MODULOS) campos.modulos = "Debes calificar los " + MODULOS + " módulos.";
  const general = limpio(b.comentarioGeneral);
  if (general.length > 1000) campos.comentarioGeneral = "El comentario general admite hasta 1000 caracteres.";
  if (Object.keys(campos).length) throw new HttpError(400, "Revisa la autoevaluación.", campos);
  return { modulos: out, general };
}

/* ---------- Sesión del administrador (cookie firmada) ---------- */
const COOKIE = "sid", DURACION_MS = 8 * 3600 * 1000;
const firmar = p => crypto.createHmac("sha256", SESSION_SECRET).update(p).digest("base64url");
function emitirSesion(res, req, usuario) {
  const p = Buffer.from(JSON.stringify({ u: usuario, exp: Date.now() + DURACION_MS })).toString("base64url");
  const seguro = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", COOKIE + "=" + p + "." + firmar(p) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + DURACION_MS / 1000 + seguro);
}
function leerSesion(req) {
  const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + COOKIE + "=([^;]+)"));
  if (!m) return null; const [p, f] = m[1].split("."); if (!p || !f) return null;
  try { if (!safeEq(f, firmar(p))) return null; const d = JSON.parse(Buffer.from(p, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch (e) { return null; }
}
const soloAdmin = (req, res, next) => { const s = leerSesion(req); if (!s) return next(new HttpError(401, "Inicia sesión como administrador.")); req.admin = s.u; next(); };
async function bitacora(usuario, accion, detalle, resultado, req) {
  try { await q("INSERT INTO bitacora (usuario, accion, detalle, resultado, ip) VALUES ($1,$2,$3,$4,$5)", [String(usuario).slice(0, 60), accion, String(detalle || "").slice(0, 200), resultado, ipDe(req)]); }
  catch (e) { console.error("No se pudo escribir la bitácora:", e.message); }
}
// Intentos fallidos desde esta IP en los últimos 15 minutos y después del último acceso correcto (se lee de la bitácora,
// así el bloqueo funciona aunque haya varias instancias serverless)
async function intentosFallidos(ip) {
  const desde = new Date(Date.now() - 15 * 60000);
  const ok = await q("SELECT max(fecha) AS f FROM bitacora WHERE accion = 'login' AND resultado = 'exito' AND ip = $1", [ip]);
  const tras = ok.rows[0].f && new Date(ok.rows[0].f) > desde ? new Date(ok.rows[0].f) : desde;
  const r = await q("SELECT count(*) AS n FROM bitacora WHERE accion = 'login' AND resultado = 'fallido' AND ip = $1 AND fecha > $2", [ip, tras]);
  return Number(r.rows[0].n);
}

/* ---------- App ---------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  next();
});
app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const a = fn => (req, res, next) => fn(req, res).catch(next);
app.use("/api", (req, res, next) => {
  if (FALTAN.length) return next(new HttpError(500, "Configuración incompleta: faltan las variables de entorno " + FALTAN.join(", ") + "."));
  dbLista().then(() => next(), next);
});
async function equipoDe(req) {
  const cod = normCodigo(req.headers["x-codigo"]);
  if (cod.length !== 12) throw new HttpError(401, "Código de equipo inválido.");
  const r = await q("SELECT id, proyecto, creado_en, actualizado_en FROM equipos WHERE codigo_hash = $1", [hashCodigo(cod)]);
  if (!r.rows.length) throw new HttpError(401, "Código de equipo inválido.");
  return r.rows[0];
}
async function cargarEquipo(eq) {
  const ints = await q("SELECT nombre FROM integrantes WHERE equipo_id = $1 ORDER BY posicion", [eq.id]);
  const ae = await q("SELECT comentario_general, enviado_en FROM autoevaluaciones WHERE equipo_id = $1", [eq.id]);
  let autoevaluacion = null;
  if (ae.rows.length) {
    const ms = await q("SELECT modulo, nota, avance, comentario FROM autoevaluacion_modulos WHERE equipo_id = $1 ORDER BY modulo", [eq.id]);
    autoevaluacion = { comentarioGeneral: ae.rows[0].comentario_general, enviadoEn: ae.rows[0].enviado_en, modulos: ms.rows.map(m => ({ modulo: m.modulo, nota: Number(m.nota), avance: m.avance, comentario: m.comentario })) };
  }
  return { equipo: { proyecto: eq.proyecto, integrantes: ints.rows.map(r => r.nombre), actualizadoEn: eq.actualizado_en }, autoevaluacion };
}

app.get("/api/salud", a(async (req, res) => { await q("SELECT 1"); res.json({ ok: true, notaMax: NOTA_MAX, modulos: MODULOS }); }));

app.post("/api/equipos", limite("crear", 20, 3600000), a(async (req, res) => {
  const d = validarEquipo(req.body), codigo = nuevoCodigo(), id = crypto.randomUUID();
  await tx(async c => {
    await c.query("INSERT INTO equipos (id, codigo_hash, proyecto) VALUES ($1,$2,$3)", [id, hashCodigo(codigo), d.proyecto]);
    for (let i = 0; i < d.integrantes.length; i++) await c.query("INSERT INTO integrantes (equipo_id, posicion, nombre) VALUES ($1,$2,$3)", [id, i + 1, d.integrantes[i]]);
  });
  res.status(201).json({ codigo, equipo: { proyecto: d.proyecto, integrantes: d.integrantes } });
}));
app.get("/api/equipo", limite("codigo", 60, 600000), a(async (req, res) => res.json(await cargarEquipo(await equipoDe(req)))));
app.put("/api/equipo", a(async (req, res) => {
  const eq = await equipoDe(req), d = validarEquipo(req.body);
  await tx(async c => {
    await c.query("UPDATE equipos SET proyecto = $1, actualizado_en = now() WHERE id = $2", [d.proyecto, eq.id]);
    await c.query("DELETE FROM integrantes WHERE equipo_id = $1", [eq.id]);
    for (let i = 0; i < d.integrantes.length; i++) await c.query("INSERT INTO integrantes (equipo_id, posicion, nombre) VALUES ($1,$2,$3)", [eq.id, i + 1, d.integrantes[i]]);
  });
  res.json({ equipo: { proyecto: d.proyecto, integrantes: d.integrantes } });
}));
app.put("/api/autoevaluacion", a(async (req, res) => {
  const eq = await equipoDe(req), d = validarAutoeval(req.body);
  await tx(async c => {
    await c.query("DELETE FROM autoevaluaciones WHERE equipo_id = $1", [eq.id]);
    await c.query("INSERT INTO autoevaluaciones (equipo_id, comentario_general) VALUES ($1,$2)", [eq.id, d.general]);
    for (const m of d.modulos) await c.query("INSERT INTO autoevaluacion_modulos (equipo_id, modulo, nota, avance, comentario) VALUES ($1,$2,$3,$4,$5)", [eq.id, m.modulo, m.nota, m.avance, m.comentario]);
  });
  const r = await q("SELECT enviado_en FROM autoevaluaciones WHERE equipo_id = $1", [eq.id]);
  res.json({ ok: true, enviadoEn: r.rows[0].enviado_en });
}));

/* --- Administrador --- */
app.post("/api/admin/login", a(async (req, res) => {
  const ip = ipDe(req);
  if (await intentosFallidos(ip) >= 5) throw new HttpError(429, "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
  const u = limpio(req.body && req.body.usuario), p = String((req.body && req.body.clave) || "");
  const ok = safeEq(u, ADMIN_USER) & safeEq(p, ADMIN_PASSWORD); // ambas comparaciones siempre se ejecutan
  if (!ok) {
    await bitacora(u || "(vacío)", "login", "", "fallido", req);
    await new Promise(r => setTimeout(r, 400));
    throw new HttpError(401, "Usuario o contraseña incorrectos.");
  }
  emitirSesion(res, req, ADMIN_USER);
  await bitacora(ADMIN_USER, "login", "", "exito", req);
  res.json({ ok: true, usuario: ADMIN_USER });
}));
app.post("/api/admin/logout", a(async (req, res) => {
  const s = leerSesion(req); if (s) await bitacora(s.u, "logout", "", "exito", req);
  res.setHeader("Set-Cookie", COOKIE + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"); res.json({ ok: true });
}));
app.get("/api/admin/yo", (req, res) => { const s = leerSesion(req); res.json({ admin: !!s, usuario: s ? s.u : null }); });

async function listarEquipos() {
  const eqs = (await q("SELECT e.id, e.proyecto, e.creado_en, a.comentario_general, a.enviado_en FROM equipos e LEFT JOIN autoevaluaciones a ON a.equipo_id = e.id ORDER BY e.proyecto")).rows;
  const ints = (await q("SELECT equipo_id, nombre FROM integrantes ORDER BY equipo_id, posicion")).rows;
  const mods = (await q("SELECT equipo_id, modulo, nota, avance, comentario FROM autoevaluacion_modulos ORDER BY equipo_id, modulo")).rows;
  return eqs.map(e => {
    const ms = mods.filter(m => m.equipo_id === e.id).map(m => ({ modulo: m.modulo, nota: Number(m.nota), avance: m.avance, comentario: m.comentario }));
    const prom = k => ms.length ? Math.round(ms.reduce((s, m) => s + m[k], 0) / ms.length * 100) / 100 : null;
    return { id: e.id, proyecto: e.proyecto, creadoEn: e.creado_en, integrantes: ints.filter(i => i.equipo_id === e.id).map(i => i.nombre),
      enviado: !!e.enviado_en, enviadoEn: e.enviado_en, comentarioGeneral: e.comentario_general || "", notaPromedio: prom("nota"), avancePromedio: prom("avance"), modulos: ms };
  });
}
app.get("/api/admin/equipos", soloAdmin, a(async (req, res) => res.json({ notaMax: NOTA_MAX, equipos: await listarEquipos() })));
app.delete("/api/admin/equipos/:id", soloAdmin, a(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(400, "Identificador inválido.");
  const r = await q("DELETE FROM equipos WHERE id = $1", [req.params.id]);
  await bitacora(req.admin, "borrar_equipo", req.params.id, r.rowCount ? "exito" : "fallido", req);
  res.json({ ok: true, borrados: r.rowCount });
}));
app.get("/api/admin/equipos.csv", soloAdmin, a(async (req, res) => {
  const c = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const filas = [["Proyecto", "Integrantes", "Enviada", "Fecha de envío", "Nota promedio (0-" + NOTA_MAX + ")", "Avance promedio (%)"].concat(Array.from({ length: MODULOS }, (_, i) => "Nota M" + (i + 1))).concat(["Comentario general"])];
  (await listarEquipos()).forEach(e => filas.push([e.proyecto, e.integrantes.join("; "), e.enviado ? "Sí" : "No", e.enviadoEn ? new Date(e.enviadoEn).toISOString() : "", e.notaPromedio, e.avancePromedio]
    .concat(Array.from({ length: MODULOS }, (_, i) => { const m = e.modulos.find(x => x.modulo === i + 1); return m ? m.nota : ""; })).concat([e.comentarioGeneral])));
  await bitacora(req.admin, "exportar_csv", "", "exito", req);
  res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.setHeader("Content-Disposition", 'attachment; filename="autoevaluaciones.csv"');
  res.send("﻿" + filas.map(f => f.map(c).join(",")).join("\r\n"));
}));

app.use("/api", (req, res, next) => next(new HttpError(404, "Ruta no encontrada.")));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, campos: err.campos });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON inválido." });
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Solicitud demasiado grande." });
  console.error(err); res.status(500).json({ error: "Error interno del servidor." });
});

module.exports = { app, initDb, pool };
if (require.main === module) {
  dbLista().then(() => app.listen(PORT, () => console.log("Servidor en http://localhost:" + PORT + (modoMemoria ? " (base en memoria)" : " (Neon/PostgreSQL)"))))
    .catch(e => { console.error("No se pudo preparar la base de datos:", e.message); process.exit(1); });
}
