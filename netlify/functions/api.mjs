import { getStore } from "@netlify/blobs";

// Contraseña de la página principal (se puede cambiar con la variable ADMIN_PASS en Netlify)
const PASS = process.env.ADMIN_PASS || "1243";

const ABC = "abcdefghijkmnpqrstuvwxyz23456789";
const rid = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => ABC[x % ABC.length]).join("");
const txt = (v, n) => String(v ?? "").trim().slice(0, n);
const MONEDAS = ["EUR", "CHF", "GBP", "USD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "MAD"];
const mon = (v) => (MONEDAS.includes(v) ? v : "EUR");
const out = (data, status = 200) => Response.json(data, { status });

export default async (req) => {
  if (req.method !== "POST") return out({ error: "net" }, 405);
  let b;
  try { b = await req.json(); } catch { return out({ error: "net" }, 400); }
  const s = getStore({ name: "aescote", consistency: "strong" });
  try {
    if (b.token) return await persona(s, b);
    if (String(b.pass ?? "") !== PASS) return out({ error: "pass" }, 401);
    return await admin(s, b);
  } catch (e) {
    if (typeof e === "string") return out({ error: e }, 400);
    console.error(e);
    return out({ error: "net" }, 500);
  }
};

export const config = { path: "/api" };

const leer = (s, id) => (/^[a-z0-9]{1,20}$/.test(id || "") ? s.get("c/" + id, { type: "json" }) : null);
const grabar = (s, c) => s.setJSON("c/" + c.id, c);
const nombre = (c, id) => c.personas.find((p) => p.id === id)?.nombre ?? "?";

function log(c, quien, accion, detalle) {
  c.historial ??= [];
  c.historial.unshift({ fecha: new Date().toISOString(), quien, accion, detalle });
  if (c.historial.length > 1000) c.historial.length = 1000;
}

function desc(c, m) {
  const imp = (m.importe / 100).toFixed(2) + " " + c.moneda;
  return m.tipo === "pago"
    ? `${nombre(c, m.pagador)} → ${nombre(c, m.para)} · ${imp}`
    : `${m.concepto} · ${imp} · ${nombre(c, m.pagador)}`;
}

function limpiar(c, m = {}) {
  const ids = new Set(c.personas.map((p) => p.id));
  const importe = Math.round(Number(m.importe));
  if (!Number.isFinite(importe) || importe <= 0 || importe > 1e10) throw "importe";
  if (!ids.has(m.pagador)) throw "pagador";
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(m.fecha || "") ? m.fecha : new Date().toISOString().slice(0, 10);
  const r = { id: txt(m.id, 20), tipo: m.tipo === "pago" ? "pago" : "gasto", importe, pagador: m.pagador, fecha };
  if (r.tipo === "pago") {
    if (!ids.has(m.para) || m.para === m.pagador) throw "para";
    r.para = m.para;
  } else {
    r.concepto = txt(m.concepto, 80) || "—";
    r.categoria = txt(m.categoria, 20) || "otros";
    r.entre = [...new Set((m.entre || []).filter((x) => ids.has(x)))];
    if (!r.entre.length) throw "entre";
  }
  return r;
}

function upsert(c, m, quien, soloDe) {
  const i = c.movs.findIndex((x) => x.id === m.id);
  if (i >= 0) {
    if (soloDe && c.movs[i].pagador !== soloDe) throw "permiso";
    m.creado = c.movs[i].creado;
    c.movs[i] = m;
    log(c, quien, "edit", desc(c, m));
  } else {
    m.id = rid(10);
    m.creado = new Date().toISOString();
    c.movs.push(m);
    log(c, quien, "add", desc(c, m));
  }
}

function quitar(c, id, quien, soloDe) {
  const m = c.movs.find((x) => x.id === id);
  if (!m) return;
  if (soloDe && m.pagador !== soloDe) throw "permiso";
  log(c, quien, "del", desc(c, m));
  c.movs = c.movs.filter((x) => x !== m);
}

function publica(c, esAdmin) {
  const { historial, ...r } = c;
  r.personas = c.personas.map((p) => (esAdmin ? p : { id: p.id, nombre: p.nombre }));
  if (esAdmin) r.historial = historial || [];
  return r;
}

async function persona(s, b) {
  const tok = String(b.token);
  const c = await leer(s, tok.split("-")[0]);
  const yo = c?.personas.find((p) => p.token === tok);
  if (!yo) return out({ error: "token" }, 404);
  if (b.accion === "guardar") {
    const m = limpiar(c, b.mov);
    if (m.pagador !== yo.id) throw "permiso";
    upsert(c, m, yo.nombre, yo.id);
    await grabar(s, c);
  } else if (b.accion === "borrar") {
    quitar(c, b.id, yo.nombre, yo.id);
    await grabar(s, c);
  }
  return out({ cuenta: publica(c, false), yo: yo.id });
}

async function admin(s, b) {
  const A = "Admin";
  if (b.accion === "lista") {
    const { blobs } = await s.list({ prefix: "c/" });
    const todas = await Promise.all(blobs.map((x) => s.get(x.key, { type: "json" })));
    const cuentas = todas.filter(Boolean).map((c) => ({
      id: c.id, nombre: c.nombre, moneda: c.moneda, creada: c.creada,
      personas: c.personas.length,
      total: c.movs.filter((m) => m.tipo === "gasto").reduce((t, m) => t + m.importe, 0),
    }));
    cuentas.sort((x, y) => (y.creada || "").localeCompare(x.creada || ""));
    return out({ cuentas });
  }
  if (b.accion === "crear") {
    const c = {
      id: rid(8), nombre: txt(b.nombre, 60) || "Cuenta", moneda: mon(b.moneda),
      creada: new Date().toISOString(), personas: [], movs: [], historial: [],
    };
    log(c, A, "acc_new", `${c.nombre} · ${c.moneda}`);
    await grabar(s, c);
    return out({ cuenta: publica(c, true), yo: null });
  }
  const c = await leer(s, b.cuenta);
  if (!c) return out({ error: "cuenta" }, 404);
  switch (b.accion) {
    case "ver":
      return out({ cuenta: publica(c, true), yo: null });
    case "editarCuenta":
      c.nombre = txt(b.nombre, 60) || c.nombre;
      c.moneda = mon(b.moneda);
      log(c, A, "acc_edit", `${c.nombre} · ${c.moneda}`);
      break;
    case "borrarCuenta":
      await s.delete("c/" + c.id);
      return out({ ok: true });
    case "addPersona": {
      const n = txt(b.nombre, 40);
      if (!n) throw "nombre";
      c.personas.push({ id: rid(6), nombre: n, token: c.id + "-" + rid(16) });
      log(c, A, "p_add", n);
      break;
    }
    case "delPersona": {
      const p = c.personas.find((x) => x.id === b.persona);
      if (!p) break;
      if (c.movs.some((m) => m.pagador === p.id || m.para === p.id || m.entre?.includes(p.id))) throw "enuso";
      c.personas = c.personas.filter((x) => x !== p);
      log(c, A, "p_del", p.nombre);
      break;
    }
    case "guardar":
      upsert(c, limpiar(c, b.mov), A);
      break;
    case "borrar":
      quitar(c, b.id, A);
      break;
    default:
      throw "net";
  }
  await grabar(s, c);
  return out({ cuenta: publica(c, true), yo: null });
}
