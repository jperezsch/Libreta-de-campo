/* Libreta de Campo · módulo del mapa sin conexión (opcional).
   Solo se carga si el mapa está activado en Config. Se conecta con la app mediante el objeto LC (ver el "puente" al final de index.html).
   Pila: MapLibre GL JS 5.24 + PMTiles + maplibre-contour. Archivos en OPFS (subcarpeta propia) o IndexedDB. */
(function () {
"use strict";

var PARAMS = new URLSearchParams(location.search);
var FORZAR_IDB = PARAMS.get("idb") === "1";
var RUTA_MAPA = "mapa/";   /* carpeta de apoyo, relativa a la página */
var DIR = "libretacampo_mapas";   /* subcarpeta de OPFS: no se mezcla con otros archivos del mismo dominio */
var LS_IDX = "libretacampo_mapa_instalados_v1", LS_CAT = "libretacampo_mapa_catalogo_v1", LS_ACTUAL = "libretacampo_mapa_actual_v1", LS_CAPAS = "libretacampo_mapa_capas_v1", LS_PRECARGA = "libretacampo_mapa_precarga_v1", LS_CAPAS_LOC = "libretacampo_mapa_capas_locales_v1";
var LISTO = typeof maplibregl !== "undefined" && typeof pmtiles !== "undefined" && typeof mlcontour !== "undefined";

var LC = null;
function $(id) { return document.getElementById(id); }
function leerJSON(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function guardarJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function mb(b) { return (b / 1048576).toFixed(b < 10485760 ? 2 : 1) + " MB"; }
function el(tag, attrs, hijos) {
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (attrs[k] == null) continue;
    if (k === "texto") n.textContent = attrs[k];
    else if (k === "onclick") n.onclick = attrs[k];
    else if (k === "class") n.className = attrs[k];
    else n.setAttribute(k, attrs[k]);
  }
  (hijos || []).forEach(function (h) { if (h) n.appendChild(h); });
  return n;
}
function fechaHM(d) {
  d = d || new Date();
  function p(x) { return (x < 10 ? "0" : "") + x; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- errores y métricas (para el informe) ---------- */
var errores = [];
function anotarError(origen, e) {
  var m = origen + ": " + (e && e.message ? e.message : String(e));
  if (errores.length < 25) errores.push(fechaHM() + " " + m);
  if (window.console) console.warn("[mapa] " + m);
}
var metricas = { descargas: [], aperturaMs: null, fluidez: null, gpsUltimo: null };
var tiemposCurvas = [];

function cancelarLector(reader) { try { var pc = reader.cancel(); if (pc && pc.catch) pc.catch(function () {}); } catch (_) {} }

/* ---------- almacenamiento de archivos ---------- */
var pmCache = {};
var Alm = (function () {
  var opfs = !FORZAR_IDB && !!(navigator.storage && navigator.storage.getDirectory &&
    typeof FileSystemFileHandle !== "undefined" && FileSystemFileHandle.prototype.createWritable);
  var dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r = indexedDB.open("libretacampo_mapas_db", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("a"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function idbOp(modo, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("a", modo), st = tx.objectStore("a"), rq = fn(st);
        tx.oncomplete = function () { res(rq && rq.result); };
        tx.onerror = tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); }
  return {
    modo: function () { return opfs ? "OPFS" : "IndexedDB (respaldo)"; },
    guardar: async function (nombre, blob) {
      if (opfs) {
        var fh = await (await dir()).getFileHandle(nombre, { create: true });
        var w = await fh.createWritable();
        try { await w.write(blob); await w.close(); } catch (e) { try { await w.abort(); } catch (_) {} throw e; }
      } else await idbOp("readwrite", function (s) { return s.put(blob, nombre); });
    },
    leer: async function (nombre) {
      if (opfs) {
        try { return await (await (await dir()).getFileHandle(nombre)).getFile(); }
        catch (e) { if (e.name === "NotFoundError") return null; throw e; }
      }
      return (await idbOp("readonly", function (s) { return s.get(nombre); })) || null;
    },
    borrar: async function (nombre) {
      delete pmCache[nombre];
      if (opfs) { try { await (await dir()).removeEntry(nombre); } catch (e) { if (e.name !== "NotFoundError") anotarError("borrar " + nombre, e); } }
      else await idbOp("readwrite", function (s) { return s.delete(nombre); });
    },
    listar: async function () {
      var out = [];
      if (opfs) { var d = await dir(); for await (var par of d.entries()) if (par[1].kind === "file") out.push(par[0]); }
      else out = (await idbOp("readonly", function (s) { return s.getAllKeys(); })) || [];
      return out;
    },
    /* Descarga en flujo. No toca un archivo ya instalado hasta saber que el nuevo está completo: si algo falla, lo anterior queda intacto. */
    descargar: async function (url, nombre, bytesEsperados, onBytes, signal, validar) {
      var resp = await fetch(url, { signal: signal, cache: "no-store" });
      if (!resp.ok) throw new Error("El servidor respondió " + resp.status);
      if (!resp.body) throw new Error("El navegador no entrega la descarga por partes");
      var existia = !!(await this.leer(nombre));
      var reader = resp.body.getReader(), recibido = 0, cab = [], revisarCab = validar !== "ninguna";
      function revisarMagia(trozo) {
        if (!revisarCab) return;
        for (var i = 0; i < trozo.length && cab.length < 7; i++) cab.push(trozo[i]);
        if (cab.length >= 7) { revisarCab = false; if (String.fromCharCode.apply(null, cab) !== "PMTiles") throw new Error("El archivo no es un paquete PMTiles válido"); }
      }
      function verificarTamano() { if (bytesEsperados && recibido !== bytesEsperados) throw new Error("Tamaño recibido " + recibido + " distinto del esperado " + bytesEsperados); }
      if (opfs) {
        var fh = await (await dir()).getFileHandle(nombre, { create: true });
        var w = await fh.createWritable(), cerrado = false;
        try {
          for (;;) {
            var r = await reader.read();
            if (r.done) break;
            revisarMagia(r.value);
            await w.write(r.value); recibido += r.value.length; onBytes(r.value.length);
          }
          if (recibido < 7 && validar !== "ninguna") throw new Error("El archivo no es un paquete PMTiles válido");
          verificarTamano();
          await w.close(); cerrado = true;
        } catch (e) {
          cancelarLector(reader);
          if (!cerrado) { try { await w.abort(); } catch (_) {} }
          if (!existia) await this.borrar(nombre);   /* si ya existía, el abort descarta lo escrito y el archivo anterior sigue igual */
          throw e;
        }
      } else {
        var trozos = [];
        try {
          for (;;) {
            var r2 = await reader.read();
            if (r2.done) break;
            revisarMagia(r2.value);
            trozos.push(r2.value); recibido += r2.value.length; onBytes(r2.value.length);
          }
          if (recibido < 7 && validar !== "ninguna") throw new Error("El archivo no es un paquete PMTiles válido");
          verificarTamano();
        } catch (e) { cancelarLector(reader); throw e; }
        await idbOp("readwrite", function (st) { return st.put(new Blob(trozos, { type: "application/octet-stream" }), nombre); });
      }
      if (!(await this.leer(nombre))) throw new Error("El archivo no quedó guardado");
      return recibido;
    }
  };
})();

/* ---------- lectura de paquetes ---------- */
function BlobSource(blob, key) { this.blob = blob; this.key = key; }
BlobSource.prototype.getKey = function () { return this.key; };
BlobSource.prototype.getBytes = function (offset, length) {
  return this.blob.slice(offset, offset + length).arrayBuffer().then(function (b) { return { data: b }; });
};
async function abrirPM(nombre) {
  if (!pmCache[nombre]) {
    var b = await Alm.leer(nombre);
    if (!b) throw new Error("Paquete no instalado: " + nombre);
    pmCache[nombre] = new pmtiles.PMTiles(new BlobSource(b, nombre));
  }
  return pmCache[nombre];
}
async function bytesTesela(nombre, z, x, y) {
  var r = await (await abrirPM(nombre)).getZxy(z, x, y);
  return r ? r.data : null;
}

var relieveNombres = [], demSource = null;   /* v2.47: paquetes de relieve de todos los mapas instalados: [{nombre, area}] */
function bboxTesela(z, x, y) {
  var n = Math.pow(2, z);
  function lat(yy) { var r = Math.PI - 2 * Math.PI * yy / n; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(r) - Math.exp(-r))); }
  return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)];
}
function relievesParaTesela(z, x, y) {
  var b = bboxTesela(z, x, y);
  return relieveNombres.filter(function (r) { var a = r.area; return !a || !(b[2] < a[0] || b[0] > a[2] || b[3] < a[1] || b[1] > a[3]); }).map(function (r) { return r.nombre; });
}
function nuevoManagerDem() {
  demSource.manager = new mlcontour.LocalDemManager({
    demUrlPattern: "lcdem://{z}/{x}/{y}", cacheSize: 128, encoding: "terrarium", maxzoom: 12, timeoutMs: 20000,
    getTile: async function (url) {
      var m = /(\d+)\/(\d+)\/(\d+)$/.exec(url);
      if (!m || !relieveNombres.length) throw new Error("sin relieve");
      var cand = relievesParaTesela(+m[1], +m[2], +m[3]), d = null;
      for (var q = 0; q < cand.length && !d; q++) d = await bytesTesela(cand[q], +m[1], +m[2], +m[3]);
      if (!d) throw new Error("tesela de relieve fuera del área");
      return { data: new Blob([d], { type: "image/webp" }), expires: undefined, cacheControl: undefined };
    }
  });
}
if (LISTO) {
  maplibregl.addProtocol("lcmap", async function (params) {
    var m = /^lcmap:\/\/([^\/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error("URL de mapa inválida");
    var d = await bytesTesela(m[1], +m[2], +m[3], +m[4]);
    return { data: d || new ArrayBuffer(0) };
  });
  demSource = new mlcontour.DemSource({ url: "lcdem://{z}/{x}/{y}", id: "lcdem", encoding: "terrarium", maxzoom: 12, worker: false });
  nuevoManagerDem();
  demSource.setupMaplibre(maplibregl);
  demSource.onTiming(function (t) {
    if (!t || t.error || !/contour/.test(t.url || "") || t.process == null) return;
    tiemposCurvas.push({ dur: t.duration, proc: t.process, dec: t.decode || 0 });
    if (tiemposCurvas.length > 200) tiemposCurvas.shift();
  });
}

/* ---------- estado del módulo ---------- */
var inst = leerJSON(LS_IDX, {});        /* id -> {id,nombre,region,version,area,archivos:[{tipo,nombre,bytes}],fecha} */
var cat = null, catInfo = "";
var desc = null;                         /* descarga en curso */
try { localStorage.removeItem(LS_ACTUAL); } catch (e) {}   /* v2.47: ya no hay "mapa en uso": se muestran todos los mapas instalados */
var estiloFirma = undefined;             /* v2.47: firma de los mapas instalados cuyo estilo está aplicado ("" = fondo liso) */
var pendienteEnfoque = null;             /* v2.47: id del mapa al que ir en cuanto se muestre la pestaña Mapa */
var opcionesCapaAbierta = null;          /* v2.93: capa con el panel «Más» abierto */
var mapaImportId = null;                 /* v2.47: mapa elegido en Capas para importar una capa */
var ultimaSesionVista = null;
var capasVis = leerJSON(LS_CAPAS, { sombra: true, curvas: true, anteriores: true });
var online = navigator.onLine !== false;
var map = null, mapaListo = false, ESTILO_BASE = [], estiloPromesa = null;
/* v2.55: el punto de posición en vivo se enciende solo al abrir el mapa; solo queda apagado si lo apagas tú con el chip GPS (se recuerda) */
var LS_GPS_APAGADO = "libretacampo_mapa_gps_apagado_v1";
var gps = { watch: null, fix: null, primera: true, quiere: false, apagadoManual: leerJSON(LS_GPS_APAGADO, false) === true };
var rumbo = { activo: false, h: null, ultimo: 0, libre: 0, sensor: false, recibido: false };   /* v2.44: modo "rumbo arriba" (el mapa gira según hacia dónde apuntas) */
var panelAbiertos = {};   /* v2.44: sesiones desplegadas en "Mis puntos" */
var grab = { rc: null, watch: null, timer: null, wake: null, sucio: false, ultimoGuardado: 0, ultimoLat: null, bloq: false, bqTimer: null, ultimoFixTs: 0, ultimaAcc: null, rearmadoTs: 0, rearmados: 0, ocultoTs: null, cortarSig: false, salidas: 0 };   /* v2.45: recorrido que se está grabando */
/* v2.52: grabación más frecuente (punto cada 2 m o cada 10 s) y vigilancia de señal perdida */
var GRAB_ACC_MAX = 50, GRAB_DIST_MIN = 2, GRAB_T_MAX = 10000, GRAB_CORTE_T = 40000, GRAB_CORTE_D = 50, GRAB_WATCHDOG_T = 20000, GRAB_GUARDAR_T = 5000, BLOQ_HOLD_MS = 3000;
var almEst = { usado: null, cuota: null, protegido: null };
var bateria = "";

function nombreDeUrl(u) { return decodeURIComponent(new URL(u, location.href).pathname.split("/").pop()); }
function archivosDe(e) { return (e.archivos || []).filter(function (a) { return a.tipo === "base" || a.tipo === "relieve"; }); }
function capasDe(e) { return ((e && e.capas) || []).filter(function (c) { return c && c.id && c.url && /^(geojson|gpx|shapefile_zip|shapefile)$/.test(c.tipo || "geojson"); }); }
function capaInstalada(m, c) { return !!(m && (m.capas || []).some(function (x) { return x.id === c.id && repararDir(x.url) === c.url; })); }
function capasPendientes(e) { var m = inst[e.id]; return m ? capasDe(e).filter(function (c) { return !capaInstalada(m, c); }) : capasDe(e); }
function totalBytes(e) { return archivosDe(e).concat(capasDe(e)).reduce(function (s, a) { return s + (a.bytes || 0); }, 0); }
function archivoTipo(m, tipo) { var a = (m.archivos || []).filter(function (x) { return x.tipo === tipo; })[0]; return a ? a.nombre : null; }
function nombreCorto(n) { return String(n || "").replace(/\s*\(SINTETICO.*$/, ""); }
function entradaCatalogo(id) { return cat ? (cat.mapas.filter(function (m) { return m.id === id; })[0] || null) : null; }
function sesionesQueUsan(id) { return LC.state.sesiones.filter(function (s) { return s.mapaId === id; }).length; }

/* ---------- capas: estaciones, tracks y límites ---------- */
var capasCache = {}, capasLoc = leerJSON(LS_CAPAS_LOC, []), capasActuales = [], shpPromesa = null;
var COL_CAT = "#6a1b9a", COL_LOC = "#e65100";
/* v2.77: estilo editable de las capas importadas (color, forma, tamaño y etiquetas) */
var ESTILO_COLORES = ["#e65100", "#c62828", "#6a1b9a", "#1565c0", "#00838f", "#2e7d32", "#f9a825", "#37474f"];
var ESTILO_FORMAS = { rombo: "◆ Rombo", circulo: "● Círculo", cuadrado: "■ Cuadrado", triangulo: "▲ Triángulo" };
var ESTILO_TAMS = { 0.4: "Pequeño", 0.55: "Mediano", 0.8: "Grande" };
function estiloDe(c) { var e = (c && c.estilo) || {}; return { color: e.color || COL_LOC, forma: e.forma || "rombo", tam: e.tam || 0.55, etq: e.etq !== false }; }
var estiloAbierto = null, ayudaCsvAbierta = false;
function sinTildes(t) { return String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function normClave(k) { return sinTildes(k).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }
function normProps(p) {
  var o = {};
  if (p && typeof p === "object") Object.keys(p).forEach(function (k) {
    var v = p[k]; if (v === null || v === undefined || typeof v === "object") return;
    o[normClave(k)] = v;
  });
  if (o.name !== undefined && o.nombre === undefined) o.nombre = o.name;
  if (o.descripcio !== undefined && o.descripcion === undefined) o.descripcion = o.descripcio;   /* el shapefile corta los nombres a 10 letras */
  ["nombre", "estacion", "descripcion", "localidad_especifica", "localidad"].forEach(function (k) { if (o[k] !== undefined) o[k] = String(o[k]); });
  return o;
}
function familiaGeom(t) { return /Point/.test(t) ? "puntos" : /LineString/.test(t) ? "lineas" : /Polygon/.test(t) ? "poligonos" : null; }
function recorrerCoords(c, f) { if (typeof c[0] === "number") { f(c); return; } for (var i = 0; i < c.length; i++) recorrerCoords(c[i], f); }
function normalizarFC(j) {
  var feats = [], bbox = [180, 90, -180, -90], cuenta = { puntos: 0, lineas: 0, poligonos: 0 };
  function add(g, props) {
    if (!g) return;
    if (g.type === "GeometryCollection") { (g.geometries || []).forEach(function (x) { add(x, props); }); return; }
    var fam = familiaGeom(g.type || "");
    if (!fam || !g.coordinates) throw new Error("Geometría no admitida: " + g.type);
    recorrerCoords(g.coordinates, function (c) {
      var lo = c[0], la = c[1];
      if (!isFinite(lo) || !isFinite(la) || Math.abs(lo) > 180 || Math.abs(la) > 90) throw new Error("Coordenadas fuera de rango (deben estar en grados, EPSG:4326)");
      if (lo < bbox[0]) bbox[0] = lo; if (la < bbox[1]) bbox[1] = la; if (lo > bbox[2]) bbox[2] = lo; if (la > bbox[3]) bbox[3] = la;
    });
    cuenta[fam]++;
    feats.push({ type: "Feature", properties: props, geometry: { type: g.type, coordinates: g.coordinates } });
  }
  (Array.isArray(j) ? j : [j]).forEach(function (x) {
    if (!x) return;
    if (x.type === "FeatureCollection") (x.features || []).forEach(function (f) { if (f) add(f.geometry, normProps(f.properties)); });
    else if (x.type === "Feature") add(x.geometry, normProps(x.properties));
    else add(x, {});
  });
  if (!feats.length) throw new Error("La capa no tiene elementos");
  return { fc: { type: "FeatureCollection", features: feats }, bbox: bbox, cuenta: cuenta };
}
function gpxAGeoJSON(txt) {
  var doc = new DOMParser().parseFromString(txt, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("El archivo GPX no es válido");
  var feats = [], cada = Array.prototype.forEach, mapa = Array.prototype.map;
  function txtDe(n, tag) { var e = n.getElementsByTagName(tag)[0]; return e && e.textContent ? e.textContent.trim() : ""; }
  function pt(n) { return [parseFloat(n.getAttribute("lon")), parseFloat(n.getAttribute("lat"))]; }
  cada.call(doc.getElementsByTagName("wpt"), function (w) {
    var nombre = txtDe(w, "name");
    feats.push({ type: "Feature", properties: { nombre: nombre, estacion: nombre, descripcion: txtDe(w, "desc") || txtDe(w, "cmt") }, geometry: { type: "Point", coordinates: pt(w) } });
  });
  cada.call(doc.getElementsByTagName("trk"), function (t) {
    var segs = mapa.call(t.getElementsByTagName("trkseg"), function (sg) { return mapa.call(sg.getElementsByTagName("trkpt"), pt); }).filter(function (sg) { return sg.length > 1; });
    if (!segs.length) return;
    feats.push({ type: "Feature", properties: { nombre: txtDe(t, "name") }, geometry: segs.length === 1 ? { type: "LineString", coordinates: segs[0] } : { type: "MultiLineString", coordinates: segs } });
  });
  cada.call(doc.getElementsByTagName("rte"), function (r) {
    var pts = mapa.call(r.getElementsByTagName("rtept"), pt);
    if (pts.length > 1) feats.push({ type: "Feature", properties: { nombre: txtDe(r, "name") }, geometry: { type: "LineString", coordinates: pts } });
  });
  return { type: "FeatureCollection", features: feats };
}
function cargarShp() {
  if (window.shp) return Promise.resolve();
  if (!shpPromesa) shpPromesa = new Promise(function (res, rej) {
    var sc = document.createElement("script"); sc.src = RUTA_MAPA + "vendor/shp.min.js";
    sc.onload = function () { res(); };
    sc.onerror = function () { shpPromesa = null; rej(new Error("No se pudo cargar el lector de shapefile")); };
    document.head.appendChild(sc);
  });
  return shpPromesa;
}
/* v2.77: planilla CSV (nombre, latitud, longitud y columnas opcionales) convertida en puntos */
var csvOmitidas = 0;
function csvFilas(txt) {
  txt = String(txt).replace(/^\uFEFF/, "");
  var linea1 = txt.split(/\r?\n/)[0] || "", sep = ",", mejor = -1;
  [",", ";", "\t"].forEach(function (c) { var n = linea1.split(c).length; if (n > mejor) { mejor = n; sep = c; } });
  var filas = [], fila = [], cel = "", q = false;
  for (var i = 0; i < txt.length; i++) {
    var ch = txt[i];
    if (q) { if (ch === '"') { if (txt[i + 1] === '"') { cel += '"'; i++; } else q = false; } else cel += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { fila.push(cel); cel = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && txt[i + 1] === "\n") i++; fila.push(cel); cel = ""; filas.push(fila); fila = []; }
    else cel += ch;
  }
  if (cel !== "" || fila.length) { fila.push(cel); filas.push(fila); }
  return { filas: filas.filter(function (f) { return f.some(function (c) { return String(c).trim() !== ""; }); }), sep: sep };
}
function csvNumero(v) { v = String(v).trim().replace(/\s/g, ""); if (v.indexOf(",") >= 0 && v.indexOf(".") < 0) v = v.replace(",", "."); return v === "" ? NaN : Number(v); }
function csvAGeoJSON(txt) {
  var r = csvFilas(txt); if (r.filas.length < 2) throw new Error("El CSV necesita una fila de encabezados y al menos un punto");
  var enc = r.filas[0].map(normClave);
  function col(alias) { for (var i = 0; i < alias.length; i++) { var k = enc.indexOf(alias[i]); if (k >= 0) return k; } return -1; }
  var iLat = col(["latitud", "lat", "latitude", "y"]), iLon = col(["longitud", "lon", "long", "lng", "longitude", "x"]);
  if (iLat < 0 || iLon < 0) throw new Error("Faltan las columnas de coordenadas. Usa los encabezados latitud y longitud (en grados decimales).");
  var iNom = col(["nombre", "name", "estacion", "station", "codigo", "code", "sitio", "punto", "id"]);
  var feats = []; csvOmitidas = 0;
  r.filas.slice(1).forEach(function (f) {
    var la = csvNumero(f[iLat]), lo = csvNumero(f[iLon]);
    if (!isFinite(la) || !isFinite(lo)) { csvOmitidas++; return; }
    var pr = {};
    enc.forEach(function (k, j) { if (j !== iLat && j !== iLon && k && String(f[j] === undefined ? "" : f[j]).trim() !== "") pr[k] = String(f[j]).trim(); });
    pr = normProps(pr);
    if (iNom >= 0 && pr.nombre === undefined && f[iNom] !== undefined && String(f[iNom]).trim() !== "") pr.nombre = String(f[iNom]).trim();
    feats.push({ type: "Feature", properties: pr, geometry: { type: "Point", coordinates: [lo, la] } });
  });
  if (!feats.length) throw new Error("Ninguna fila tiene coordenadas válidas (revisa latitud y longitud)");
  return { type: "FeatureCollection", features: feats };
}
function tipoPorNombre(n) { n = String(n).toLowerCase(); if (/\.(geo)?json$/.test(n)) return "geojson"; if (/\.gpx$/.test(n)) return "gpx"; if (/\.(csv|tsv|txt)$/.test(n)) return "csv"; if (/\.zip$/.test(n)) return "shapefile_zip"; return null; }
function tipoCapa(t) { return t === "shapefile" ? "shapefile_zip" : (t || "geojson"); }
async function parsearCapa(file, tipo) {
  var j;
  if (tipo === "geojson") j = JSON.parse(await file.text());
  else if (tipo === "gpx") j = gpxAGeoJSON(await file.text());
  else if (tipo === "csv") j = csvAGeoJSON(await file.text());
  else if (tipo === "shapefile_zip") {
    await cargarShp();
    var buf = await file.arrayBuffer(), sinPrj = false;
    try { j = await window.shp(buf); }
    catch (e) {
      /* un .prj en un formato que el lector no entiende: se reintenta sin él, asumiendo grados (WGS 84) */
      try {
        if (typeof JSZip === "undefined") throw e;
        var z = await JSZip.loadAsync(buf);
        Object.keys(z.files).forEach(function (n) { if (/\.prj$/i.test(n)) z.remove(n); });
        j = await window.shp(await z.generateAsync({ type: "arraybuffer" })); sinPrj = true;
      } catch (e2) { throw new Error("No se pudo leer el shapefile. Revisa que el .zip traiga .shp y .dbf (y .prj, idealmente en WGS 84). Detalle: " + String((e && e.message) || e).slice(0, 70)); }
    }
    if (sinPrj) {
      try { return normalizarFC(j); }
      catch (e3) { throw new Error("El shapefile usa un sistema de coordenadas que no se pudo leer. Expórtalo desde QGIS en WGS 84 (EPSG:4326)."); }
    }
  }
  else throw new Error("Formato de capa no admitido: " + tipo);
  return normalizarFC(j);
}
function capasDelMapa(mapaId) {
  var m = inst[mapaId], out = [];
  if (m && m.capas) m.capas.forEach(function (c) { out.push({ clave: "c:" + mapaId + ":" + c.id, id: c.id, mapaId: mapaId, nombre: c.nombre || c.id, origen: "catalogo", archivo: c.archivo, tipo: c.tipo }); });
  capasLoc.filter(function (c) { return c.mapaId === mapaId; }).forEach(function (c) { out.push({ clave: "l:" + c.id, id: c.id, mapaId: mapaId, nombre: c.nombre, origen: "local", archivo: c.archivo, tipo: c.tipo }); });
  return out;
}
function capasLibres() {   /* v2.93: capas guardadas sin asociación a un mapa descargado */
  return capasLoc.filter(function (c) { return !c.mapaId; }).map(function (c) { return { clave: "l:" + c.id, id: c.id, mapaId: "", nombre: c.nombre, origen: "local", archivo: c.archivo, tipo: c.tipo }; });
}
async function cargarCapasMapa() {   /* v2.47: capas de todos los mapas instalados */
  var lista = [], res = [];
  Object.keys(inst).sort().filter(mapaActivo).forEach(function (id) { lista = lista.concat(capasDelMapa(id)); });
  lista = lista.concat(capasLibres());   /* v2.93: capas sin mapa asociado, siempre disponibles */
  for (var i = 0; i < lista.length; i++) {
    var c = lista[i];
    try {
      if (!capasCache[c.archivo]) {
        var f = await Alm.leer(c.archivo); if (!f) throw new Error("archivo ausente");
        capasCache[c.archivo] = await parsearCapa(f, "geojson");
      }
      c.datos = capasCache[c.archivo]; res.push(c);
    } catch (e) { anotarError("capa " + c.nombre, e); }
  }
  capasActuales = res;
  return res;
}
function visCapa(clave) { return !(capasVis.capas && capasVis.capas[clave] === false); }
function clavesVisibles() { return capasActuales.filter(function (c) { return visCapa(c.clave); }).map(function (c) { return c.clave; }); }
function geoCapas() {
  var fs = [];
  capasActuales.forEach(function (c) {
    var ex = { _capa: c.clave, _origen: c.origen };
    if (c.origen === "local") {
      var en = capasLoc.filter(function (x) { return x.id === c.id; })[0], e = estiloDe(en);
      ex._color = e.color; ex._icono = "est-" + e.forma + "-" + e.color.slice(1); ex._tam = e.tam; ex._etq = e.etq ? 1 : 0;
    }
    c.datos.fc.features.forEach(function (f) {
      fs.push({ type: "Feature", properties: Object.assign({}, f.properties, ex), geometry: f.geometry });
    });
  });
  return { type: "FeatureCollection", features: fs };
}
var TIPOS_CAPA = { "capas-pol-relleno": ["Polygon", "MultiPolygon"], "capas-pol-borde": ["Polygon", "MultiPolygon"], "capas-lineas": ["LineString", "MultiLineString"], "capas-lineas-texto": ["LineString", "MultiLineString"], "capas-estaciones": ["Point", "MultiPoint"] };
function filtroCapas(id) {
  var f = ["all", ["in", ["get", "_capa"], ["literal", clavesVisibles()]], ["in", ["geometry-type"], ["literal", TIPOS_CAPA[id]]]];
  if (id === "capas-lineas-texto") f.push(["has", "nombre"]);
  return f;
}
function aplicarFiltrosCapas() {
  if (!map || !mapaListo) return;
  Object.keys(TIPOS_CAPA).forEach(function (id) { if (map.getLayer(id)) map.setFilter(id, filtroCapas(id)); });
}
function refrescarCapasMapa() {
  if (map && mapaListo && map.getSource("capas")) { map.getSource("capas").setData(geoCapas()); aplicarFiltrosCapas(); }
}
async function recargarCapas() { await cargarCapasMapa(); refrescarCapasMapa(); renderGestor(); }
function crearForma(forma, col) {
  var c = document.createElement("canvas"); c.width = c.height = 32;
  var g = c.getContext("2d");
  g.beginPath();
  if (forma === "circulo") g.arc(16, 16, 13, 0, Math.PI * 2);
  else if (forma === "cuadrado") g.rect(4, 4, 24, 24);
  else if (forma === "triangulo") { g.moveTo(16, 3); g.lineTo(30, 28); g.lineTo(2, 28); g.closePath(); }
  else { g.moveTo(16, 2); g.lineTo(30, 16); g.lineTo(16, 30); g.lineTo(2, 16); g.closePath(); }
  g.fillStyle = col; g.fill(); g.lineWidth = 3; g.strokeStyle = "#ffffff"; g.lineJoin = "round"; g.stroke();
  var d = g.getImageData(0, 0, 32, 32);
  return { width: 32, height: 32, data: d.data };
}
function crearRombo(col) {
  var c = document.createElement("canvas"); c.width = c.height = 32;
  var g = c.getContext("2d");
  g.beginPath(); g.moveTo(16, 2); g.lineTo(30, 16); g.lineTo(16, 30); g.lineTo(2, 16); g.closePath();
  g.fillStyle = col; g.fill(); g.lineWidth = 3; g.strokeStyle = "#ffffff"; g.stroke();
  var d = g.getImageData(0, 0, 32, 32);
  return { width: 32, height: 32, data: d.data };
}
/* v2.44: iconos con letra, en el color de la sesión: círculo con R (Recolección) o con O (Observación), rombo con N (Nota general) y círculo liso para el resto.
   Se dibujan a 64 px y se reducen con icon-size, así que quedan nítidos. Las estaciones del catálogo (rombos lisos morado y naranja) no llevan letra. */
function iconoLetra(col, letra, rombo) {
  var S = 64, c = document.createElement("canvas"); c.width = c.height = S;
  var g = c.getContext("2d");
  g.beginPath();
  if (rombo) { g.moveTo(32, 3); g.lineTo(61, 32); g.lineTo(32, 61); g.lineTo(3, 32); g.closePath(); }
  else g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fillStyle = col; g.fill(); g.lineWidth = 5; g.strokeStyle = "#ffffff"; g.stroke();
  if (letra) {
    g.fillStyle = "#ffffff"; g.font = "bold " + (rombo ? 30 : 36) + "px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(letra, 32, rombo ? 34 : 35);
  }
  var d = g.getImageData(0, 0, S, S);
  return { width: S, height: S, data: d.data };
}
/* tamaños en pantalla (px) = 56 u 58 px del icono por icon-size: círculos de 17 y 22 px (normal y sesión activa), rombo de 16 y 21 px */
var TAM_CIRC = [0.30, 0.40], TAM_ROMBO = [0.28, 0.36];
function resumenCuenta(c) {
  var t = [];
  if (c && c.puntos) t.push(c.puntos + (c.puntos === 1 ? " punto" : " puntos"));
  if (c && c.lineas) t.push(c.lineas + (c.lineas === 1 ? " línea" : " líneas"));
  if (c && c.poligonos) t.push(c.poligonos + (c.poligonos === 1 ? " polígono" : " polígonos"));
  return t.join(", ");
}
function cerrarTarjeta() { var t = $("mp-tarjeta"); tarjDesp.x = 0; tarjDesp.y = 0; if (t) { t.style.display = "none"; t.style.transform = ""; } }
function mostrarTarjetaCapa(f, lngLat) {
  var t = $("mp-tarjeta"); if (!t) return;
  tarjDesp.x = 0; tarjDesp.y = 0; t.style.transform = "";
  var p = f.properties || {}, capa = capasActuales.filter(function (c) { return c.clave === p._capa; })[0];
  var esPunto = /Point/.test(f.geometry.type);
  var titulo = p.nombre || p.estacion || (esPunto ? "Punto de referencia" : "Línea");
  t.textContent = "";
  t.appendChild(el("b", { texto: titulo }));
  function linea(rot, v) { if (v !== undefined && v !== null && v !== "") t.appendChild(el("div", { class: "mp-suave", texto: rot + ": " + v })); }
  if (esPunto) { linea("Estación", p.estacion); linea("Localidad específica", p.localidad_especifica); if (!p.localidad_especifica) linea("Localidad", p.localidad); }
  linea("Descripción", p.descripcion);
  var c = esPunto ? f.geometry.coordinates : [lngLat.lng, lngLat.lat];
  linea(esPunto ? "Coordenadas" : "Punto tocado", c[1].toFixed(5) + ", " + c[0].toFixed(5));
  linea("Capa", capa ? capa.nombre + (capa.origen === "local" ? " (importada, solo en este teléfono)" : " (del catálogo)") : "");
  t.appendChild(el("div", { class: "mp-suave", texto: "Es un punto de referencia: no es un registro de la libreta." }));
  t.appendChild(el("div", { class: "mp-fila" }, [el("button", { texto: "Cerrar", onclick: cerrarTarjeta })]));
  t.style.display = "block";
}
async function importarCapaLocal(file, mapaId, vinculo) {
  if (mapaId && !inst[mapaId]) { LC.toast("Elige un mapa instalado, o «Sin mapa»"); return; }
  var tipo = tipoPorNombre(file.name);
  if (!tipo) { LC.toast("Formato no admitido. Usa CSV, GeoJSON, GPX o shapefile en .zip", 5000); return; }
  if (file.size > 25 * 1048576) { LC.toast("El archivo pesa más de 25 MB", 5000); return; }
  var m = mapaId ? inst[mapaId] : null, r;
  try { r = await parsearCapa(file, tipo); }
  catch (e) { LC.toast("No se pudo leer la capa: " + (e.message || e), 6000); anotarError("importar capa", e); return; }
  var total = r.cuenta.puntos + r.cuenta.lineas + r.cuenta.poligonos, a = m ? m.area : null;
  if (a && (r.bbox[2] < a[0] || r.bbox[0] > a[2] || r.bbox[3] < a[1] || r.bbox[1] > a[3])) {
    var msg = "Ningún elemento de la capa cae dentro del área de este mapa.";
    if (!(r.bbox[3] < a[0] || r.bbox[1] > a[2] || r.bbox[2] < a[1] || r.bbox[0] > a[3])) msg += " Parece que las coordenadas están en orden latitud, longitud.";
    if (!confirm(msg + "\n\n¿Importarla igual?")) return;
  }
  if (total > 5000 && !confirm("La capa tiene " + total + " elementos y puede volver lento el mapa.\n\n¿Importarla igual?")) return;
  var id = "l" + Date.now().toString(36), archivo = "capa-local-" + id + ".geojson", blob = new Blob([JSON.stringify(r.fc)], { type: "application/geo+json" });
  try { await Alm.guardar(archivo, blob); }
  catch (e) { LC.toast("No se pudo guardar la capa: " + (e.message || e), 6000); anotarError("guardar capa", e); return; }
  capasLoc.push({ id: id, mapaId: mapaId || "", vinculo: vinculo || "", nombre: file.name.replace(/\.[^.]+$/, ""), archivo: archivo, tipo: tipo, bytes: blob.size, fecha: fechaHM(), elementos: r.cuenta });
  guardarJSON(LS_CAPAS_LOC, capasLoc);
  if (tipo === "csv") estiloAbierto = id;
  await recargarCapas();
  LC.toast("Capa «" + capasLoc[capasLoc.length - 1].nombre + "» importada: " + resumenCuenta(r.cuenta) + (tipo === "csv" && csvOmitidas ? " (" + csvOmitidas + (csvOmitidas === 1 ? " fila omitida" : " filas omitidas") + " sin coordenadas válidas)" : "") + (tipo === "csv" ? ". Ajusta su estilo abajo." : ""), tipo === "csv" ? 5000 : undefined);
}
function panelEstiloCapa(c) {
  var en = capasLoc.filter(function (x) { return x.id === c.id; })[0]; if (!en) return el("div");
  var e = estiloDe(en);
  function cambiar(campo, v) { en.estilo = Object.assign({}, en.estilo || {}); en.estilo[campo] = v; guardarJSON(LS_CAPAS_LOC, capasLoc); refrescarCapasMapa(); renderGestor(); }
  var cajaCol = el("div", { class: "mp-estilo-colores" });
  ESTILO_COLORES.forEach(function (k) {
    cajaCol.appendChild(el("button", { type: "button", class: "mp-estilo-col" + (k === e.color ? " on" : ""), style: "background:" + k, "aria-label": "Color " + k, onclick: function () { cambiar("color", k); } }));
  });
  var selF = el("select", {}), selT = el("select", {});
  Object.keys(ESTILO_FORMAS).forEach(function (k) { selF.appendChild(el("option", { value: k, texto: ESTILO_FORMAS[k] })); });
  Object.keys(ESTILO_TAMS).forEach(function (k) { selT.appendChild(el("option", { value: k, texto: ESTILO_TAMS[k] })); });
  selF.value = e.forma; selT.value = String(e.tam);
  selF.onchange = function () { cambiar("forma", selF.value); };
  selT.onchange = function () { cambiar("tam", Number(selT.value)); };
  var chkE = el("input", { type: "checkbox" }); chkE.checked = e.etq; chkE.onchange = function () { cambiar("etq", chkE.checked); };
  return el("div", { class: "mp-estilo" }, [
    el("div", { class: "mp-suave", texto: "Color" }), cajaCol,
    el("div", { class: "mp-estilo-fila" }, [el("label", {}, [el("span", { class: "mp-suave", texto: "Forma del punto" }), selF]), el("label", {}, [el("span", { class: "mp-suave", texto: "Tamaño" }), selT])]),
    el("label", { class: "mp-chk" }, [chkE, el("span", { texto: "Mostrar el nombre junto al punto" })])
  ]);
}

/* ---------- v2.93: vínculo de capas con sesiones o proyectos, y descarga (GeoJSON, GPX, CSV) ---------- */
function opcionesVinculo() {
  var o = [["", "Sin vínculo"]], st = LC.state || {};
  (st.viajes || []).forEach(function (v) { o.push(["viaje:" + v.id, "🧭 Proyecto: " + v.nombre]); });
  (st.sesiones || []).forEach(function (s) { o.push(["sesion:" + s.id, "📁 Sesión: " + LC.nombreSesionMostrar(s)]); });
  return o;
}
function nombreVinculo(v) {
  if (!v) return "";
  var op = opcionesVinculo().filter(function (x) { return x[0] === v; })[0];
  return op ? op[1] : "vínculo que ya no existe";
}
function selectorVinculo(valor, alCambiar) {
  var s = el("select", {});
  opcionesVinculo().forEach(function (x) { s.appendChild(el("option", { value: x[0], texto: x[1] })); });
  s.value = valor || ""; if (s.value !== (valor || "")) s.value = "";
  s.onchange = function () { alCambiar(s.value); };
  return s;
}
async function leerCapaFC(en) {
  var f = await Alm.leer(en.archivo); if (!f) throw new Error("archivo ausente");
  return JSON.parse(await f.text());
}
function xmlEsc(t) { return String(t == null ? "" : t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fcAGpx(fc, nombre) {
  var wpt = [], trk = [];
  function anillo(c) { return c.map(function (q) { return '<trkpt lat="' + q[1] + '" lon="' + q[0] + '"></trkpt>'; }).join(""); }
  fc.features.forEach(function (f) {
    var g = f.geometry, p = f.properties || {}, nom = xmlEsc(p.nombre || p.name || "");
    if (!g) return;
    if (g.type === "Point") wpt.push('<wpt lat="' + g.coordinates[1] + '" lon="' + g.coordinates[0] + '">' + (isFinite(p.altitud_m) && p.altitud_m !== "" ? "<ele>" + p.altitud_m + "</ele>" : "") + "<name>" + nom + "</name>" + (p.descripcion ? "<desc>" + xmlEsc(p.descripcion) + "</desc>" : "") + "</wpt>");
    else if (g.type === "MultiPoint") g.coordinates.forEach(function (c) { wpt.push('<wpt lat="' + c[1] + '" lon="' + c[0] + '"><name>' + nom + "</name></wpt>"); });
    else if (g.type === "LineString") trk.push("<trk><name>" + nom + "</name><trkseg>" + anillo(g.coordinates) + "</trkseg></trk>");
    else if (g.type === "MultiLineString") trk.push("<trk><name>" + nom + "</name>" + g.coordinates.map(function (l) { return "<trkseg>" + anillo(l) + "</trkseg>"; }).join("") + "</trk>");
    else if (g.type === "Polygon") trk.push("<trk><name>" + nom + "</name>" + g.coordinates.map(function (l) { return "<trkseg>" + anillo(l) + "</trkseg>"; }).join("") + "</trk>");
    else if (g.type === "MultiPolygon") g.coordinates.forEach(function (pl) { trk.push("<trk><name>" + nom + "</name>" + pl.map(function (l) { return "<trkseg>" + anillo(l) + "</trkseg>"; }).join("") + "</trk>"); });
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Libreta de Campo" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>' + xmlEsc(nombre) + "</name></metadata>\n" + wpt.join("\n") + "\n" + trk.join("\n") + "\n</gpx>\n";
}
function fcACsv(fc) {
  var pts = fc.features.filter(function (f) { return f.geometry && f.geometry.type === "Point"; });
  var claves = [];
  pts.forEach(function (f) { Object.keys(f.properties || {}).forEach(function (k) { if (!/^(nombre|latitud|longitud|lat|lon|_.*)$/i.test(k) && claves.indexOf(k) < 0) claves.push(k); }); });
  function q(v) { v = v == null ? "" : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  var filas = [["nombre", "latitud", "longitud"].concat(claves).map(q).join(",")];
  pts.forEach(function (f) {
    var p = f.properties || {}, c = f.geometry.coordinates;
    filas.push([p.nombre || p.name || "", c[1], c[0]].concat(claves.map(function (k) { return p[k]; })).map(q).join(","));
  });
  return { texto: "﻿" + filas.join("\r\n") + "\r\n", puntos: pts.length, otros: fc.features.length - pts.length };
}
function bajarTexto(texto, nombreArch, mime) {
  var blob = new Blob([texto], { type: mime }), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = nombreArch; document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 800);
}
async function descargarCapaLocal(id, fmt) {
  var en = capasLoc.filter(function (x) { return x.id === id; })[0]; if (!en) return;
  var fc; try { fc = await leerCapaFC(en); } catch (e) { LC.toast("No se pudo leer la capa para descargarla", 4000); return; }
  var base = (en.nombre || "capa").replace(/[\\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "capa";
  if (fmt === "gpx") bajarTexto(fcAGpx(fc, en.nombre), base + ".gpx", "application/gpx+xml");
  else if (fmt === "csv") {
    var r = fcACsv(fc);
    if (!r.puntos) { LC.toast("Esta capa no tiene puntos: el CSV solo guarda puntos. Usa GeoJSON o GPX.", 5000); return; }
    bajarTexto(r.texto, base + ".csv", "text/csv");
    if (r.otros) LC.toast("CSV listo con " + r.puntos + " puntos. Las líneas y polígonos no entran en el CSV (están en GeoJSON y GPX).", 5500);
  } else bajarTexto(JSON.stringify(fc, null, 1), base + ".geojson", "application/geo+json");
}
/* capas vinculadas a sesiones o proyectos, para el paquete .zip de exportación */
async function capasVinculadas(idsSesiones, idsViajes) {
  var res = [];
  for (var i = 0; i < capasLoc.length; i++) {
    var en = capasLoc[i], v = en.vinculo || "", ok = false;
    if (v.indexOf("sesion:") === 0) ok = idsSesiones.indexOf(v.slice(7)) >= 0;
    else if (v.indexOf("viaje:") === 0) ok = idsViajes.indexOf(v.slice(6)) >= 0;
    if (!ok) continue;
    try { res.push({ id: en.id, nombre: en.nombre, vinculo: v, fc: await leerCapaFC(en) }); } catch (e) { anotarError("capa vinculada " + en.nombre, e); }
  }
  return res;
}
async function eliminarCapaLocal(id) {
  var c = capasLoc.filter(function (x) { return x.id === id; })[0]; if (!c) return;
  await Alm.borrar(c.archivo); delete capasCache[c.archivo];
  capasLoc = capasLoc.filter(function (x) { return x.id !== id; });
  guardarJSON(LS_CAPAS_LOC, capasLoc);
  await recargarCapas();
  LC.toast("Capa eliminada");
}

/* ---------- catálogo ---------- */
/* v2.79: el repositorio de mapas pasó de «libreta-mapas-prueba» a «libreta-mapas» (2026-10-06) y GitHub Pages no redirige la dirección antigua (error 404).
   Se corrige la dirección guardada en el teléfono y las direcciones de paquetes, capas e imágenes que traiga el catálogo. */
function repararDir(u) { return typeof u === "string" ? u.replace(/(github\.io)\/libreta-mapas-prueba\//, "$1/libreta-mapas/") : u; }
function repararCatalogo(x) {
  if (typeof x === "string") return repararDir(x);
  if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) x[i] = repararCatalogo(x[i]); return x; }
  if (x && typeof x === "object") { for (var k in x) x[k] = repararCatalogo(x[k]); }
  return x;
}
function catalogoUrl() { return repararDir(PARAMS.get("catalogo") || (LC && LC.mapaCfg().catalogoUrl) || ""); }
async function cargarCatalogo() {
  var url = catalogoUrl(), sep = url.indexOf("?") >= 0 ? "&" : "?";
  try {
    if (!url) throw new Error("falta la dirección del catálogo");
    var r = await fetch(url + sep + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var j = await r.json();
    if (j.esquema !== 1 || !Array.isArray(j.mapas)) throw new Error("Catálogo con formato no reconocido");
    repararCatalogo(j);
    cat = j; catInfo = "Catálogo del " + (j.actualizado || "?") + ", consultado " + fechaHM();
    guardarJSON(LS_CAT, { fecha: fechaHM(), data: j });
    return true;
  } catch (e) {
    anotarError("catálogo", e);
    var g = leerJSON(LS_CAT, null);
    if (g && g.data) { cat = repararCatalogo(g.data); catInfo = "Sin poder consultar. Catálogo guardado el " + g.fecha; }
    else { cat = null; catInfo = "Sin catálogo. Conéctate una vez para descargarlo."; }
    return false;
  }
}

/* ---------- instalación ---------- */
async function reconciliar() {
  var perdidos = [];
  for (var id in inst) {
    var ok = true;
    for (var i = 0; i < inst[id].archivos.length; i++) {
      var a = inst[id].archivos[i], f = null;
      try { f = await Alm.leer(a.nombre); } catch (e) { anotarError("leer " + a.nombre, e); }
      if (!f || (a.bytes && f.size !== a.bytes)) ok = false;
    }
    if (!ok) { perdidos.push(inst[id].nombre); delete inst[id]; }
  }
  for (var id2 in inst) {
    var okC = [];
    for (var ci = 0; ci < (inst[id2].capas || []).length; ci++) {
      var cc = inst[id2].capas[ci], fc2 = null;
      try { fc2 = await Alm.leer(cc.archivo); } catch (e) { anotarError("leer " + cc.archivo, e); }
      if (fc2) okC.push(cc);
    }
    inst[id2].capas = okC;
  }
  var locOk = [];
  for (var li = 0; li < capasLoc.length; li++) {
    var fl = null;
    try { fl = await Alm.leer(capasLoc[li].archivo); } catch (e) { anotarError("leer " + capasLoc[li].archivo, e); }
    if (fl && (!capasLoc[li].mapaId || inst[capasLoc[li].mapaId])) locOk.push(capasLoc[li]); else if (fl) await Alm.borrar(capasLoc[li].archivo);
  }
  capasLoc = locOk; guardarJSON(LS_CAPAS_LOC, capasLoc);
  var usados = {};
  Object.keys(inst).forEach(function (id) { inst[id].archivos.forEach(function (a) { usados[a.nombre] = 1; }); (inst[id].capas || []).forEach(function (c) { usados[c.archivo] = 1; }); });
  capasLoc.forEach(function (c) { usados[c.archivo] = 1; });
  try {
    var todos = await Alm.listar();
    for (var k = 0; k < todos.length; k++) if (/\.(pmtiles|geojson|gpx|zip)$/.test(todos[k]) && !usados[todos[k]]) await Alm.borrar(todos[k]);
  } catch (e) { anotarError("limpieza", e); }
  guardarJSON(LS_IDX, inst);
  if (perdidos.length) LC.toast("El teléfono borró mapas guardados: " + perdidos.join(", ") + ". Hay que descargarlos de nuevo.", 7000);
}
async function leerAlmacenamiento() {
  try {
    if (navigator.storage && navigator.storage.estimate) { var e = await navigator.storage.estimate(); almEst.usado = e.usage; almEst.cuota = e.quota; }
    if (navigator.storage && navigator.storage.persisted) almEst.protegido = await navigator.storage.persisted();
  } catch (e) { anotarError("almacenamiento", e); }
}

async function descargarMapa(entrada, soloCapas) {
  if (desc) return;
  var previo = inst[entrada.id];
  if (soloCapas && !previo) soloCapas = false;
  var lista = soloCapas ? [] : archivosDe(entrada);
  var listaCapas = soloCapas ? capasPendientes(entrada) : capasDe(entrada);
  if (!soloCapas && lista.length === 0) { LC.toast("El catálogo no trae archivos para este mapa"); return; }
  if (soloCapas && !listaCapas.length) return;
  var total = lista.concat(listaCapas).reduce(function (s, a) { return s + (a.bytes || 0); }, 0);
  desc = { id: entrada.id, ctrl: new AbortController(), total: total, hecho: 0, t0: performance.now() };
  var nuevos = [], nuevasCapas = [], fallos = [], ultimo = 0;
  function progreso(n) { desc.hecho += n; var t = performance.now(); if (t - ultimo > 200) { ultimo = t; refrescarUI(); } }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  refrescarUI();
  try {
    for (var i = 0; i < lista.length; i++) {
      var nombre = nombreDeUrl(lista[i].url);
      nuevos.push({ tipo: lista[i].tipo, nombre: nombre, bytes: lista[i].bytes || 0 });
      await Alm.descargar(lista[i].url, nombre, lista[i].bytes || 0, progreso, desc.ctrl.signal);
    }
    for (var k = 0; k < listaCapas.length; k++) {
      var c = listaCapas[k], final = "capa-" + entrada.id + "-" + c.id + ".geojson", crudo = "crudo-" + entrada.id + "-" + c.id + "-" + nombreDeUrl(c.url);
      try {
        await Alm.descargar(c.url, crudo, c.bytes || 0, progreso, desc.ctrl.signal, "ninguna");
        var rf = await Alm.leer(crudo);
        var rp = await parsearCapa(rf, tipoCapa(c.tipo));
        var blob = new Blob([JSON.stringify(rp.fc)], { type: "application/geo+json" });
        await Alm.guardar(final, blob);
        await Alm.borrar(crudo);
        delete capasCache[final];
        nuevasCapas.push({ id: c.id, tipo: tipoCapa(c.tipo), nombre: c.nombre || c.id, url: c.url, archivo: final, bytes: blob.size, elementos: rp.cuenta });
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        try { await Alm.borrar(crudo); } catch (_) {}
        fallos.push((c.nombre || c.id) + ": " + (e.message || e)); anotarError("capa " + c.id, e);
      }
    }
    var seg = (performance.now() - desc.t0) / 1000, bytes = desc.hecho;
    metricas.descargas.push({ mapa: entrada.nombre + (soloCapas ? " (capas)" : ""), bytes: bytes, seg: seg });
    if (soloCapas) {
      previo.capas = (previo.capas || []).filter(function (x) { return !nuevasCapas.some(function (n) { return n.id === x.id; }); }).concat(nuevasCapas);
    } else {
      inst[entrada.id] = { id: entrada.id, nombre: entrada.nombre, region: entrada.region, version: entrada.version, area: entrada.area, archivos: nuevos, capas: nuevasCapas, fecha: fechaHM() };
      if (previo) {
        previo.archivos.forEach(function (a) { if (!nuevos.some(function (n) { return n.nombre === a.nombre; })) Alm.borrar(a.nombre); });
        (previo.capas || []).forEach(function (a) { if (!nuevasCapas.some(function (n) { return n.archivo === a.archivo; })) { Alm.borrar(a.archivo); delete capasCache[a.archivo]; } });
      }
    }
    guardarJSON(LS_IDX, inst);
    desc = null;
    estiloFirma = undefined;   /* fuerza redibujar con los archivos nuevos */
    await leerAlmacenamiento();
    LC.toast((soloCapas ? "Capas descargadas: " + nuevasCapas.length : "Mapa instalado: " + mb(bytes) + " en " + seg.toFixed(1) + " s") + (fallos.length ? ". No se pudieron leer: " + fallos.join("; ") : ""), fallos.length ? 8000 : 3500);
    LC.actualizarPestanaMapa();
  } catch (e) {
    for (var j = 0; j < nuevos.length; j++) {
      var enUso = previo && previo.archivos.some(function (a) { return a.nombre === nuevos[j].nombre; });
      if (!enUso) await Alm.borrar(nuevos[j].nombre);
    }
    for (var q = 0; q < nuevasCapas.length; q++) {
      var usada = previo && (previo.capas || []).some(function (a) { return a.archivo === nuevasCapas[q].archivo; });
      if (!usada) await Alm.borrar(nuevasCapas[q].archivo);
    }
    var cancelo = e && e.name === "AbortError";
    LC.toast(cancelo ? "Descarga cancelada" : "Falló la descarga: " + (e.message || e), 6000);
    if (!cancelo) anotarError("descarga", e);
    desc = null;
  }
  refrescarUI();
  if (LC.state.currentView === "mapa") alMostrar();
}

async function eliminarMapa(id) {
  var m = inst[id]; if (!m) return;
  for (var i = 0; i < m.archivos.length; i++) await Alm.borrar(m.archivos[i].nombre);
  var propias = (m.capas || []).concat(capasLoc.filter(function (c) { return c.mapaId === id; }));
  for (var ic = 0; ic < propias.length; ic++) { await Alm.borrar(propias[ic].archivo); delete capasCache[propias[ic].archivo]; }
  capasLoc = capasLoc.filter(function (c) { return c.mapaId !== id; }); guardarJSON(LS_CAPAS_LOC, capasLoc);
  delete inst[id]; guardarJSON(LS_IDX, inst);
  estiloFirma = undefined;
  await leerAlmacenamiento();
  refrescarUI();
  if (LC.state.currentView === "mapa") alMostrar();
  LC.toast("Mapa eliminado");
  LC.actualizarPestanaMapa();
}

/* ---------- puntos de la libreta (registros con coordenadas) ---------- */
var ROT_TIPO = { coleccion: "Recolección", observacion: "Observación", nota: "Nota general", medicion: "Medición" };
function numOk(x) { if (x === "" || x === null || x === undefined) return null; var n = parseFloat(x); return isFinite(n) ? n : null; }
function claseMarca(r) { return r.tipo === "nota" ? "nota" : r.tipo === "coleccion" ? "rec" : r.tipo === "observacion" ? "obs" : "otro"; }
/* v2.44: la Observación dibuja su punto de inicio y, si hay otro, su punto de término (fin: 1). Ambos llevan el mismo registro y se abren igual. */
function geoPuntos() {
  var fs = [];
  LC.state.registros.forEach(function (r) {
    var la = numOk(r.lat), lo = numOk(r.lon);
    if (la === null || lo === null) return;
    var cod = r.codigo || r.notaTitulo || "";
    var pr = { id: r.id, codigo: cod, etq: cod, sesion: r.sesionId, activa: r.sesionId === LC.state.sesionActivaId ? 1 : 0, color: LC.colorSesion(r.sesionId), nota: r.tipo === "nota" ? 1 : 0, clase: claseMarca(r), fin: 0 };
    fs.push({ type: "Feature", properties: pr, geometry: { type: "Point", coordinates: [lo, la] } });
    var fin = r.tipo === "observacion" && r.obsTermino ? { la: numOk(r.obsTermino.lat), lo: numOk(r.obsTermino.lon) } : null;
    if (fin && fin.la !== null && fin.lo !== null && (Math.abs(fin.la - la) > 1e-6 || Math.abs(fin.lo - lo) > 1e-6)) {
      var p2 = {}; Object.keys(pr).forEach(function (k) { p2[k] = pr[k]; }); p2.fin = 1; p2.etq = "";
      fs.push({ type: "Feature", properties: p2, geometry: { type: "Point", coordinates: [fin.lo, fin.la] } });
    }
  });
  return { type: "FeatureCollection", features: fs };
}
function coordsTrack(pts) {
  var out = [];
  (pts || []).forEach(function (p) { var la = numOk(p && p.lat), lo = numOk(p && p.lon); if (la !== null && lo !== null) out.push([lo, la]); });
  return out;
}
/* v2.44: tracks de las Observaciones guardadas. Con track real, línea continua. Sin track pero con inicio y término distintos, una línea recta punteada que solo une los dos puntos. */
function geoTracks() {
  var fs = [];
  LC.state.registros.forEach(function (r) {
    if (r.tipo !== "observacion") return;
    var pr = { id: r.id, sesion: r.sesionId, activa: r.sesionId === LC.state.sesionActivaId ? 1 : 0, color: LC.colorSesion(r.sesionId), recto: 0, clase: "obs" };
    var cs = coordsTrack(r.trackPuntos);
    if (cs.length >= 2) { fs.push({ type: "Feature", properties: pr, geometry: { type: "LineString", coordinates: cs } }); return; }
    var la = numOk(r.lat), lo = numOk(r.lon), fin = r.obsTermino ? { la: numOk(r.obsTermino.lat), lo: numOk(r.obsTermino.lon) } : null;
    if (la !== null && lo !== null && fin && fin.la !== null && fin.lo !== null && (Math.abs(fin.la - la) > 1e-6 || Math.abs(fin.lo - lo) > 1e-6)) {
      pr.recto = 1;
      fs.push({ type: "Feature", properties: pr, geometry: { type: "LineString", coordinates: [[lo, la], [fin.lo, fin.la]] } });
    }
  });
  return { type: "FeatureCollection", features: fs };
}
/* v2.44: Observación que se está grabando ahora (borrador con seguimiento activo). Se dibuja su recorrido y su punto de inicio mientras se mira el mapa. */
function borradorEnVivo() {
  var d = LC && LC.state && LC.state.draft;
  if (!d || d._viendo || d.tipo !== "observacion" || !d.obsTrackingActivo || !d.obsInicio) return null;
  return d;
}
function geoVivo() {
  var fc = { type: "FeatureCollection", features: [] }, d = borradorEnVivo();
  if (!d) return fc;
  var col = LC.colorSesion(d.sesionId || LC.state.sesionActivaId), cs = coordsTrack(d.trackPuntos);
  if (cs.length >= 2) fc.features.push({ type: "Feature", properties: { tipo: "linea", color: col }, geometry: { type: "LineString", coordinates: cs } });
  var la = numOk(d.obsInicio.lat), lo = numOk(d.obsInicio.lon);
  if (la !== null && lo !== null) fc.features.push({ type: "Feature", properties: { tipo: "inicio", color: col }, geometry: { type: "Point", coordinates: [lo, la] } });
  return fc;
}
var vivoClave = "", vivoTimer = null;
function chipRec() {
  var c = $("mp-chip-rec"); if (!c) return;
  var d = borradorEnVivo();
  if (!d) { c.style.display = "none"; return; }
  var n = (d.trackPuntos || []).length;
  c.style.display = "";
  c.className = "mp-chip mp-chip-btn " + (d.obsPausado ? "ambar" : "rojo");
  c.textContent = (d.obsPausado ? "⏸ Track en pausa · " : "● Grabando track · ") + n + (n === 1 ? " punto" : " puntos");
}
function refrescarVivo(forzar) {
  chipRec();
  if (!map || !mapaListo || !map.getSource("vivo")) return;
  var d = borradorEnVivo(), clave = d ? (d.id || "") + ":" + (d.trackPuntos || []).length + ":" + d.obsInicio.horaTs : "";
  if (!forzar && clave === vivoClave) return;
  vivoClave = clave; map.getSource("vivo").setData(geoVivo());
}
/* ---------- v2.45: recorridos grabados desde el mapa ---------- */
function listaRecorridos() { return (LC && LC.state && LC.state.recorridos) || []; }
function segmentosRec(rc) {
  var segs = [], act = [];
  (rc.puntos || []).forEach(function (p, i) {
    var la = numOk(p && p.lat), lo = numOk(p && p.lon); if (la === null || lo === null) return;
    if (i > 0 && p.corte && act.length) { segs.push(act); act = []; }
    act.push([lo, la]);
  });
  if (act.length) segs.push(act);
  return segs.filter(function (sg) { return sg.length >= 2; });
}
function geoRecorridos() {
  var fs = [];
  listaRecorridos().forEach(function (rc) {
    var sg = segmentosRec(rc); if (!sg.length) return;
    var pr = { id: rc.id, sesion: rc.sesionId, color: rc.sesionId ? LC.colorSesion(rc.sesionId) : "#5a4616", grabando: rc.enCurso ? 1 : 0, clase: "recorrido" };
    fs.push({ type: "Feature", properties: pr, geometry: sg.length === 1 ? { type: "LineString", coordinates: sg[0] } : { type: "MultiLineString", coordinates: sg } });
  });
  return { type: "FeatureCollection", features: fs };
}
var recClave = "";
function refrescarRecorridos(forzar) {
  if (!map || !mapaListo || !map.getSource("recorridos")) return;
  var clave = listaRecorridos().map(function (rc) { return rc.id + ":" + (rc.puntos || []).length + ":" + (rc.enCurso ? 1 : 0); }).join("|");
  if (!forzar && clave === recClave) return;
  recClave = clave; map.getSource("recorridos").setData(geoRecorridos());
}
function distRec(a, b) { return distanciaM({ lat: a.lat, lng: a.lon }, { lat: b.lat, lng: b.lon }); }
function textoDuracion(ms) {
  var m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60);
  return h ? h + " h " + (m % 60 < 10 ? "0" : "") + (m % 60) + " min" : m + " min";
}
function textoRecorrido(rc) {
  var fin = rc.finTs || Date.now();
  return textoDistancia(rc.distanciaM || 0) + " · " + textoDuracion(fin - rc.inicioTs) + (rc.interrumpido ? " · interrumpido" : "");
}
function chipGrab() {
  var c = $("mp-chip-grab"), b = $("mp-grabar");
  var rc = grab.rc;
  if (b) { b.textContent = rc ? "⏹ Detener grabación" : "⏺ Grabar recorrido"; b.classList.toggle("on", !!rc); b.classList.toggle("grabando", !!rc); }
  var bq = $("mp-bloqueo"); if (bq) { bq.disabled = !rc; bq.textContent = rc ? "🔒 Bloquear pantalla" : "🔒 Bloqueo (solo al grabar)"; }
  var tb = $("mp-tracks"); if (tb) { tb.classList.toggle("grabando", !!rc); rotuloTb("mp-tracks", rc ? "⏹" : "⏺", rc ? "Grabando" : "Tracks"); }
  if (!c) return;
  if (!rc) { c.style.display = "none"; return; }
  c.style.display = ""; c.className = "mp-chip mp-chip-btn rojo";
  c.textContent = "● Grabando recorrido · " + textoDistancia(rc.distanciaM || 0) + " · " + textoDuracion(Date.now() - rc.inicioTs);
}
function guardarGrab(forzar) {
  if (!grab.rc) return;
  if (!forzar && !grab.sucio) return;
  grab.sucio = false; grab.ultimoGuardado = Date.now();
  LC.guardarRecorridos();
}
/* v2.48: la pantalla siempre encendida durante la grabación viene activada por defecto; el botón "Pantalla" del mapa la apaga o la enciende.
   La preferencia se comparte con el seguimiento de las Observaciones (misma clave en localStorage). */
/* v2.52: el botón se llama "Pantalla encendida" y viene APAGADO por defecto (clave propia del mapa, distinta de la del seguimiento de Observación). Con el Bloqueo activo la pantalla se mantiene encendida igual. */
function pantallaPref() { try { return localStorage.getItem("libretaCampo_pantallaMapa") === "1"; } catch (e) { return false; } }
function botonPantalla() {
  var b = $("mp-pantalla"); if (!b) return;
  var on = pantallaPref();
  b.textContent = (on ? "🔆 " : "🌙 ") + "Pantalla encendida";
  b.title = on ? "Pantalla encendida al grabar (activado)" : "Pantalla encendida al grabar (apagado)";
  b.classList.toggle("on", on);
}
function alternarPantalla() {
  var nuevo = !pantallaPref();
  try { localStorage.setItem("libretaCampo_pantallaMapa", nuevo ? "1" : "0"); } catch (e) {}
  botonPantalla();
  if (nuevo) { pedirPantalla(); LC.toast("🔆 La pantalla no se apagará mientras grabas", 3500); }
  else { if (!grab.bloq) soltarPantalla(); LC.toast("⚠️ La pantalla podrá apagarse y el GPS dejar de registrar el recorrido", 4500); }
}
async function pedirPantalla() {
  try {
    if (!grab.rc || (!pantallaPref() && !grab.bloq) || !navigator.wakeLock || grab.wake) return;
    grab.wake = await navigator.wakeLock.request("screen");
    grab.wake.addEventListener("release", function () { grab.wake = null; });
  } catch (e) { grab.wake = null; }
}
function soltarPantalla() { try { if (grab.wake) grab.wake.release(); } catch (e) {} grab.wake = null; }
function grabPunto(p) {
  var rc = grab.rc; if (!rc) return;
  var c = p.coords, acc = (typeof c.accuracy === "number" && c.accuracy > 0) ? c.accuracy : 999;
  grab.ultimoFixTs = Date.now(); grab.ultimaAcc = acc < 999 ? Math.round(acc) : null;   /* v2.52: el vigilante mide el tiempo desde la última lectura recibida */
  if (acc > GRAB_ACC_MAX) return;   /* lecturas muy imprecisas ensucian el track */
  var ahora = Date.now(), pts = rc.puntos, ult = pts.length ? pts[pts.length - 1] : null;
  var nuevo = { lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6), horaTs: ahora, accuracy: Math.round(acc) };
  if (ult) {
    var d = distRec(ult, nuevo), dt = ahora - ult.horaTs;
    if (d < GRAB_DIST_MIN && dt < GRAB_T_MAX) return;   /* parado: no se llena de puntos repetidos */
    var hueco = grab.cortarSig; grab.cortarSig = false;
    if ((dt > GRAB_CORTE_T || hueco) && d > (hueco ? 25 : GRAB_CORTE_D)) nuevo.corte = true;   /* hubo un hueco (pantalla bloqueada, sin señal): no se une con una recta inventada */
    else rc.distanciaM = (rc.distanciaM || 0) + d;
  }
  pts.push(nuevo); grab.sucio = true;
  if (ahora - grab.ultimoGuardado > GRAB_GUARDAR_T) guardarGrab(true);
  chipGrab();
}
function armarWatchGrab() {
  if (!grab.rc || !navigator.geolocation) return;
  if (grab.watch != null) { try { navigator.geolocation.clearWatch(grab.watch); } catch (e) {} }
  grab.watch = navigator.geolocation.watchPosition(grabPunto, function (e) { anotarError("grabacion", e); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  grab.rearmadoTs = Date.now();
}
/* v2.52: si pasan GRAB_WATCHDOG_T ms sin recibir ninguna lectura, se vuelve a pedir el GPS (a veces el navegador lo deja dormido) */
function vigilarGrab() {
  if (!grab.rc) return;
  guardarGrab(false);
  var ref = Math.max(grab.ultimoFixTs || 0, grab.rearmadoTs || 0, grab.rc.inicioTs || 0);
  if (Date.now() - ref > GRAB_WATCHDOG_T) { armarWatchGrab(); grab.rearmados++; }
  if (!grab.bloq) { chipGrab(); refrescarRecorridos(false); }
}
function iniciarGrabacion() {
  if (grab.rc) return;
  if (!navigator.geolocation) { LC.toast("Este navegador no tiene GPS disponible"); return; }
  /* v2.67: sin sesión activa se puede grabar una ruta de proyecto si hay un proyecto activo */
  var ses = LC.sesionActiva(), vj = (!ses && LC.viajeActivo) ? LC.viajeActivo() : null;
  if (!ses && !vj) { LC.exigirSesionActiva(); return; }
  if (!LC.state.recorridos) LC.state.recorridos = [];
  var n = 1; LC.state.recorridos.forEach(function (x) { var mismo = ses ? x.sesionId === ses.id : (!x.sesionId && x.viajeId === vj.id); if (mismo && (x.n || 0) >= n) n = x.n + 1; });
  var rc = { id: "rc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sesionId: ses ? ses.id : null, viajeId: ses ? undefined : vj.id, n: n, nombre: "Recorrido " + n, inicioTs: Date.now(), finTs: null, enCurso: true, interrumpido: false, distanciaM: 0, puntos: [] };
  LC.state.recorridos.push(rc); grab.rc = rc; grab.sucio = true; guardarGrab(true);
  grab.ultimoFixTs = Date.now(); grab.rearmados = 0; grab.salidas = 0; grab.cortarSig = false; grab.ocultoTs = null;
  armarWatchGrab();
  grab.timer = setInterval(vigilarGrab, 3000);
  if (gps.watch == null) gpsEncender();
  pedirPantalla();
  chipGrab(); refrescarRecorridos(true);
  LC.toast(pantallaPref() ? "Grabando recorrido. La pantalla se mantendrá encendida para no perder la señal del GPS." : "Grabando recorrido. Si la pantalla se apaga el GPS deja de registrar: usa «Bloqueo» o «Pantalla encendida».", 6000);
}
function detenerGrabacion(sinPreguntar) {
  var rc = grab.rc; if (!rc) return;
  if (grab.bloq) { LC.toast("Desbloquea la pantalla para detener la grabación"); return; }
  if (!sinPreguntar && !confirm("¿Detener y guardar el " + rc.nombre.toLowerCase() + "? (" + textoRecorrido(rc) + ")")) return;
  if (grab.watch != null) { try { navigator.geolocation.clearWatch(grab.watch); } catch (e) {} }
  clearInterval(grab.timer); soltarPantalla();
  grab.watch = null; grab.timer = null; grab.rc = null;
  rc.enCurso = false; rc.finTs = Date.now();
  if ((rc.puntos || []).length < 2) {
    LC.state.recorridos = LC.state.recorridos.filter(function (x) { return x.id !== rc.id; });
    LC.guardarRecorridos(); chipGrab(); refrescarRecorridos(true);
    LC.toast("El recorrido era demasiado corto y no se guardó");
    return;
  }
  LC.guardarRecorridos(); chipGrab(); refrescarRecorridos(true);
  LC.toast("Recorrido guardado: " + textoRecorrido(rc), 4000);
}

/* ---------------- v2.52 · Bloqueo de pantalla durante la grabación ----------------
   Una página web no puede impedir que el teléfono cambie de app, ni cambiar el brillo del sistema. Lo que sí hace el bloqueo:
   cubre todo con una pantalla casi negra (menos luz y gasto), pide pantalla completa, intercepta el botón Atrás y el cierre
   de la pestaña, mantiene la pantalla encendida, y exige mantener presionado el botón 3 s para desbloquear. */
function bloqueoMensaje(t) { var e = $("mp-bq-msg"); if (e) e.textContent = t || ""; }
function pantallaCompleta(on) {
  try {
    var el = document.documentElement;
    if (on) { if (!document.fullscreenElement && el.requestFullscreen) { var pr = el.requestFullscreen({ navigationUI: "hide" }); if (pr && pr.catch) pr.catch(function () {}); } }
    else if (document.fullscreenElement && document.exitFullscreen) { var p2 = document.exitFullscreen(); if (p2 && p2.catch) p2.catch(function () {}); }
  } catch (e) {}
}
function construirBloqueo() {
  var o = $("mp-bq"); if (o) return o;
  o = document.createElement("div"); o.id = "mp-bq"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Pantalla bloqueada durante la grabación");
  o.innerHTML =
    '<div id="mp-bq-estado"></div><div id="mp-bq-det"></div><div id="mp-bq-msg"></div>' +
    '<button type="button" id="mp-bq-btn" aria-label="Mantén presionado para desbloquear">' +
      '<svg viewBox="0 0 100 100" width="132" height="132" aria-hidden="true"><circle cx="50" cy="50" r="45" fill="none" stroke="#333" stroke-width="6"/><circle id="mp-bq-anillo" cx="50" cy="50" r="45" fill="none" stroke="#6fbf73" stroke-width="6" stroke-linecap="round" stroke-dasharray="282.7" stroke-dashoffset="282.7" transform="rotate(-90 50 50)"/></svg>' +
      '<span id="mp-bq-ic">🔒</span></button>' +
    '<div id="mp-bq-ayuda">Mantén presionado el círculo 3 segundos para desbloquear</div>';
  document.body.appendChild(o);
  var btn = $("mp-bq-btn"), anillo = $("mp-bq-anillo"), t0 = 0, raf = 0, id = null;
  function pintar(f) { anillo.setAttribute("stroke-dashoffset", String(282.7 * (1 - f))); }
  function paso() {
    var f = Math.min(1, (Date.now() - t0) / BLOQ_HOLD_MS); pintar(f);
    if (f >= 1) { cancelar(); desbloquear(); return; }
    raf = requestAnimationFrame(paso);
  }
  function cancelar() { if (raf) cancelAnimationFrame(raf); raf = 0; t0 = 0; id = null; pintar(0); $("mp-bq-ic").textContent = "🔒"; }
  btn.addEventListener("pointerdown", function (e) {
    if (id != null) return;
    id = e.pointerId; try { btn.setPointerCapture(id); } catch (x) {}
    t0 = Date.now(); $("mp-bq-ic").textContent = "🔓"; raf = requestAnimationFrame(paso);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(function (ev) {
    btn.addEventListener(ev, function (e) { if (t0 && Date.now() - t0 < BLOQ_HOLD_MS) { cancelar(); bloqueoMensaje("Mantén presionado sin soltar para desbloquear"); } });
  });
  o.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  /* cualquier toque es un gesto válido para volver a pantalla completa si se perdió */
  o.addEventListener("pointerdown", function () { pantallaCompleta(true); }, true);
  return o;
}
function actualizarBloqueo() {
  var rc = grab.rc; if (!rc || !grab.bloq) return;
  var est = $("mp-bq-estado"), det = $("mp-bq-det"); if (!est || !det) return;
  est.textContent = "● Grabando · " + textoDistancia(rc.distanciaM || 0) + " · " + textoDuracion(Date.now() - rc.inicioTs);
  var edad = grab.ultimoFixTs ? Math.round((Date.now() - grab.ultimoFixTs) / 1000) : null;
  var sinSenal = edad == null || edad > 20;
  det.textContent = (sinSenal ? "⚠️ Sin señal GPS" + (edad != null ? " hace " + edad + " s" : "") : "Último punto hace " + edad + " s" + (grab.ultimaAcc != null ? " · ±" + grab.ultimaAcc + " m" : "")) + " · " + (rc.puntos || []).length + " puntos" + (grab.salidas ? " · " + grab.salidas + " salida(s)" : "");
  det.className = sinSenal ? "mala" : "";
}
function bloquear() {
  if (!grab.rc || grab.bloq) return;
  var o = construirBloqueo();
  grab.bloq = true; window.__lcBloqueo = true;
  o.classList.add("on"); bloqueoMensaje("");
  try { history.pushState(history.state || { lc: true }, ""); } catch (e) {}
  pantallaCompleta(true); pedirPantalla();
  actualizarBloqueo(); grab.bqTimer = setInterval(actualizarBloqueo, 1000);
}
function desbloquear() {
  if (!grab.bloq) return;
  grab.bloq = false; window.__lcBloqueo = false;
  clearInterval(grab.bqTimer); grab.bqTimer = null;
  var o = $("mp-bq"); if (o) o.classList.remove("on");
  pantallaCompleta(false);
  if (!pantallaPref()) soltarPantalla();
  chipGrab(); refrescarRecorridos(true);
}
function borrarRecorrido(rc) {
  if (grab.rc && grab.rc.id === rc.id) { LC.toast("Detén la grabación antes de borrar este recorrido"); return false; }
  if (!confirm("¿Borrar el " + rc.nombre.toLowerCase() + " (" + textoRecorrido(rc) + ")? No se puede deshacer.")) return false;
  LC.state.recorridos = LC.state.recorridos.filter(function (x) { return x.id !== rc.id; });
  if (capasVis.regs) delete capasVis.regs[rc.id];
  LC.guardarRecorridos(); guardarJSON(LS_CAPAS, capasVis); refrescarRecorridos(true);
  return true;
}
document.addEventListener("visibilitychange", function () {
  if (!grab.rc) return;
  if (document.visibilityState === "hidden") { grab.ocultoTs = Date.now(); guardarGrab(true); return; }
  /* v2.52: al volver se pide de nuevo el GPS y la pantalla encendida; si hubo un tramo sin registro, se marca como corte */
  armarWatchGrab(); pedirPantalla();
  var fuera = grab.ocultoTs ? Date.now() - grab.ocultoTs : 0; grab.ocultoTs = null;
  if (fuera > 10000) {
    var rc = grab.rc; if (!rc.huecos) rc.huecos = [];
    rc.huecos.push({ desde: Date.now() - fuera, hasta: Date.now() }); grab.cortarSig = true; grab.salidas++; guardarGrab(true);
    var txt = "⚠️ Saliste de la app " + textoDuracion(fuera) + ": el GPS no registró ese tramo";
    if (grab.bloq) bloqueoMensaje(txt); else LC.toast(txt, 6000);
  }
  if (grab.bloq) pantallaCompleta(true);
  chipGrab();
});
window.addEventListener("pagehide", function () { guardarGrab(true); });

function refrescarTracks() { if (map && mapaListo && map.getSource("tracks")) { map.getSource("tracks").setData(geoTracks()); aplicarFiltroPuntos(); } }
var pendienteVer = null, pendienteBounds = null, resaltado = null, resaltadoT = null;
var eleccion = null;   /* v2.87: modo "elegir coordenada" lanzado desde Ubicación manual de Nuevo */
var retorno = null;   /* v2.43: registro desde el que se llegó con "Ver en el mapa": { id, volverA } */
function geoResaltado() {
  return { type: "FeatureCollection", features: resaltado ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [resaltado.lng, resaltado.lat] } }] : [] };
}
function ponerResaltado(p, fijo) {
  resaltado = p; clearTimeout(resaltadoT);
  if (map && mapaListo && map.getSource("resaltado")) map.getSource("resaltado").setData(geoResaltado());
  if (p && !fijo) resaltadoT = setTimeout(function () { ponerResaltado(null); }, 15000);
}
function botonVolverRegistro() {
  var b = $("mp-volver-reg"); if (!b) return;
  b.style.display = retorno && !eleccion ? "" : "none";
  var c = $("mp-cancelar-elec"); if (c) c.style.display = eleccion ? "" : "none";
}
/* v2.87: desde Ubicación manual de Nuevo se abre el mapa para tocar la coordenada; "Usar esta coordenada" vuelve a Nuevo con latitud y longitud cargadas */
function elegirCoordenada(opts) {
  eleccion = { activo: true, alElegir: opts && opts.alElegir, alCancelar: opts && opts.alCancelar, alSalir: opts && opts.alSalir }; retorno = null; puntosManuales = []; selManual = -1;
  LC.irA("mapa");
  LC.toast("Toca el mapa (o mantén pulsado) para marcar la coordenada y luego pulsa «Usar esta coordenada».", 5500);
}
function cancelarEleccion() {
  if (!eleccion) return;
  var cb = eleccion.alCancelar;
  eleccion = null; puntosManuales = []; selManual = -1;
  if (map && mapaListo) refrescarNavMapa();
  cerrarTarjeta(); botonVolverRegistro();
  if (cb) cb(); else LC.irA("form");
}
async function usarCoordenadaElegida(pm) {
  var cb = eleccion && eleccion.alElegir;
  eleccion = null; botonVolverRegistro();
  puntosManuales = []; selManual = -1; if (map && mapaListo) refrescarNavMapa(); cerrarTarjeta();
  if (cb) cb(pm.lat, pm.lng); else LC.aplicarCoordenadaManual(pm.lat, pm.lng);
}
function volverAlRegistro() {
  if (!retorno) return;
  LC.verRegistroExistente(retorno.id, retorno.volverA);   /* si hay una edición pendiente y se cancela, sigue en el mapa */
}
function verPunto(reg) {
  if (!reg || !isFinite(reg.lat) || !isFinite(reg.lon)) { LC.toast("Este registro no tiene ubicación"); return; }
  pendienteVer = { lng: reg.lon, lat: reg.lat };
  retorno = reg.id ? { id: reg.id, volverA: reg.volverA || null } : null;
  LC.irA("mapa");
}
/* v2.67: acerca el mapa a un recorrido guardado (desde Exportar) */
function verRecorrido(id) {
  var rc = listaRecorridos().filter(function (x) { return x.id === id; })[0]; if (!rc) return;
  var sg = segmentosRec(rc);
  if (!sg.length) { LC.toast("Este recorrido no tiene un tramo válido para mostrar"); return; }
  var pts = []; sg.forEach(function (s) { s.forEach(function (c) { pts.push(c); }); });
  pendienteVer = { lng: pts[0][0], lat: pts[0][1] }; pendienteBounds = pts; retorno = null;
  LC.irA("mapa");
}
function refrescarPuntos() { if (map && mapaListo && map.getSource("puntos")) { map.getSource("puntos").setData(geoPuntos()); refrescarTracks(); refrescarRecorridos(true); refrescarVivo(true); aplicarFiltroPuntos(); } }

/* ---------- GPS en vivo ---------- */
function circuloMetros(lng, lat, r) {
  var pts = [], dLat = r / 111320, dLng = r / (111320 * Math.cos(lat * Math.PI / 180));
  for (var i = 0; i <= 48; i++) { var a = i / 48 * 2 * Math.PI; pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return pts;
}
function colorPrecision(acc) { return acc <= 10 ? "#2d5f3f" : acc <= 25 ? "#c9962c" : "#b5473a"; }
function geoGps() {
  var f = gps.fix, fc = { type: "FeatureCollection", features: [] };
  if (!f) return fc;
  var col = colorPrecision(f.acc);
  fc.features.push({ type: "Feature", properties: { tipo: "precision", color: col }, geometry: { type: "Polygon", coordinates: [circuloMetros(f.lng, f.lat, f.acc)] } });
  fc.features.push({ type: "Feature", properties: { tipo: "punto", color: col }, geometry: { type: "Point", coordinates: [f.lng, f.lat] } });
  return fc;
}
function chipGps() {
  var c = $("mp-chip-gps"); if (!c) return;
  c.className = "mp-chip mp-chip-btn";
  if (gps.watch == null) c.textContent = "GPS activar";
  else if (!gps.fix) c.textContent = "GPS buscando…";
  else {
    var a = Math.round(gps.fix.acc);
    c.textContent = "GPS ±" + a + " m";
    c.className = "mp-chip mp-chip-btn " + (a <= 10 ? "ok" : a <= 25 ? "ambar" : "rojo");
  }
  var cen = $("mp-centrar"); if (cen) cen.classList.toggle("sin-gps", !(gps.watch != null && gps.fix));
}
function gpsOk(p) {
  gps.fix = { lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: Date.now(), vel: (p.coords.speed != null && isFinite(p.coords.speed)) ? p.coords.speed : null, rumbo: (p.coords.heading != null && isFinite(p.coords.heading)) ? p.coords.heading : null };
  if (nav) nav.hist.push({ t: gps.fix.t, lng: gps.fix.lng, lat: gps.fix.lat });
  metricas.gpsUltimo = { acc: Math.round(p.coords.accuracy), hora: fechaHM() };
  if (map && mapaListo && map.getSource("gps")) map.getSource("gps").setData(geoGps());
  chipGps();
  if (nav) actualizarNavegacion();
  if (rumbo.activo && map) {
    if (usarRumboGps()) empujarRumbo(gps.fix.rumbo, 0.7);
    if (Date.now() - rumbo.libre > 8000) map.jumpTo({ center: [gps.fix.lng, gps.fix.lat] });   /* sigue tu posición, salvo que muevas el mapa a mano (se retoma a los 8 s) */
  }
  if (gps.primera && !nav) { gps.primera = false; map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 }); }
}
function gpsError(e) {
  var c = $("mp-chip-gps"); if (c) { c.className = "mp-chip mp-chip-btn rojo"; c.textContent = e.code === 1 ? "GPS sin permiso" : "GPS sin señal"; }
  anotarError("gps", e);
}
function gpsEncender() {
  if (!navigator.geolocation) { LC.toast("Este navegador no tiene GPS"); return; }
  if (gps.watch != null) return;
  gps.primera = true; gps.quiere = true; gps.apagadoManual = false; guardarJSON(LS_GPS_APAGADO, false);
  gps.watch = navigator.geolocation.watchPosition(gpsOk, gpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  var b = $("mp-gps"); if (b) b.classList.add("on");
  chipGps();
}
function gpsApagarManual() { gps.apagadoManual = true; guardarJSON(LS_GPS_APAGADO, true); gpsApagar(true); }
function gpsApagar(olvidar) {
  if (gps.watch != null) { try { navigator.geolocation.clearWatch(gps.watch); } catch (e) {} gps.watch = null; }
  if (olvidar) { gps.quiere = false; gps.fix = null; if (map && mapaListo && map.getSource("gps")) map.getSource("gps").setData(geoGps()); }
  var b = $("mp-gps"); if (b) b.classList.remove("on");
  chipGps();
}

/* ---------- estilo y mapa ---------- */
function rutaBase() { return location.origin + location.pathname.replace(/[^\/]*$/, ""); }
function vis(c) { return capasVis[c] ? "visible" : "none"; }
/* v2.72: nombres de lugares (toponimia) visibles por defecto; fondo satelital opcional (necesita conexión) */
function visTopo() { return capasVis.topo !== false; }
/* v2.73: color de las curvas de nivel elegible. "auto" usa marrón sobre el mapa y amarillo sobre el satélite. */
var CURVAS_COLORES = {
  marron: { rot: "Marrón", c: "#8a5a2b", t: "#6d4520", h: "#ffffff" },
  blanco: { rot: "Blanco", c: "#ffffff", t: "#ffffff", h: "rgba(0,0,0,0.75)" },
  amarillo: { rot: "Amarillo", c: "#ffd54f", t: "#ffe082", h: "rgba(0,0,0,0.75)" },
  naranja: { rot: "Naranja", c: "#ff9800", t: "#ffb74d", h: "rgba(0,0,0,0.75)" },
  negro: { rot: "Negro", c: "#222222", t: "#222222", h: "#ffffff" }
};
function paletaCurvas(sat) {
  var k = capasVis.curvasColor;
  if (!k || k === "auto" || !CURVAS_COLORES[k]) k = sat ? "amarillo" : "marron";
  return CURVAS_COLORES[k];
}
/* v2.74: posición de las etiquetas de los puntos (un botón las recorre: abajo, derecha, izquierda, arriba, automático sin superponer, ocultas) */
var LS_ETIQ = "libretacampo_mapa_etiq_v1";
var MODOS_ETIQ = ["abajo", "derecha", "izquierda", "arriba", "auto", "ocultas"];
var modoEtiq = (function () { var m = leerJSON(LS_ETIQ, "abajo"); return MODOS_ETIQ.indexOf(m) >= 0 ? m : "abajo"; })();
function propsEtiq(modo) {
  var P = { visibility: modo === "ocultas" ? "none" : "visible", "text-allow-overlap": modo !== "auto",
    "text-anchor": undefined, "text-offset": undefined, "text-variable-anchor": undefined, "text-radial-offset": undefined };
  if (modo === "derecha") { P["text-anchor"] = "left"; P["text-offset"] = [1.4, 0]; }
  else if (modo === "izquierda") { P["text-anchor"] = "right"; P["text-offset"] = [-1.4, 0]; }
  else if (modo === "arriba") { P["text-anchor"] = "bottom"; P["text-offset"] = [0, -1.4]; }
  else if (modo === "auto") { P["text-variable-anchor"] = ["right", "left", "top", "bottom"]; P["text-radial-offset"] = 1.5; }
  else { P["text-anchor"] = "top"; P["text-offset"] = ["case", ["==", ["get", "nota"], 1], ["literal", [0, 1.4]], ["literal", [0, 1.35]]]; }
  return P;
}
var LS_FONDO = "libretacampo_mapa_fondo_v1", LS_INTRO = "libretacampo_mapa_intro_v1";
var fondoSat = leerJSON(LS_FONDO, "sat") === "sat";   /* v2.88: el satélite (con conexión) es el fondo por defecto; los mapas sin conexión son opcionales */
function satActivo() { return fondoSat && online; }
var URL_SAT = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
var ATTR_SAT = '<a href="https://www.esri.com/" target="_blank" rel="noopener">Imagen © Esri, Maxar, Earthstar Geographics</a>';
function visSesion(id) { return !(capasVis.sesiones && capasVis.sesiones[id] === false); }
function visReg(id) { return !(capasVis.regs && capasVis.regs[id] === false); }
function idsOcultos() { return Object.keys(capasVis.regs || {}).filter(function (k) { return capasVis.regs[k] === false; }); }
/* v2.49: leyenda con filtro por tipo de punto. Todos visibles por defecto; capasVis.tipos[clase] === false oculta esa clase (puntos, tracks y recorridos). */
var LEYENDA = [
  { clase: "rec", letra: "R", nombre: "Recolección", forma: "circ" },
  { clase: "obs", letra: "O", nombre: "Observación (con su track)", forma: "circ" },
  { clase: "nota", letra: "N", nombre: "Nota general", forma: "rombo" },
  { clase: "otro", letra: "M", nombre: "Medición", forma: "circ" },
  { clase: "recorrido", letra: "〰", nombre: "Recorrido grabado", forma: "linea" }
];
function visClase(c) { return !(capasVis.tipos && capasVis.tipos[c] === false); }
function clasesOcultas() { return LEYENDA.filter(function (x) { return !visClase(x.clase); }).map(function (x) { return x.clase; }); }
function filtroPuntos() {
  var ids = LC.state.sesiones.filter(function (x) { return visSesion(x.id); }).map(function (x) { return x.id; });
  var f = ["in", ["get", "sesion"], ["literal", ids]], oc = idsOcultos(), co = clasesOcultas();
  var partes = ["all", f];
  if (oc.length) partes.push(["!", ["in", ["get", "id"], ["literal", oc]]]);   /* v2.44: registros que se ocultaron uno a uno desde "Mis puntos" */
  if (co.length) partes.push(["!", ["in", ["get", "clase"], ["literal", co]]]);
  return partes.length > 2 ? partes : f;
}
function construirLeyenda() {
  var cont = $("mp-leyenda"); if (!cont) return;
  cont.innerHTML = "";
  LEYENDA.forEach(function (x) {
    var b = el("button", { type: "button", class: "mp-ley mp-ley-" + x.forma + (visClase(x.clase) ? " on" : ""), "data-clase": x.clase, title: x.nombre + (visClase(x.clase) ? " (visible)" : " (oculto)"), "aria-pressed": visClase(x.clase) ? "true" : "false", "aria-label": x.nombre, texto: x.letra });
    b.onclick = function () {
      if (!capasVis.tipos) capasVis.tipos = {};
      if (visClase(x.clase)) capasVis.tipos[x.clase] = false; else delete capasVis.tipos[x.clase];
      guardarJSON(LS_CAPAS, capasVis);
      construirLeyenda(); aplicarFiltroPuntos();
      mostrarTipLeyenda(x.clase, x.nombre + (visClase(x.clase) ? ": visible" : ": oculto"));
    };
    cont.appendChild(b);
  });
  if (!$("mp-ley-tip")) cont.appendChild(el("div", { id: "mp-ley-tip" }));
}
/* v2.50: el aviso de la leyenda aparece un momento a la derecha de su ícono (antes era el aviso negro de abajo) */
var tipLeyTimer = null;
function mostrarTipLeyenda(clase, texto) {
  var cont = $("mp-leyenda"), tip = $("mp-ley-tip"); if (!cont || !tip) return;
  var b = cont.querySelector('[data-clase="' + clase + '"]'); if (!b) return;
  tip.textContent = texto; tip.style.top = (b.offsetTop + Math.max(0, (b.offsetHeight - 26) / 2)) + "px"; tip.style.display = "block";
  clearTimeout(tipLeyTimer); tipLeyTimer = setTimeout(function () { tip.style.display = "none"; }, 1500);
}
function filtroPuntosCirc() { return ["all", filtroPuntos(), ["==", ["get", "nota"], 0]]; }
function filtroTrack(recto) { return ["all", filtroPuntos(), ["==", ["get", "recto"], recto]]; }
function filtroPuntosNota() { return ["all", filtroPuntos(), ["==", ["get", "nota"], 1]]; }
function aplicarFiltroPuntos() {
  if (!map || !mapaListo) return;
  if (map.getLayer("recorridos-linea")) { map.setFilter("recorridos-casing", filtroPuntos()); map.setFilter("recorridos-linea", filtroPuntos()); }
  if (map.getLayer("tracks-casing")) { map.setFilter("tracks-casing", filtroTrack(0)); map.setFilter("tracks-linea", filtroTrack(0)); map.setFilter("tracks-recto", filtroTrack(1)); }
  if (map.getLayer("puntos-circ")) map.setFilter("puntos-circ", filtroPuntosCirc());
  if (map.getLayer("puntos-nota")) map.setFilter("puntos-nota", filtroPuntosNota());
  if (map.getLayer("puntos-texto")) map.setFilter("puntos-texto", ["all", filtroPuntos(), ["!=", ["get", "etq"], ""]]);
}

var ATTR_OSM = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>';
var ATTR_REL = '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">Relieve: Mapterhorn</a>';
/* v2.89: cada mapa descargado se puede activar o desactivar (capasVis.mapasOff[id] = true cuando está desactivado). Solo los activos se dibujan. */
function mapaActivo(id) { return !(capasVis.mapasOff && capasVis.mapasOff[id]); }
function idsActivos() { return Object.keys(inst).filter(mapaActivo); }
function mapasOrdenados() { return Object.keys(inst).sort().filter(mapaActivo).map(function (id) { return inst[id]; }); }
function firmaMapas() { return Object.keys(inst).sort().filter(mapaActivo).map(function (id) { return id + "@" + inst[id].version + "@" + inst[id].fecha; }).join("|") + (satActivo() ? "|sat" : "") + (callesActivo() ? "|cal" : ""); }
/* v2.47: el estilo junta TODOS los mapas instalados. Cada mapa aporta su fuente "base<k>" y una copia de las capas del estilo base
   (intercaladas por orden, para que el apilado sea correcto entre mapas vecinos). El relieve y las curvas son una sola fuente que lee de todos los paquetes. */
/* v2.72: toponimia. Los paquetes ya traen los nombres (capas "places" y "pois"); aquí se dibujan: localidades, áreas protegidas, cerros y puntos de interés. */
var TOPO_NAT = ["nature_reserve", "national_park", "protected_area", "park", "forest", "garden", "beach", "wetland", "picnic_site", "camp_site"];
var TOPO_CERRO = ["peak", "volcano", "viewpoint", "saddle"];
var TOPO_AGUA = ["marina", "slipway", "swimming_area", "fishing", "drinking_water", "water_point", "watering_place"];
function capasToponimia(k, sat) {
  var suf = k > 0 ? "~" + k : "", src = "base" + k;
  var ref = ESTILO_BASE.filter(function (l) { return l.id === "places_subplace"; })[0];
  var NOM = (ref && ref.layout && ref.layout["text-field"]) || ["coalesce", ["get", "name:es"], ["get", "name"]];
  var v = visTopo() ? "visible" : "none";
  var kd = ["get", "kind_detail"], kind = ["get", "kind"];
  var esCiudad = ["in", kd, ["literal", ["city", "town"]]];
  var colTxt = sat ? "#ffffff" : ["case", ["in", kind, ["literal", TOPO_NAT]], "#1e5e22", ["in", kind, ["literal", TOPO_CERRO]], "#6d4520", ["in", kind, ["literal", TOPO_AGUA]], "#16578f", "#41505a"];
  var colPunto = ["case", ["in", kind, ["literal", TOPO_NAT]], "#2e7d32", ["in", kind, ["literal", TOPO_CERRO]], "#8a5a2b", ["in", kind, ["literal", TOPO_AGUA]], "#1f6fb2", "#5f6b73"];
  var halo = sat ? "rgba(0,0,0,0.8)" : "#ffffff";
  var visibleDesde = [">=", ["zoom"], ["+", ["get", "min_zoom"], 0]];
  var fPoi = ["all", visibleDesde, ["any", ["has", "name"], ["in", kind, ["literal", TOPO_CERRO]]]];
  return [
    { id: "topo-localidades" + suf, type: "symbol", source: src, "source-layer": "places", minzoom: 7, filter: ["==", kind, "locality"],
      layout: { visibility: v, "text-field": NOM, "symbol-sort-key": ["coalesce", ["get", "sort_key"], ["get", "min_zoom"], 0], "text-padding": 4,
        "text-font": ["case", esCiudad, ["literal", ["NotoSans-Medium"]], ["literal", ["NotoSans-Regular"]]],
        "text-size": ["interpolate", ["linear"], ["zoom"], 7, ["case", esCiudad, 12, 10], 14, ["case", esCiudad, 17, ["==", kd, "village"], 14, 12.5]] },
      paint: { "text-color": sat ? "#ffffff" : "#1f2a30", "text-halo-color": halo, "text-halo-width": 1.6 } },
    { id: "topo-poi-punto" + suf, type: "circle", source: src, "source-layer": "pois", minzoom: 11, filter: fPoi,
      layout: { visibility: v },
      paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 4.5], "circle-color": colPunto, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 } },
    { id: "topo-poi-texto" + suf, type: "symbol", source: src, "source-layer": "pois", minzoom: 11, filter: ["all", visibleDesde, ["has", "name"]],
      layout: { visibility: v, "text-field": NOM, "symbol-sort-key": ["get", "min_zoom"], "text-max-width": 8,
        "text-font": ["case", ["in", kind, ["literal", TOPO_NAT]], ["literal", ["NotoSans-Italic"]], ["literal", ["NotoSans-Regular"]]],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 10, 17, 13],
        "text-variable-anchor": ["top", "bottom", "left", "right"], "text-radial-offset": 0.7 },
      paint: { "text-color": colTxt, "text-halo-color": halo, "text-halo-width": 1.5 } }
  ];
}

/* ---------- v2.93: calles y lugares en línea (OpenFreeMap, datos de OpenStreetMap) ----------
   Capa vectorial gratuita, sin llave, que se dibuja donde NO hay un mapa descargado y con conexión. Los mapas descargados tienen prioridad:
   las calles, nombres y lugares en línea se ocultan dentro del recuadro de cada mapa activo. Sin conexión no se dibuja nada de esto. */
var URL_CALLES = "https://tiles.openfreemap.org/planet";
var ATTR_CALLES = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Datos de <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
var LS_CALLES = "libretacampo_mapa_calles_tj_v1", teselasCalles = null, attrCalles = ATTR_CALLES, maxzCalles = 14;
/* El TileJSON se pide aparte y con límite de tiempo: si la fuente se declarara con "url" y esa petición no respondiera (señal débil con el teléfono «en línea»),
   el mapa nunca terminaría de cargar. Con las teselas ya resueltas, un fallo de red solo deja las calles sin dibujar. */
async function resolverCalles() {
  if (teselasCalles || !online || capasVis.calles === false) return;
  var tj = null;
  try {
    var ac = new AbortController(), to = setTimeout(function () { ac.abort(); }, 8000);
    var r = await fetch(URL_CALLES, { signal: ac.signal, cache: "no-cache" }); clearTimeout(to);
    if (r.ok) { tj = await r.json(); guardarJSON(LS_CALLES, { t: Date.now(), tj: { tiles: tj.tiles, maxzoom: tj.maxzoom, attribution: tj.attribution } }); }
  } catch (e) { /* sin respuesta: se intenta con la copia reciente */ }
  if (!tj || !tj.tiles || !tj.tiles.length) { var c = leerJSON(LS_CALLES, null); if (c && c.tj && c.tj.tiles && Date.now() - c.t < 12 * 3600 * 1000) tj = c.tj; }
  if (!tj || !tj.tiles || !tj.tiles.length) return;
  teselasCalles = tj.tiles; maxzCalles = tj.maxzoom || 14;
  if (map && mapaListo && LC.state.currentView === "mapa" && estiloFirma !== firmaMapas()) aplicarMapas().then(function () { refrescarPuntos(); });
}
function callesActivo() { return online && capasVis.calles !== false && !!teselasCalles; }
function geoAreasMulti() {
  var cs = [];
  mapasOrdenados().forEach(function (m) { var a = m.area; if (a && a.length === 4) cs.push([[[a[0], a[1]], [a[2], a[1]], [a[2], a[3]], [a[0], a[3]], [a[0], a[1]]]]); });
  return cs.length ? { type: "MultiPolygon", coordinates: cs } : null;
}
function capasCalles(sat) {
  var mp = geoAreasMulti(), S = "calles", NOM = ["coalesce", ["get", "name:es"], ["get", "name"]];
  var vL = capasVis.rutas !== false ? "visible" : "none", vT = visTopo() ? "visible" : "none";
  function F(base) { var f = ["all"].concat(base); if (mp) f.push(["!", ["within", mp]]); return f; }
  var LINEA = ["==", ["geometry-type"], "LineString"], PUNTO = ["==", ["geometry-type"], "Point"];
  var MAY = ["motorway", "trunk", "primary", "secondary"], MEN = ["tertiary", "minor", "service"], SEN = ["path", "track", "pedestrian"];
  var col = {
    cM: sat ? "rgba(0,0,0,0.55)" : "#c9a45a", fM: sat ? "#ffe9a8" : "#f8d58a",
    cm: sat ? "rgba(0,0,0,0.45)" : "#b9b9b9", fm: sat ? "rgba(255,255,255,0.92)" : "#ffffff",
    fs: sat ? "#ffd9a0" : "#b5651d",
    txt: sat ? "#ffffff" : "#2b2b2b", halo: sat ? "rgba(0,0,0,0.85)" : "#ffffff"
  };
  function ancho(extra, a, b, c, d) { return ["interpolate", ["linear"], ["zoom"], 6, a, 12, b, 15, c, 18, d]; }
  var L = [];
  L.push({ id: "calles-mayores-borde", type: "line", source: S, "source-layer": "transportation", minzoom: 6, filter: F([LINEA, ["in", ["get", "class"], ["literal", MAY]]]),
    layout: { visibility: vL, "line-cap": "round", "line-join": "round" }, paint: { "line-color": col.cM, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 4.5, 15, 8, 18, 18] } });
  L.push({ id: "calles-menores-borde", type: "line", source: S, "source-layer": "transportation", minzoom: 12, filter: F([LINEA, ["in", ["get", "class"], ["literal", MEN]]]),
    layout: { visibility: vL, "line-cap": "round", "line-join": "round" }, paint: { "line-color": col.cm, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 1.8, 15, 4.5, 18, 13] } });
  L.push({ id: "calles-mayores", type: "line", source: S, "source-layer": "transportation", minzoom: 6, filter: F([LINEA, ["in", ["get", "class"], ["literal", MAY]]]),
    layout: { visibility: vL, "line-cap": "round", "line-join": "round" }, paint: { "line-color": col.fM, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.8, 12, 2.8, 15, 6, 18, 15] } });
  L.push({ id: "calles-menores", type: "line", source: S, "source-layer": "transportation", minzoom: 12, filter: F([LINEA, ["in", ["get", "class"], ["literal", MEN]]]),
    layout: { visibility: vL, "line-cap": "round", "line-join": "round" }, paint: { "line-color": col.fm, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.9, 15, 3, 18, 10] } });
  L.push({ id: "calles-senderos", type: "line", source: S, "source-layer": "transportation", minzoom: 13, filter: F([LINEA, ["in", ["get", "class"], ["literal", SEN]]]),
    layout: { visibility: vL, "line-cap": "butt", "line-join": "round" }, paint: { "line-color": col.fs, "line-width": ["interpolate", ["linear"], ["zoom"], 13, 1, 17, 2.4], "line-dasharray": [2, 1.5] } });
  var paintTxt = { "text-color": col.txt, "text-halo-color": col.halo, "text-halo-width": 1.6 };
  function nombreVia(id, minz, clases, tam) {
    return { id: id, type: "symbol", source: S, "source-layer": "transportation_name", minzoom: minz, filter: F([LINEA, ["in", ["get", "class"], ["literal", clases]], ["has", "name"]]),
      layout: { visibility: vT, "symbol-placement": "line", "text-field": NOM, "text-font": ["NotoSans-Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], minz, tam[0], 18, tam[1]], "symbol-spacing": 220, "text-padding": 2, "text-max-angle": 40 }, paint: paintTxt };
  }
  L.push(nombreVia("calles-nombres-mayores", 11, MAY, [10, 14]));
  L.push(nombreVia("calles-nombres-menores", 13.5, MEN.concat(SEN), [10, 13.5]));
  L.push({ id: "calles-numeros", type: "symbol", source: S, "source-layer": "housenumber", minzoom: 17, filter: F([PUNTO, ["has", "housenumber"]]),
    layout: { visibility: vT, "text-field": ["get", "housenumber"], "text-font": ["NotoSans-Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 17, 10, 19, 13], "text-padding": 1 },
    paint: { "text-color": sat ? "#ffe9a8" : "#7a4a00", "text-halo-color": col.halo, "text-halo-width": 1.3 } });
  function lugar(id, minz, clases, tam, fuente) {
    return { id: id, type: "symbol", source: S, "source-layer": "place", minzoom: minz, filter: F([PUNTO, ["in", ["get", "class"], ["literal", clases]], ["has", "name"]]),
      layout: { visibility: vT, "text-field": NOM, "text-font": [fuente], "text-size": ["interpolate", ["linear"], ["zoom"], minz, tam[0], 16, tam[1]], "text-padding": 4, "text-max-width": 8, "symbol-sort-key": ["coalesce", ["get", "rank"], 99] },
      paint: { "text-color": col.txt, "text-halo-color": col.halo, "text-halo-width": 1.7 } };
  }
  L.push(lugar("calles-lugares-grandes", 5, ["city", "town"], [12, 19], "NotoSans-Medium"));
  L.push(lugar("calles-lugares-medios", 9, ["village", "suburb", "quarter"], [11, 15], "NotoSans-Regular"));
  L.push(lugar("calles-lugares-barrios", 12, ["neighbourhood", "hamlet", "isolated_dwelling"], [10, 13], "NotoSans-Italic"));
  var ptoF = F([PUNTO, ["has", "name"], ["any", ["<=", ["get", "rank"], 25], [">=", ["zoom"], 16]]]);
  L.push({ id: "calles-poi-punto", type: "circle", source: S, "source-layer": "poi", minzoom: 14, filter: ptoF, layout: { visibility: vT },
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 14, 2.2, 18, 4.5], "circle-color": sat ? "#ffffff" : "#5f6b73", "circle-stroke-color": sat ? "#000000" : "#ffffff", "circle-stroke-width": 1 } });
  L.push({ id: "calles-poi-texto", type: "symbol", source: S, "source-layer": "poi", minzoom: 14.5, filter: ptoF,
    layout: { visibility: vT, "text-field": NOM, "text-font": ["NotoSans-Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 14.5, 10, 18, 13], "text-max-width": 8, "text-variable-anchor": ["top", "bottom", "left", "right"], "text-radial-offset": 0.7, "symbol-sort-key": ["coalesce", ["get", "rank"], 99] },
    paint: { "text-color": sat ? "#ffffff" : "#41505a", "text-halo-color": col.halo, "text-halo-width": 1.5 } });
  return L;
}
/* v2.73: zona de cada mapa instalado, visible desde lejos (recuadro, punto central y nombre) para ubicarlos en la vista general */
var COL_AREA = "#00838f";
function geoAreas() {
  var fs = [];
  mapasOrdenados().forEach(function (m) {
    var a = m.area; if (!a || a.length !== 4) return;
    fs.push({ type: "Feature", properties: { id: m.id, nombre: nombreCorto(m.nombre) }, geometry: { type: "Polygon", coordinates: [[[a[0], a[1]], [a[2], a[1]], [a[2], a[3]], [a[0], a[3]], [a[0], a[1]]]] } });
    fs.push({ type: "Feature", properties: { id: m.id, nombre: nombreCorto(m.nombre), centro: 1 }, geometry: { type: "Point", coordinates: [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2] } });
  });
  return { type: "FeatureCollection", features: fs };
}
function capasAreas() {
  var ES_POL = ["==", ["geometry-type"], "Polygon"], ES_PTO = ["==", ["geometry-type"], "Point"];
  return [
    { id: "areas-relleno", type: "fill", source: "areas", filter: ES_POL, paint: { "fill-color": COL_AREA, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.3, 10, 0.14, 13, 0] } },
    { id: "areas-borde-base", type: "line", source: "areas", filter: ES_POL, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 4, 12, 6], "line-opacity": 0.85 } },
    { id: "areas-borde", type: "line", source: "areas", filter: ES_POL, paint: { "line-color": COL_AREA, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2, 12, 3], "line-dasharray": [3, 2] } },
    { id: "areas-centro", type: "circle", source: "areas", filter: ES_PTO, maxzoom: 11, paint: { "circle-radius": 8, "circle-color": COL_AREA, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 } },
    { id: "areas-texto", type: "symbol", source: "areas", filter: ES_PTO, maxzoom: 14,
      layout: { "text-field": ["get", "nombre"], "text-font": ["NotoSans-Medium"], "text-size": 13, "text-anchor": "top", "text-offset": [0, 1.2], "text-allow-overlap": true, "text-max-width": 10 },
      paint: { "text-color": "#004d55", "text-halo-color": "#ffffff", "text-halo-width": 2.2 } }
  ];
}
/* v2.89: "rutas" = caminos, senderos y vías férreas del mapa base. Los ríos y los límites no se cuentan. */
function esRutaBase(L) { return !!L && L.type === "line" && /^roads_/.test(String(L.id).replace(/~\d+$/, "")); }
function aplicarVisBase() {
  if (!map || !mapaListo) return;
  var tipo = {}; ESTILO_BASE.forEach(function (l) { tipo[l.id] = l; });
  map.getStyle().layers.forEach(function (l) {
    var b = tipo[l.id.replace(/~\d+$/, "")], v = null;
    if (/^calles-/.test(l.id)) v = l.type === "line" ? (capasVis.rutas !== false ? "visible" : "none") : (visTopo() ? "visible" : "none");
    else if (/^topo-/.test(l.id) || (b && b.type === "symbol")) v = visTopo() ? "visible" : "none";
    else if (b && esRutaBase(b)) v = capasVis.rutas !== false ? "visible" : "none";
    if (v) map.setLayoutProperty(l.id, "visibility", v);
  });
  botonesBase();
}
function botonesBase() {
  var hay = idsActivos().length > 0 || callesActivo();
  [["mp-rutas", capasVis.rutas !== false], ["mp-nombres", visTopo()]].forEach(function (x) {
    var b = $(x[0]); if (!b) return;
    b.style.display = hay ? "" : "none"; b.classList.toggle("on", x[1]);
  });
}
function alternarRutas() { capasVis.rutas = capasVis.rutas === false; guardarJSON(LS_CAPAS, capasVis); aplicarVisBase(); LC.toast(capasVis.rutas === false ? "Rutas del mapa ocultas" : "Rutas del mapa visibles", 1800); }
function alternarNombres() { capasVis.topo = !visTopo(); guardarJSON(LS_CAPAS, capasVis); aplicarVisBase(); LC.toast(visTopo() ? "Topónimos visibles" : "Topónimos ocultos", 1800); }
function construirEstilo(sinMapas) {
  var estilo = { version: 8, glyphs: rutaBase() + RUTA_MAPA + "fuentes/{fontstack}/{range}.pbf", sources: {}, layers: [] };
  var ms = sinMapas ? [] : mapasOrdenados();
  var bases = ms.filter(function (m) { return archivoTipo(m, "base"); });
  var rels = ms.filter(function (m) { return archivoTipo(m, "relieve"); });
  var capas = [], extra = [], etiquetas = [], topo = [];
  var sat = satActivo();
  if (sat) estilo.sources.sat = { type: "raster", tiles: [URL_SAT], tileSize: 256, maxzoom: 19, attribution: ATTR_SAT };
  var capaSat = { id: "satelite", type: "raster", source: "sat", paint: { "raster-fade-duration": 0 } };
  if (rels.length) {
    estilo.sources.dem = { type: "raster-dem", tiles: [demSource.sharedDemProtocolUrl], tileSize: 512, maxzoom: 12, encoding: "terrarium", attribution: ATTR_REL };
    estilo.sources.curvas = { type: "vector", maxzoom: 15, tiles: [demSource.contourProtocolUrl({
      thresholds: { 10: [100, 500], 11: [50, 250], 12: [20, 100], 13: [20, 100], 14: [10, 50], 15: [10, 50] },
      contourLayer: "contours", elevationKey: "ele", levelKey: "level", extent: 4096, buffer: 1 })] };
    extra.push({ id: "relieve-sombra", type: "hillshade", source: "dem", layout: { visibility: vis("sombra") },
      paint: { "hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#3b3f45", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#6b7078" } });
    extra.push({ id: "curvas-linea", type: "line", source: "curvas", "source-layer": "contours", layout: { visibility: vis("curvas") },
      paint: { "line-color": paletaCurvas(sat).c, "line-opacity": sat ? 0.95 : 0.75, "line-width": sat ? ["match", ["get", "level"], 1, 1.7, 0.9] : ["match", ["get", "level"], 1, 1.4, 0.6] } });
    etiquetas.push({ id: "curvas-texto", type: "symbol", source: "curvas", "source-layer": "contours", filter: [">", ["get", "level"], 0],
      layout: { visibility: vis("curvas"), "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "ele"]], " m"], "text-font": ["NotoSans-Regular"], "text-size": 11 },
      paint: { "text-color": paletaCurvas(sat).t, "text-halo-color": paletaCurvas(sat).h, "text-halo-width": 1.5 } });
  }
  if (bases.length) {
    bases.forEach(function (m, k) {
      var fu = { type: "vector", tiles: ["lcmap://" + archivoTipo(m, "base") + "/{z}/{x}/{y}"], minzoom: 0, maxzoom: 15, bounds: m.area };
      if (k === 0) fu.attribution = ATTR_OSM;
      estilo.sources["base" + k] = fu;
    });
    if (sat) extra = extra.filter(function (x) { return x.id !== "relieve-sombra"; });   /* la imagen ya trae su propio relieve */
    var idx = ESTILO_BASE.length;
    for (var i = 0; i < ESTILO_BASE.length; i++) { if (ESTILO_BASE[i].type === "line" && !/^water/.test(ESTILO_BASE[i].id)) { idx = i; break; } }
    for (var j = 0; j < ESTILO_BASE.length; j++) {
      if (j === idx) capas = capas.concat(extra);
      bases.forEach(function (m, k) {
        var L = ESTILO_BASE[j];
        if (L.type === "background" && k > 0) return;
        if (sat && L.type === "fill") return;   /* con satélite se quitan los rellenos; quedan caminos, ríos y nombres encima */
        var c = JSON.parse(JSON.stringify(L));
        if (L.id === "water_waterway_label") c.minzoom = 11;   /* v2.72: nombres de quebradas y ríos desde más lejos */
        if (L.id === "roads_labels_minor") c.minzoom = 14;   /* v2.93: nombres de calles menores un nivel antes (los paquetes traen calles menores desde z14) */
        if (L.id === "address_label") c.minzoom = 17;   /* v2.93: números de casa un nivel antes */
        if ((L.type === "symbol" && !visTopo()) || (esRutaBase(L) && capasVis.rutas === false)) c.layout = Object.assign({}, c.layout, { visibility: "none" });   /* v2.89: botones Nombres y Rutas */
        if (sat && L.type === "symbol") c.paint = Object.assign({}, c.paint, { "text-color": "#ffffff", "text-halo-color": "rgba(0,0,0,0.8)", "text-halo-width": 1.6 });
        if (L.source === "base") c.source = "base" + k;
        if (k > 0) c.id = L.id + "~" + k;
        capas.push(c);
        if (L.type === "background" && k === 0 && sat) capas.push(capaSat);
      });
    }
    if (idx >= ESTILO_BASE.length) capas = capas.concat(extra);
    bases.forEach(function (m, k) { topo = topo.concat(capasToponimia(k, sat)); });
    capas = capas.concat(etiquetas, topo);
  } else {
    capas = [{ id: "fondo", type: "background", paint: { "background-color": "#eef0ec" } }].concat(sat ? [capaSat] : [], extra, etiquetas);
  }
  if (callesActivo()) {   /* v2.93: calles y lugares en línea, bajo los datos propios y fuera de los mapas descargados */
    estilo.sources.calles = { type: "vector", tiles: teselasCalles, minzoom: 0, maxzoom: maxzCalles, attribution: ATTR_CALLES };
    capas = capas.concat(capasCalles(sat));
  }
  if (!sinMapas && ms.length) { estilo.sources.areas = { type: "geojson", data: geoAreas() }; capas = capas.concat(capasAreas()); }
  estilo.sources.capas = { type: "geojson", data: geoCapas() };
  var COL = ["coalesce", ["get", "_color"], ["match", ["get", "_origen"], "local", COL_LOC, COL_CAT]];
  capas.push({ id: "capas-pol-relleno", type: "fill", source: "capas", filter: filtroCapas("capas-pol-relleno"), paint: { "fill-color": COL, "fill-opacity": 0.07 } });
  capas.push({ id: "capas-pol-borde", type: "line", source: "capas", filter: filtroCapas("capas-pol-borde"), paint: { "line-color": COL, "line-width": 2, "line-dasharray": [3, 2] } });
  capas.push({ id: "capas-lineas", type: "line", source: "capas", filter: filtroCapas("capas-lineas"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COL, "line-width": 2.5 } });
  capas.push({ id: "capas-lineas-texto", type: "symbol", source: "capas", filter: filtroCapas("capas-lineas-texto"),
    layout: { "symbol-placement": "line", "text-field": ["get", "nombre"], "text-font": ["NotoSans-Italic"], "text-size": 11 },
    paint: { "text-color": COL, "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
  capas.push({ id: "capas-estaciones", type: "symbol", source: "capas", filter: filtroCapas("capas-estaciones"),
    layout: { "icon-image": ["coalesce", ["get", "_icono"], ["match", ["get", "_origen"], "local", "rombo-local", "rombo-cat"]], "icon-size": ["coalesce", ["get", "_tam"], 0.55], "icon-allow-overlap": true,
      "text-field": ["case", ["==", ["get", "_etq"], 0], "", ["coalesce", ["get", "nombre"], ["get", "estacion"], ""]], "text-font": ["NotoSans-Medium"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": "#222222", "text-halo-color": "#ffffff", "text-halo-width": 1.8 } });
  estilo.sources.puntos = { type: "geojson", data: geoPuntos() };
  estilo.sources.gps = { type: "geojson", data: geoGps() };
  estilo.sources.resaltado = { type: "geojson", data: geoResaltado() };
  estilo.sources.nav = { type: "geojson", data: geoNav() };
  estilo.sources.tracks = { type: "geojson", data: geoTracks() };
  estilo.sources.vivo = { type: "geojson", data: geoVivo() };
  estilo.sources.recorridos = { type: "geojson", data: geoRecorridos() };
  /* v2.45: recorridos grabados desde el mapa: línea larga discontinua en el color de su sesión (roja mientras se graba), debajo de los tracks de Observación */
  capas.push({ id: "recorridos-casing", type: "line", source: "recorridos", filter: filtroPuntos(), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 5.5, "line-opacity": 0.75 } });
  capas.push({ id: "recorridos-linea", type: "line", source: "recorridos", filter: filtroPuntos(), layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": ["case", ["==", ["get", "grabando"], 1], "#b5473a", ["get", "color"]], "line-width": 3, "line-dasharray": [5, 1.5] } });
  /* v2.44: tracks de Observación (debajo de los puntos). Con borde blanco para que se lean sobre el relieve. */
  capas.push({ id: "tracks-casing", type: "line", source: "tracks", filter: filtroTrack(0), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.8 } });
  capas.push({ id: "tracks-linea", type: "line", source: "tracks", filter: filtroTrack(0), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 3 } });
  capas.push({ id: "tracks-recto", type: "line", source: "tracks", filter: filtroTrack(1), layout: { "line-cap": "butt" }, paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-dasharray": [2, 2] } });
  capas.push({ id: "vivo-casing", type: "line", source: "vivo", filter: ["==", ["get", "tipo"], "linea"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.85 } });
  capas.push({ id: "vivo-linea", type: "line", source: "vivo", filter: ["==", ["get", "tipo"], "linea"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "color"], "line-width": 4 } });
  capas.push({ id: "vivo-inicio", type: "symbol", source: "vivo", filter: ["==", ["get", "tipo"], "inicio"],
    layout: { "icon-image": ["concat", "obs-", ["get", "color"]], "icon-size": TAM_CIRC[1], "icon-allow-overlap": true, "icon-ignore-placement": true } });
  /* v2.44: Recolección = círculo con R, Observación = círculo con O (inicio y término), otros = círculo liso. Se mantiene el id "puntos-circ". */
  capas.push({ id: "puntos-circ", type: "symbol", source: "puntos", filter: filtroPuntosCirc(),
    layout: { "icon-image": ["concat", ["match", ["get", "clase"], "rec", "rec-", "obs", "obs-", "pt-"], ["get", "color"]],
      "icon-size": ["case", ["==", ["get", "activa"], 1], TAM_CIRC[1], TAM_CIRC[0]], "icon-allow-overlap": true, "icon-ignore-placement": true } });
  /* v2.43/v2.44: las Notas generales (puntos de referencia o eventos) se dibujan como un rombo con la letra N, en el color de su sesión, de tamaño parecido al de los círculos */
  capas.push({ id: "puntos-nota", type: "symbol", source: "puntos", filter: filtroPuntosNota(),
    layout: { "icon-image": ["concat", "nota-", ["get", "color"]], "icon-size": ["case", ["==", ["get", "activa"], 1], TAM_ROMBO[1], TAM_ROMBO[0]], "icon-allow-overlap": true, "icon-ignore-placement": true } });
  capas.push({ id: "puntos-texto", type: "symbol", source: "puntos", filter: ["all", filtroPuntos(), ["!=", ["get", "etq"], ""]],
    layout: (function () {
      var L = { "text-field": ["get", "etq"], "text-font": ["NotoSans-Medium"], "text-size": ["case", ["==", ["get", "activa"], 1], 13, 10] }, P = propsEtiq(modoEtiq);
      Object.keys(P).forEach(function (k) { if (P[k] !== undefined) L[k] = P[k]; });
      return L;
    })(),
    paint: { "text-color": "#222222", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  /* v2.58: punto marcado a mano con un toque sostenido */
  /* v2.76: medición con varios puntos temporales: línea que los une, rótulo de cada tramo y número de cada punto */
  capas.push({ id: "nav-medida", type: "line", source: "nav", filter: ["==", ["get", "tipo"], "medida"], layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["case", ["==", ["get", "ok"], 1], "#9aa59d", "#d64545"], "line-width": 3, "line-opacity": ["case", ["==", ["get", "ok"], 1], 0.55, 0.9] } });
  capas.push({ id: "nav-manual-halo", type: "circle", source: "nav", filter: ["==", ["get", "tipo"], "manual"],
    paint: { "circle-radius": ["case", ["==", ["get", "sel"], 1], 20, ["==", ["get", "act"], 1], 19, 15], "circle-color": ["case", ["==", ["get", "ok"], 1], "#9aa59d", ["==", ["get", "act"], 1], "#c9962c", "#d64545"], "circle-opacity": ["case", ["==", ["get", "ok"], 1], 0.12, 0.24] } });
  capas.push({ id: "nav-manual", type: "circle", source: "nav", filter: ["==", ["get", "tipo"], "manual"],
    paint: { "circle-radius": 10, "circle-color": ["case", ["==", ["get", "ok"], 1], "#9aa59d", "#d64545"], "circle-opacity": ["case", ["==", ["get", "ok"], 1], 0.6, 1],
      "circle-stroke-color": ["case", ["==", ["get", "act"], 1], "#c9962c", "#ffffff"], "circle-stroke-opacity": ["case", ["==", ["get", "ok"], 1], 0.6, 1], "circle-stroke-width": ["case", ["==", ["get", "sel"], 1], 4, ["==", ["get", "act"], 1], 4, 2.5] } });
  capas.push({ id: "nav-manual-n", type: "symbol", source: "nav", filter: ["==", ["get", "tipo"], "manual"],
    layout: { "text-field": ["case", ["==", ["get", "ok"], 1], ["concat", "✓", ["get", "n"]], ["get", "n"]], "text-font": ["NotoSans-Medium"], "text-size": ["case", ["==", ["get", "ok"], 1], 10, 11], "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#ffffff", "text-opacity": ["case", ["==", ["get", "ok"], 1], 0.85, 1] } });
  capas.push({ id: "nav-tramo", type: "symbol", source: "nav", filter: ["==", ["get", "tipo"], "tramo"],
    layout: { "text-field": ["get", "etq"], "text-font": ["NotoSans-Medium"], "text-size": 11, "text-offset": [0, -1.1], "text-allow-overlap": true },
    paint: { "text-color": "#a32626", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  capas.push({ id: "nav-linea", type: "line", source: "nav", filter: ["==", ["get", "tipo"], "linea"], layout: { "line-cap": "round" },
    paint: { "line-color": "#c9962c", "line-width": 3, "line-dasharray": [2, 2] } });
  capas.push({ id: "nav-destino", type: "circle", source: "nav", filter: ["==", ["get", "tipo"], "destino"],
    paint: { "circle-radius": 15, "circle-color": "rgba(201,150,44,0.18)", "circle-stroke-color": "#c9962c", "circle-stroke-width": 4 } });
  capas.push({ id: "resaltado-anillo", type: "circle", source: "resaltado",
    paint: { "circle-radius": 19, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#c9962c", "circle-stroke-width": 4 } });
  capas.push({ id: "gps-precision", type: "fill", source: "gps", filter: ["==", ["get", "tipo"], "precision"], paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 } });
  capas.push({ id: "gps-precision-borde", type: "line", source: "gps", filter: ["==", ["get", "tipo"], "precision"], paint: { "line-color": ["get", "color"], "line-opacity": 0.55, "line-width": 1.5 } });
  /* v2.55: halo + punto más grandes y con borde oscuro, para distinguirlos sobre cualquier fondo. El punto es la posición exacta del GPS. */
  capas.push({ id: "gps-halo", type: "circle", source: "gps", filter: ["==", ["get", "tipo"], "punto"],
    paint: { "circle-radius": 17, "circle-color": ["get", "color"], "circle-opacity": 0.28, "circle-blur": 0.4 } });
  capas.push({ id: "gps-punto", type: "circle", source: "gps", filter: ["==", ["get", "tipo"], "punto"],
    paint: { "circle-radius": 9, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3.5 } });
  capas.push({ id: "gps-centro", type: "circle", source: "gps", filter: ["==", ["get", "tipo"], "punto"],
    paint: { "circle-radius": 2.2, "circle-color": "#ffffff" } });
  estilo.layers = capas;
  return estilo;
}

function crearMapa() {
  map = new maplibregl.Map({
    container: "mp-mapa", style: construirEstilo(true), center: [-72.59, -38.66], zoom: 5, maxZoom: 19,
    attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 0
  });
  map.on("rotate", function () { actualizarNorte(); pintarRosa(); });
  map.touchZoomRotate.disableRotation();   /* v2.91: fuera de la navegación el mapa no gira; durante la navegación con norte arriba sí */
  map.on("rotatestart", function (e) {
    if (e && e.originalEvent && rumbo.activo) { apagarRumbo(false); LC.toast("Giro manual: rumbo arriba apagado"); }
  });
  map.on("dragstart", function (e) { if (e && e.originalEvent) rumbo.libre = Date.now(); });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 100 }), "bottom-right");
  map.on("error", function (ev) {
    var msg = ev && ev.error && ev.error.message ? ev.error.message : "";
    if (/fuera del área|sin relieve/.test(msg) || (ev && ev.sourceId === "calles")) return;   /* v2.93: sin conexión las teselas en línea fallan sin avisar */
    anotarError("mapa", ev.error || ev);
  });
  map.on("styleimagemissing", function (e) {
    var mf = /^est-(rombo|circulo|cuadrado|triangulo)-([0-9a-f]{6})$/.exec(e.id);
    if (mf) { map.addImage(e.id, crearForma(mf[1], "#" + mf[2])); return; }
    if (e.id === "rombo-cat" || e.id === "rombo-local") map.addImage(e.id, crearRombo(e.id === "rombo-local" ? COL_LOC : COL_CAT));
    else if (/^nota-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(5), "N", true));
    else if (/^rec-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(4), "R", false));
    else if (/^obs-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(4), "O", false));
    else if (/^pt-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(3), "", false));
  });
  instalarPulsacionLarga();
  map.on("click", function (ev) {
    if (pulsacionReciente) { pulsacionReciente = false; return; }
    if (eleccion) { cerrarPanelPuntos(); panelTracks(false); marcarPuntoManual(ev.lngLat.lng, ev.lngLat.lat); return; }
    cerrarPanelPuntos(); panelTracks(false);
    if (resaltado) ponerResaltado(null);
    var p = ev.point, caja = [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]];
    if (puntosManuales.length && map.getLayer("nav-manual")) {
      var fm = map.queryRenderedFeatures(caja, { layers: ["nav-manual"] });
      if (fm.length) { seleccionarPuntoManual(parseInt(fm[0].properties.n, 10) - 1); return; }
    }
    if (map.getLayer("areas-centro")) {
      var fa = map.queryRenderedFeatures(caja, { layers: ["areas-centro"] });
      if (fa.length && inst[fa[0].properties.id]) { enfocarArea(inst[fa[0].properties.id].area, true); return; }
    }
    var lp = ["puntos-circ", "puntos-nota"].filter(function (l) { return map.getLayer(l); });
    if (lp.length) {
      var fs = map.queryRenderedFeatures(caja, { layers: lp });
      if (fs.length) { cerrarTarjeta(); LC.verRegistroExistente(fs[0].properties.id, "mapa"); return; }
    }
    var lr = ["recorridos-linea"].filter(function (l) { return map.getLayer(l); });
    if (lr.length) {
      var rs = map.queryRenderedFeatures(caja, { layers: lr });
      var rcSel = rs.length ? listaRecorridos().filter(function (x) { return x.id === rs[0].properties.id; })[0] : null;
      if (rcSel) {
        var t = $("mp-tarjeta"), ses = LC.sesionPorId(rcSel.sesionId); if (t) { tarjDesp.x = 0; tarjDesp.y = 0; t.style.transform = ""; }
        t.textContent = ""; t.appendChild(el("b", { texto: rcSel.nombre || "Recorrido" }));
        t.appendChild(el("div", { class: "mp-suave", texto: textoRecorrido(rcSel) + " · " + (rcSel.puntos || []).length + " puntos" }));
        if (ses) t.appendChild(el("div", { class: "mp-suave", texto: "Sesión: " + LC.nombreSesionMostrar(ses) }));
        t.style.display = "block"; return;
      }
    }
    var ls = ["capas-estaciones", "capas-lineas"].filter(function (l) { return map.getLayer(l); });
    if (ls.length) {
      var gs = map.queryRenderedFeatures(caja, { layers: ls });
      if (gs.length) { mostrarTarjetaCapa(gs[0], ev.lngLat); return; }
    }
    cerrarTarjeta();
  });
  ["puntos-circ", "puntos-nota"].forEach(function (cp) {
    map.on("mouseenter", cp, function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", cp, function () { map.getCanvas().style.cursor = ""; });
  });
  estiloFirma = "";
  map.once("load", function () { mapaListo = true; alMostrar(); });
  /* v2.93: si todas las teselas en línea fallan (señal débil), MapLibre no vuelve a dibujar y el evento «load» podría no llegar; el vigía fuerza un redibujo hasta que llegue. */
  var vigiaLoad = setInterval(function () { if (mapaListo || !map) { clearInterval(vigiaLoad); return; } if (map.loaded()) map.triggerRepaint(); }, 700);
}

async function aplicarMapas() {
  await cargarCapasMapa();
  return new Promise(function (res) {
    var t0 = performance.now();
    pmCache = {};
    relieveNombres = mapasOrdenados().map(function (m) { return { nombre: archivoTipo(m, "relieve"), area: m.area }; }).filter(function (r) { return r.nombre; });
    nuevoManagerDem();
    estiloFirma = firmaMapas();
    map.setStyle(construirEstilo(false), { diff: false });
    var vigiaIdle = setInterval(function () { if (map && map.loaded()) map.triggerRepaint(); }, 700);   /* v2.93: ver nota en crearMapa */
    var tope = setTimeout(function () { clearInterval(vigiaIdle); res(); }, 12000);
    map.once("idle", function () { clearInterval(vigiaIdle); clearTimeout(tope); metricas.aperturaMs = Math.round(performance.now() - t0); res(); });
    chipMapa();
  });
}
function centroEn(a) { var c = map.getCenter(); return !!a && c.lng >= a[0] && c.lng <= a[2] && c.lat >= a[1] && c.lat <= a[3]; }
function enfocarArea(a, animar) { map.fitBounds([[a[0], a[1]], [a[2], a[3]]], { padding: 20, animate: !!animar, duration: 700, maxZoom: 14 }); }
/* v2.47: "Ver en el mapa" desde el gestor o desde la pestaña Sesión: abre la pestaña Mapa y la lleva a la zona de ese mapa */
function verMapa(id) {
  if (!inst[id]) { LC.toast("Ese mapa no está instalado"); return; }
  if (!mapaActivo(id)) ponerMapaActivo(id, true, true);
  pendienteEnfoque = id;
  cerrarGestor();
  if (LC.state.currentView === "mapa") alMostrar(); else LC.irA("mapa");
}
function ponerMapaActivo(id, on, sinRender) {
  if (!inst[id]) return;
  if (!capasVis.mapasOff) capasVis.mapasOff = {};
  if (on) delete capasVis.mapasOff[id]; else capasVis.mapasOff[id] = true;
  guardarJSON(LS_CAPAS, capasVis);
  chipMapa(); actualizarAviso();
  if (!sinRender) renderGestor();
  if (map && mapaListo && LC.state.currentView === "mapa" && estiloFirma !== firmaMapas()) aplicarMapas().then(function () { refrescarPuntos(); });
}
function chipMapa() {
  var c = $("mp-sub"); if (!c) return;
  var total = Object.keys(inst).length, ids = idsActivos();
  c.textContent = !total ? (online && fondoSat ? "Fondo satelital" : "Sin mapas guardados") : !ids.length ? "Mapas desactivados" : ids.length === 1 ? nombreCorto(inst[ids[0]].nombre) : ids.length + " mapas";
  var r = $("mp-chip-red"); r.textContent = "Sin conexión"; r.style.display = online ? "none" : "inline-block";
  botonesBase();
}
function actualizarAviso() {
  var a = $("mp-aviso"); if (!a) return;
  var s = LC.sesionActiva() || LC.sesionEnPantalla(), txt = "";
  var total = Object.keys(inst).length, hay = idsActivos().length > 0, off = total > 0 && !hay;
  if (!hay && !online) txt = off ? "Sin conexión y con los mapas descargados desactivados: solo ves tus puntos sobre fondo liso. Actívalos en Mis mapas." : "Sin conexión y sin mapa guardado: solo ves tus puntos sobre fondo liso. Los mapas sin conexión se descargan con internet, antes de salir (botón Mapas).";
  else if (!hay && !fondoSat) txt = off ? "El satélite está apagado y los mapas descargados están desactivados: ves tus puntos sobre fondo liso. Activa 🛰️ Satélite o un mapa en Mis mapas." : "El fondo satelital está apagado y no hay mapas sin conexión: ves tus puntos sobre fondo liso. Activa 🛰️ Satélite o descarga un mapa en Mapas.";
  else if (hay && !online && fondoSat) txt = "Sin señal: se muestra el mapa guardado en lugar del satélite.";
  else if (s && s.mapaId && !inst[s.mapaId]) txt = "El mapa asociado a esta sesión no está instalado. Toca Mapas.";
  a.textContent = txt; a.style.display = txt ? "block" : "none";
}

async function alMostrar() {
  if (!LISTO) return;
  document.body.classList.add("vista-mapa");
  try {   /* v2.88: aviso único la primera vez que se abre el mapa */
    if (!localStorage.getItem(LS_INTRO) && !Object.keys(inst).length) {
      localStorage.setItem(LS_INTRO, "1");
      LC.toast("Con internet ves el fondo satelital. Para zonas sin señal, descarga un mapa en «Mapas» antes de salir.", 8000);
    }
  } catch (e) {}
  if (!map) { crearMapa(); return; }
  if (!mapaListo) return;
  if (estiloPromesa) await estiloPromesa;
  map.resize();
  var cambioEstilo = estiloFirma !== firmaMapas();
  if (cambioEstilo) await aplicarMapas();
  var sAct = LC.sesionActiva() || LC.sesionEnPantalla(), sid = sAct ? sAct.id : null;
  var cambioSesion = sid !== ultimaSesionVista; ultimaSesionVista = sid;
  var mSes = sAct && sAct.mapaId && inst[sAct.mapaId] ? inst[sAct.mapaId] : null;
  if (pendienteEnfoque) {
    var pm = inst[pendienteEnfoque]; pendienteEnfoque = null;
    if (pm && pm.area) enfocarArea(pm.area, true);
  } else if (!pendienteVer) {
    var objM = cambioSesion ? mSes : null;
    if (!objM && cambioEstilo && !mapasOrdenados().some(function (m) { return centroEn(m.area) && map.getZoom() >= 10; })) objM = mSes || mapasOrdenados()[0] || null;
    if (objM && objM.area && (!centroEn(objM.area) || map.getZoom() < 10)) enfocarArea(objM.area, false);
  }
  if (capasVis.anteriores === false && !capasVis.sesiones) {   /* v2.42: la opción antigua pasa a ser una casilla por sesión */
    capasVis.sesiones = {};
    LC.state.sesiones.forEach(function (x) { if (x.id !== LC.state.sesionActivaId) capasVis.sesiones[x.id] = false; });
    delete capasVis.anteriores; guardarJSON(LS_CAPAS, capasVis);
  }
  refrescarPuntos();
  clearInterval(vivoTimer); vivoTimer = setInterval(function () { refrescarVivo(false); refrescarRecorridos(false); chipGrab(); }, 2000);
  chipGrab(); actualizarNorte();
  actualizarAviso(); chipMapa(); chipGps();
  if (nav) actualizarNavegacion();
  if (gps.watch == null && (gps.quiere || !gps.apagadoManual)) gpsEncender();   /* v2.55: posición en vivo siempre visible al abrir el mapa */
  if (pendienteVer) {
    var pv = pendienteVer; pendienteVer = null;
    gps.primera = false;   /* v2.43: el primer dato del GPS no debe llevar la vista a la posición actual: se queda en el punto consultado */
    if (pendienteBounds) {
      var bb = new maplibregl.LngLatBounds(); pendienteBounds.forEach(function (x) { bb.extend(x); }); pendienteBounds = null;
      map.fitBounds(bb, { padding: 70, maxZoom: 17, duration: 600 });
    } else {
      map.easeTo({ center: [pv.lng, pv.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 600 });
      ponerResaltado(pv, !!retorno);   /* con retorno, el anillo se mantiene hasta que se toque el mapa */
    }
  }
  botonVolverRegistro();
}
function alOcultar() {
  clearInterval(vivoTimer); vivoTimer = null; apagarRumbo(false);
  if (eleccion) { var cbS = eleccion.alSalir; eleccion = null; puntosManuales = []; selManual = -1; if (map && mapaListo) refrescarNavMapa(); if (cbS) setTimeout(cbS, 0); }   /* v2.87: salir del mapa cancela la elección */
  retorno = null; botonVolverRegistro();
  cerrarTarjeta(); cerrarPanelPuntos();
  document.body.classList.remove("vista-mapa");
  if (gps.watch != null) gpsApagar(false);   /* ahorra batería; vuelve a encender al regresar */
}

/* ---------- v2.44: giro del mapa y modo "rumbo arriba" ---------- */
/* Rumbo (0 a 360, desde el norte) del teléfono a partir de alpha, beta y gamma. Usa el eje que apunta más cerca de la horizontal:
   la parte superior del teléfono si está casi plano, o la parte trasera si está en vertical. */
function rumboDispositivo(alpha, beta, gamma) {
  var r = Math.PI / 180, a = alpha * r, b = (beta || 0) * r, g = (gamma || 0) * r;
  var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  var arriba = [-sa * cb, ca * cb];                                              /* este, norte del eje superior */
  var atras = [-(ca * sg + sa * sb * cg), -(sa * sg - ca * sb * cg)];           /* este, norte del eje trasero (-z) */
  var v = Math.hypot(arriba[0], arriba[1]) >= Math.hypot(atras[0], atras[1]) ? arriba : atras;
  return (Math.atan2(v[0], v[1]) / r + 360) % 360;
}
function usarRumboGps() {
  var f = gps.fix;
  return !!(f && f.rumbo != null && f.vel != null && f.vel >= 1.2 && Date.now() - f.t < 4000);   /* caminando, el rumbo del GPS es más estable que la brújula */
}
function empujarRumbo(h, k) {
  var g = k || 0.3;
  rumbo.h = rumbo.h === null ? h : (rumbo.h + (((h - rumbo.h + 540) % 360) - 180) * g + 360) % 360;
  var ahora = Date.now(); if (ahora - rumbo.ultimo < 120 || !map || !mapaListo) return;
  var dif = ((rumbo.h - map.getBearing() + 540) % 360) - 180;
  if (Math.abs(dif) < 1.5) return;
  rumbo.ultimo = ahora; map.jumpTo({ bearing: rumbo.h });
}
function alOrientacion(ev) {
  if (!rumbo.activo) return;
  var h = null;
  if (typeof ev.webkitCompassHeading === "number" && isFinite(ev.webkitCompassHeading)) h = ev.webkitCompassHeading;           /* iPhone */
  else if ((ev.type === "deviceorientationabsolute" || ev.absolute === true) && ev.alpha != null) h = rumboDispositivo(ev.alpha, ev.beta, ev.gamma);   /* Android */
  if (h === null || !isFinite(h)) return;
  rumbo.recibido = true;
  if (usarRumboGps()) return;
  empujarRumbo(h);
}
async function encenderRumbo() {
  if (rumbo.activo) return;
  var DO = window.DeviceOrientationEvent;
  if (DO && typeof DO.requestPermission === "function") {   /* iPhone: el permiso se pide al tocar el botón */
    try { rumbo.sensor = (await DO.requestPermission()) === "granted"; } catch (e) { rumbo.sensor = false; anotarError("brujula", e); }
    if (!rumbo.sensor) LC.toast("Sin permiso para la brújula. Se usará el rumbo del GPS al caminar.", 5000);
  } else rumbo.sensor = true;
  rumbo.activo = true; rumbo.h = null; rumbo.libre = 0; rumbo.recibido = false;
  if (nav && nav.arriba) { nav.arriba = false; actualizarModoNav(); }   /* los dos modos de giro no se combinan */
  if (rumbo.sensor) {
    window.addEventListener("deviceorientationabsolute", alOrientacion, true);   /* Android (Chrome); en otros navegadores el evento simplemente no llega */
    window.addEventListener("deviceorientation", alOrientacion, true);          /* iPhone (webkitCompassHeading) y navegadores con orientación absoluta */
  }
  var b = $("mp-rumbo"); if (b) b.classList.add("on");
  if (gps.watch == null) gpsEncender();
  LC.toast("Rumbo arriba: el mapa sigue hacia donde apuntas y a tu posición", 3500);
  setTimeout(function () {
    if (rumbo.activo && !rumbo.recibido && !usarRumboGps()) LC.toast("El teléfono no entrega la brújula. El mapa girará con el rumbo del GPS cuando camines.", 5000);
  }, 3000);
}
function apagarRumbo(alNorte) {
  var estaba = rumbo.activo;
  window.removeEventListener("deviceorientationabsolute", alOrientacion, true);
  window.removeEventListener("deviceorientation", alOrientacion, true);
  rumbo.activo = false; rumbo.h = null; rumbo.sensor = false; rumbo.recibido = false;
  var b = $("mp-rumbo"); if (b) b.classList.remove("on");
  if (estaba && alNorte && map && mapaListo) map.easeTo({ bearing: 0, duration: 300 });
}
function actualizarNorte() {
  var b = $("mp-norte"); if (!b || !map) return;
  var g = map.getBearing();
  b.style.display = Math.abs(g) >= 1 ? "" : "none";
  var flecha = $("mp-norte-g"); if (flecha) flecha.setAttribute("transform", "rotate(" + (-g).toFixed(1) + ")");
}

/* ---------- navegar hasta un punto (pulsación larga): brújula, distancia y tiempo estimado ---------- */
var nav = null;                 /* { destino:{lng,lat,nombre}, hist:[{t,lng,lat}], vel:null, rumbo:null } */
var puntosManuales = [];        /* v2.58 / v2.76: puntos { lng, lat } marcados con toque sostenido, uno tras otro; sirven para medir rutas */
var tarjDesp = { x: 0, y: 0 };   /* v2.85: desplazamiento de la tarjeta de puntos manuales (se arrastra con el dedo) */
var selManual = -1;             /* índice del punto manual seleccionado */
var pulsacionReciente = false;  /* el clic que sigue a una pulsación larga no debe abrir el registro */
function distanciaM(a, b) {
  var R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  var x = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function rumboGrados(a, b) {
  var r = Math.PI / 180, dLo = (b.lng - a.lng) * r, la1 = a.lat * r, la2 = b.lat * r;
  var y = Math.sin(dLo) * Math.cos(la2), x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLo);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function puntoCardinal(g) { return ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(g / 45) % 8]; }
function textoDistancia(m) { return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(2).replace(".", ",") + " km"; }
function textoTiempo(seg) {
  var min = Math.max(1, Math.round(seg / 60));
  return min < 60 ? "≈ " + min + " min" : "≈ " + Math.floor(min / 60) + " h " + (min % 60 < 10 ? "0" : "") + (min % 60) + " min";
}
function geoNav() {
  var fc = { type: "FeatureCollection", features: [] };
  var pm = puntosManuales;
  var hechos = {}, actual = 0;   /* v2.89: puntos de la ruta ya alcanzados (por número de punto) y punto objetivo actual */
  if (nav && nav.ruta) { nav.ruta.pts.forEach(function (q, k) { if (nav.ruta.hecho[k]) hechos[q.n] = 1; }); actual = nav.ruta.pts[nav.ruta.pos].n; }
  if (pm.length > 1) {
    for (var sg = 1; sg < pm.length; sg++) fc.features.push({ type: "Feature", properties: { tipo: "medida", ok: hechos[sg] && hechos[sg + 1] ? 1 : 0 }, geometry: { type: "LineString", coordinates: [[pm[sg - 1].lng, pm[sg - 1].lat], [pm[sg].lng, pm[sg].lat]] } });
    for (var i = 1; i < pm.length; i++) {
      fc.features.push({ type: "Feature", properties: { tipo: "tramo", etq: textoDistancia(distanciaM(pm[i - 1], pm[i])) },
        geometry: { type: "Point", coordinates: [(pm[i - 1].lng + pm[i].lng) / 2, (pm[i - 1].lat + pm[i].lat) / 2] } });
    }
  }
  pm.forEach(function (q, i) { fc.features.push({ type: "Feature", properties: { tipo: "manual", n: String(i + 1), sel: i === selManual ? 1 : 0, ok: hechos[i + 1] ? 1 : 0, act: actual === i + 1 ? 1 : 0 }, geometry: { type: "Point", coordinates: [q.lng, q.lat] } }); });
  if (!nav) return fc;
  fc.features.push({ type: "Feature", properties: { tipo: "destino" }, geometry: { type: "Point", coordinates: [nav.destino.lng, nav.destino.lat] } });
  if (gps.fix) fc.features.push({ type: "Feature", properties: { tipo: "linea" }, geometry: { type: "LineString", coordinates: [[gps.fix.lng, gps.fix.lat], [nav.destino.lng, nav.destino.lat]] } });
  return fc;
}
function refrescarNavMapa() { if (map && mapaListo && map.getSource("nav")) map.getSource("nav").setData(geoNav()); }
function dibujarRosa() {
  var marcas = "";
  for (var g = 0; g < 360; g += 30) marcas += '<line x1="0" y1="' + (g % 90 === 0 ? -46 : -49) + '" x2="0" y2="-54" transform="rotate(' + g + ')" class="mp-rosa-marca"/>';
  return '<svg id="mp-rosa" viewBox="-62 -62 124 124" role="button" tabindex="0" aria-label="Brújula de navegación. Mantén presionado para alternar entre objetivo arriba y norte arriba">' +
    '<g id="mp-rosa-disco"><circle r="55" class="mp-rosa-aro"/>' + marcas +
    '<text x="0" y="-37" class="mp-rosa-n" text-anchor="middle">N</text><text x="39" y="4" class="mp-rosa-l" text-anchor="middle">E</text>' +
    '<text x="0" y="45" class="mp-rosa-l" text-anchor="middle">S</text><text x="-39" y="4" class="mp-rosa-l" text-anchor="middle">O</text></g>' +
    '<g id="mp-rosa-rumbo" style="display:none"><polygon points="0,-60 6,-51 -6,-51" class="mp-rosa-tu"/></g>' +
    '<g id="mp-rosa-aguja"><polygon points="0,-34 8,0 -8,0" class="mp-rosa-flecha"/><polygon points="0,26 6,0 -6,0" class="mp-rosa-cola"/><circle r="3" class="mp-rosa-eje"/></g></svg>';
}
/* v2.91: la brújula muestra el mapa tal como se ve: el disco con la N gira con el mapa y la flecha apunta al destino respecto de la parte de arriba de la pantalla */
function pintarRosa() {
  var disco = $("mp-rosa-disco"), aguja = $("mp-rosa-aguja"), tu = $("mp-rosa-rumbo"); if (!disco || !aguja || !tu) return;
  var g = map ? map.getBearing() : 0;
  disco.setAttribute("transform", "rotate(" + (-g).toFixed(1) + ")");
  if (nav && nav.rb != null) aguja.setAttribute("transform", "rotate(" + (nav.rb - g).toFixed(1) + ")");
  if (nav && nav.rumboPropio != null && nav.rumboVisible) { tu.style.display = ""; tu.setAttribute("transform", "rotate(" + (nav.rumboPropio - g).toFixed(1) + ")"); } else tu.style.display = "none";
}
function actualizarNavegacion() {
  var cuadro = $("mp-nav"); if (!cuadro) return;
  if (!nav && rumbo.activo) apagarRumbo(true);   /* al terminar la navegación el mapa vuelve al norte */
  if (!nav) { cuadro.style.display = "none"; return; }
  cuadro.style.display = "block";
  $("mp-nav-nombre").textContent = "Hacia " + nav.destino.nombre;
  var cr = $("mp-nav-ruta");
  if (cr) {
    cr.style.display = nav.ruta ? "flex" : "none";
    if (nav.ruta) { $("mp-nav-ant").disabled = nav.ruta.pos <= 0; $("mp-nav-sig").disabled = nav.ruta.pos >= nav.ruta.pts.length - 1; }
  }
  renderChipsRuta();
  var rum = $("mp-nav-rumbo"), dis = $("mp-nav-dist"), eta = $("mp-nav-eta"), tu = $("mp-rosa-rumbo");
  cuadro.classList.remove("llego");
  if (!gps.fix) {
    rum.textContent = "—"; dis.textContent = gps.watch == null ? "GPS apagado: toca GPS activar" : "Esperando señal GPS…"; eta.textContent = "";
    tu.style.display = "none"; nav.rb = null; refrescarNavMapa(); return;
  }
  var yo = { lng: gps.fix.lng, lat: gps.fix.lat }, d = distanciaM(yo, nav.destino), rb = rumboGrados(yo, nav.destino);
  nav.rb = rb;
  if (nav.arriba && map && mapaListo && d > 8) {   /* objetivo arriba: el mapa gira hacia el punto y sigue tu posición (salvo que muevas el mapa a mano) */
    map.jumpTo({ bearing: rb });
    if (Date.now() - rumbo.libre > 8000) map.jumpTo({ center: [yo.lng, yo.lat] });
  }
  rum.textContent = Math.round(rb) + "° " + puntoCardinal(rb);
  /* velocidad: la que informa el GPS o, si no, el desplazamiento de los últimos segundos */
  var ahora = gps.fix.t, h = nav.hist.filter(function (x) { return ahora - x.t <= 30000; });
  nav.hist = h;
  var v = null, rumboPropio = gps.fix.rumbo;
  if (h.length >= 2) {
    var a = h[0], b = h[h.length - 1], dt = (b.t - a.t) / 1000, dm = distanciaM(a, b);
    if (dt >= 6) { v = dm / dt; if (dm >= 6) rumboPropio = rumboGrados(a, b); }
  }
  if (gps.fix.vel != null && gps.fix.vel >= 0.3) v = gps.fix.vel;
  if (v != null) nav.vel = nav.vel == null ? v : nav.vel * 0.6 + v * 0.4;
  nav.rumboPropio = rumboPropio; nav.rumboVisible = rumboPropio != null && v != null && v >= 0.4;
  pintarRosa();
  var umbral = Math.max(10, Math.min(25, gps.fix.acc * 0.8));
  if (d <= umbral && nav.ruta && nav.ruta.pos < nav.ruta.pts.length - 1 && !nav.ruta.manual) {
    /* v2.85: llegó a un punto intermedio de la ruta; pasa al siguiente de la serie */
    var alcanzado = nav.ruta.pts[nav.ruta.pos].n;
    nav.ruta.hecho[nav.ruta.pos] = true;
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    fijarDestinoRuta(nav.ruta.pos + 1);
    LC.toast("Alcanzaste el punto " + alcanzado + ". Sigue al punto " + nav.ruta.pts[nav.ruta.pos].n, 2800);
    actualizarNavegacion(); return;
  }
  if (d <= umbral) {
    cuadro.classList.add("llego");
    var rr = nav.ruta, finRuta = !rr || rr.pos >= rr.pts.length - 1;
    if (rr) { rr.hecho[rr.pos] = true; renderChipsRuta(); }
    dis.textContent = !rr ? "¡Llegaste!" : finRuta ? "¡Fin de la ruta!" : "¡Llegaste al punto " + rr.pts[rr.pos].n + "!";
    eta.textContent = rr && !finRuta ? "Elige el siguiente punto" : "A " + Math.round(d) + " m del punto";
    if (!nav.avisado) { nav.avisado = true; if (navigator.vibrate) navigator.vibrate([60, 40, 60]); }
  } else {
    nav.avisado = false;
    dis.textContent = textoDistancia(d);
    var kmh = nav.vel != null ? (nav.vel * 3.6).toFixed(1).replace(".", ",") + " km/h" : "";
    var resto = d + (nav.ruta ? restoRuta() : 0);
    eta.textContent = (nav.vel != null && nav.vel >= 0.4) ? textoTiempo(resto / nav.vel) + " · " + kmh : "Ponte en marcha para estimar el tiempo";
    if (nav.ruta) eta.textContent += " · Ruta: quedan " + textoDistancia(resto);
  }
  refrescarNavMapa();
}
/* v2.85: navegar la serie de puntos marcados, empezando por el extremo más cercano y siguiendo el orden hasta el otro extremo */
function restoRuta() {
  var r = nav && nav.ruta; if (!r) return 0;
  var t = 0; for (var i = r.pos + 1; i < r.pts.length; i++) t += distanciaM(r.pts[i - 1], r.pts[i]);
  return t;
}
/* v2.89: elegir a mano el punto objetivo de la ruta (volver a un punto ya alcanzado o saltar adelante). Volver atrás no avanza solo al llegar. */
function elegirPuntoRuta(k) {
  var r = nav && nav.ruta; if (!r || k < 0 || k >= r.pts.length) return;
  r.manual = k < r.pos || !!r.hecho[k]; r.hecho[k] = false;
  fijarDestinoRuta(k); actualizarNavegacion();
}
function renderChipsRuta() {
  var cont = $("mp-nav-pts"); if (!cont || !nav || !nav.ruta) return;
  var r = nav.ruta, sig = r.pos + ":" + r.hecho.map(Number).join("");
  if (cont.getAttribute("data-sig") === sig) return;
  cont.setAttribute("data-sig", sig); cont.textContent = "";
  r.pts.forEach(function (q, k) {
    var ok = !!r.hecho[k], act = k === r.pos;
    cont.appendChild(el("button", { type: "button", class: "mp-pt" + (ok ? " hecho" : "") + (act ? " act" : ""), texto: (ok ? "✓" : "") + q.n,
      "aria-label": "Punto " + q.n + (ok ? ", alcanzado" : "") + (act ? ", objetivo actual" : ""), onclick: function () { elegirPuntoRuta(k); } }));
  });
  var cur = cont.querySelector(".act");
  if (cur) cont.scrollLeft = Math.max(0, cur.offsetLeft - cont.clientWidth / 2 + cur.offsetWidth / 2);
}
function fijarDestinoRuta(pos) {
  var r = nav.ruta, q = r.pts[pos]; r.pos = pos;
  nav.destino = { lng: q.lng, lat: q.lat, nombre: "punto " + q.n + " (" + (pos + 1) + " de " + r.pts.length + ")" };
  nav.avisado = false;
}
function avanzarRuta(delta) {
  if (!nav || !nav.ruta) return;
  var p = nav.ruta.pos + delta; if (p < 0 || p >= nav.ruta.pts.length) return;
  elegirPuntoRuta(p);
}
function iniciarRutaManual() {
  var pm = puntosManuales; if (pm.length < 2) return;
  if (gps.watch == null) gpsEncender();
  if (!gps.fix) { LC.toast("Espera la señal GPS para elegir el extremo más cercano y vuelve a tocar «Navegar la ruta»", 5200); return; }
  var yo = { lng: gps.fix.lng, lat: gps.fix.lat };
  var pts = pm.map(function (q, i) { return { lng: q.lng, lat: q.lat, n: i + 1 }; });
  if (distanciaM(yo, pm[pm.length - 1]) < distanciaM(yo, pm[0])) pts.reverse();
  iniciarNavegacion({ lng: pts[0].lng, lat: pts[0].lat, nombre: "" }, { pts: pts, pos: 0, hecho: pts.map(function () { return false; }), manual: false });
  fijarDestinoRuta(0); actualizarNavegacion();
  LC.toast("Ruta de " + pts.length + " puntos: empiezas en el " + pts[0].n + " y sigues hasta el " + pts[pts.length - 1].n, 3600);
}
function iniciarNavegacion(dest, ruta) {
  nav = { destino: dest, ruta: ruta || null, hist: gps.fix ? [{ t: gps.fix.t, lng: gps.fix.lng, lat: gps.fix.lat }] : [], vel: null, avisado: false, arriba: true, rb: null, rumboPropio: null, rumboVisible: false };
  var cp = $("mp-nav-pts"); if (cp) cp.setAttribute("data-sig", "");
  if (nav.arriba && rumbo.activo) apagarRumbo(false);
  actualizarModoNav();
  if (gps.watch == null) gpsEncender();
  cerrarPanelPuntos(); cerrarTarjeta();
  actualizarNavegacion();
  if (!ruta) LC.toast("Navegando hacia " + dest.nombre + ". Toca ✕ para terminar", 3200);
}
function terminarNavegacion() {
  var estaba = nav && nav.arriba;
  nav = null; actualizarNavegacion(); refrescarNavMapa();
  if (map && map.touchZoomRotate) { try { map.touchZoomRotate.disableRotation(); } catch (e) {} }
  if (map && mapaListo && !estaba && Math.abs(map.getBearing()) > 1) map.easeTo({ bearing: 0, duration: 300 });
  pintarRosa();
  if (estaba && map && mapaListo) map.easeTo({ bearing: 0, duration: 300 });   /* al terminar, el mapa vuelve al norte */
}
/* v2.89: modo del mapa durante la navegación: norte arriba (gira libre con los dedos) u objetivo arriba (el mapa gira para que el punto quede hacia arriba) */
var navDesp = { x: 0, y: 0 };   /* desplazamiento de la ventana de navegación (se arrastra con el dedo) */
/* v2.91: un solo control, la brújula de la ventana. Por defecto el mapa gira para que el destino quede hacia arriba (objetivo arriba);
   con presión sostenida sobre la brújula se fija el norte arriba (el mapa se puede girar con los dedos); otra presión sostenida vuelve a objetivo arriba.
   Con un toque en la brújula, en norte arriba, el mapa vuelve a poner el norte arriba. */
function actualizarModoNav() {
  var ar = !!(nav && nav.arriba), t = $("mp-nav-modo-txt");
  if (t) t.textContent = ar ? "Objetivo arriba. Mantén presionada la brújula para fijar el norte arriba." : "Norte arriba. Toca la brújula para enderezar el mapa. Presión sostenida: objetivo arriba.";
  if (map && map.touchZoomRotate) { try { if (ar) map.touchZoomRotate.disableRotation(); else map.touchZoomRotate.enableRotation(); } catch (e) {} }
}
function ponerModoNav(arriba) {
  if (!nav || nav.arriba === arriba) return;
  nav.arriba = arriba;
  if (!arriba && map && mapaListo) map.easeTo({ bearing: 0, duration: 300 });
  actualizarModoNav(); actualizarNavegacion();
  LC.toast(arriba ? "Objetivo arriba: el mapa gira para que el punto quede hacia arriba" : "Norte arriba: el mapa queda con el norte arriba y puedes girarlo con los dedos", 2800);
}
function instalarBrujula() {
  var r = $("mp-rosa"), t = null, largo = false, ini = null;
  function cancelar() { clearTimeout(t); t = null; }
  r.addEventListener("pointerdown", function (e) {
    largo = false; cancelar(); ini = { x: e.clientX, y: e.clientY }; r.classList.add("pulsando");
    t = setTimeout(function () { t = null; largo = true; r.classList.remove("pulsando"); if (navigator.vibrate) navigator.vibrate(40); ponerModoNav(!(nav && nav.arriba)); }, 600);
    e.stopPropagation();
  });
  r.addEventListener("pointermove", function (e) { if (t && ini && Math.hypot(e.clientX - ini.x, e.clientY - ini.y) > 10) { cancelar(); r.classList.remove("pulsando"); } });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { r.addEventListener(ev, function () { cancelar(); r.classList.remove("pulsando"); }); });
  r.addEventListener("click", function () {
    if (largo) { largo = false; return; }
    if (nav && !nav.arriba && map && mapaListo) map.easeTo({ bearing: 0, duration: 300 });   /* norte arriba: un toque endereza el mapa */
    else if (nav) LC.toast("Objetivo arriba. Mantén presionada la brújula para fijar el norte arriba.", 3200);
  });
  r.addEventListener("contextmenu", function (e) { e.preventDefault(); });
}
function destinoEn(pt) {
  var caja = [[pt[0] - 14, pt[1] - 14], [pt[0] + 14, pt[1] + 14]];
  var capas = ["puntos-circ", "puntos-nota", "capas-estaciones"].filter(function (l) { return map.getLayer(l); });
  if (!capas.length) return null;
  var fs = map.queryRenderedFeatures(caja, { layers: capas });
  if (!fs.length) return null;
  var f = fs[0], pr = f.properties || {};
  return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], nombre: pr.codigo || pr.nombre || pr.estacion || "el punto" };
}
function aplicarDespTarjeta(t) { t.style.transform = (tarjDesp.x || tarjDesp.y) ? "translate(" + tarjDesp.x + "px," + tarjDesp.y + "px)" : ""; }
function textoCoordenada(p) { return p.lat.toFixed(6) + ", " + p.lng.toFixed(6); }
function distanciaTotalManual(hasta) {
  var t = 0; for (var i = 1; i <= hasta && i < puntosManuales.length; i++) t += distanciaM(puntosManuales[i - 1], puntosManuales[i]);
  return t;
}
function marcarPuntoManual(lng, lat) {
  if (eleccion) puntosManuales = [];
  puntosManuales.push({ lng: lng, lat: lat });
  selManual = puntosManuales.length - 1;
  refrescarNavMapa();
  mostrarTarjetaPuntoManual();
  if (puntosManuales.length > 1) LC.toast("Punto " + puntosManuales.length + " · total " + textoDistancia(distanciaTotalManual(puntosManuales.length - 1)), 2600);
}
function seleccionarPuntoManual(i) {
  if (i < 0 || i >= puntosManuales.length) return;
  selManual = i; refrescarNavMapa(); mostrarTarjetaPuntoManual();
}
/* v2.74: guarda el punto marcado a mano como un registro nuevo (misma vía que "Guardar punto aquí", con la coordenada marcada y sin precisión de GPS) */
function guardarPuntoManual(pm) {
  if (!LC.exigirSesionActiva()) return;
  LC.abrirRegistro();
  var d = LC.state.draft;
  if (!d || d._editando || d._viendo) { LC.toast("Hay un registro en edición. Usa Capturar ubicación dentro de Nuevo.", 5000); return; }
  LC.aplicarPosicionAlBorrador(pm.lat, pm.lng, null, null, 0);
  quitarPuntoManual(puntosManuales.indexOf(pm));
}
/* quita un punto (por defecto el seleccionado); la línea y los tramos se recalculan con los que quedan */
function quitarPuntoManual(i) {
  if (typeof i !== "number") i = selManual;
  if (i >= 0 && i < puntosManuales.length) puntosManuales.splice(i, 1);
  if (!puntosManuales.length) { selManual = -1; refrescarNavMapa(); cerrarTarjeta(); return; }
  selManual = Math.min(Math.max(i - 1, 0), puntosManuales.length - 1);
  refrescarNavMapa(); mostrarTarjetaPuntoManual();
}
function quitarTodosManuales() { puntosManuales = []; selManual = -1; refrescarNavMapa(); cerrarTarjeta(); }
/* v2.85: altitud aproximada desde el relieve instalado (terrarium, zoom 12, interpolación bilineal). Solo se informa dentro del área con relieve y si el valor es plausible (sobre el nivel del mar); no se calcula profundidad. */
var tesDem = [];
async function pixelesDem(z, x, y) {
  var clave = z + "/" + x + "/" + y, h = tesDem.filter(function (k) { return k.clave === clave; })[0];
  if (h) return h.datos;
  var cand = relievesParaTesela(z, x, y), d = null;
  for (var q = 0; q < cand.length && !d; q++) d = await bytesTesela(cand[q], z, x, y);
  var datos = null;
  if (d) {
    var bmp = await createImageBitmap(new Blob([d], { type: "image/webp" }));
    var cv = (typeof OffscreenCanvas !== "undefined") ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
    var cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(bmp, 0, 0);
    var im = cx.getImageData(0, 0, bmp.width, bmp.height);
    datos = { w: bmp.width, h: bmp.height, px: im.data };
    if (bmp.close) bmp.close();
  }
  tesDem.push({ clave: clave, datos: datos }); if (tesDem.length > 6) tesDem.shift();
  return datos;
}
async function altitudAprox(lng, lat) {
  if (!relieveNombres.length || !isFinite(lng) || !isFinite(lat) || Math.abs(lat) > 85) return null;
  var z = 12, n = Math.pow(2, z), s = Math.sin(lat * Math.PI / 180);
  var fx = (lng + 180) / 360 * n, fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  var x = Math.floor(fx), y = Math.floor(fy), t = await pixelesDem(z, x, y);
  if (!t) return null;
  function elev(i, j) {
    i = Math.max(0, Math.min(t.w - 1, i)); j = Math.max(0, Math.min(t.h - 1, j));
    var o = (j * t.w + i) * 4; return t.px[o] * 256 + t.px[o + 1] + t.px[o + 2] / 256 - 32768;
  }
  var u = (fx - x) * t.w - 0.5, v = (fy - y) * t.h - 0.5, i0 = Math.floor(u), j0 = Math.floor(v), a = u - i0, b = v - j0;
  var e00 = elev(i0, j0), e10 = elev(i0 + 1, j0), e01 = elev(i0, j0 + 1), e11 = elev(i0 + 1, j0 + 1);
  var val = e00 * (1 - a) * (1 - b) + e10 * a * (1 - b) + e01 * (1 - a) * b + e11 * a * b;
  var mx = Math.max(e00, e10, e01, e11), mn = Math.min(e00, e10, e01, e11);
  if (!(val > 0) || val > 9000) return null;
  return { m: Math.round(val), dif: Math.round(mx - mn) };
}
async function altitudDe(pm) {
  if (pm.alt === undefined) { try { pm.alt = await altitudAprox(pm.lng, pm.lat); } catch (e) { pm.alt = null; } }
  return pm.alt;
}
function textoAltitud(a) {
  return "Altitud ≈ " + a.m + " m (modelo de relieve" + (a.dif >= 30 ? "; terreno escarpado, puede variar unos ±" + Math.round(a.dif / 2) + " m" : "") + ")";
}
function crearAsaTarjeta(t, desp) {
  desp = desp || tarjDesp;
  var asa = el("div", { class: "mp-asa", title: "Arrastra para mover esta ventana" }, [el("span", { texto: "⋯ arrastra para mover ⋯" })]), ini = null;
  asa.addEventListener("pointerdown", function (e) {
    ini = { x: e.clientX, y: e.clientY, dx: desp.x, dy: desp.y };
    if (asa.setPointerCapture) { try { asa.setPointerCapture(e.pointerId); } catch (x) {} }
    e.preventDefault(); e.stopPropagation();
  });
  asa.addEventListener("pointermove", function (e) {
    if (!ini) return;
    var L = $("mp-lienzo").getBoundingClientRect(), r = t.getBoundingClientRect();
    var bl = r.left - desp.x, bt = r.top - desp.y;
    var nx = ini.dx + e.clientX - ini.x, ny = ini.dy + e.clientY - ini.y;
    var loX = L.left - bl, hiX = L.right - (bl + r.width), loY = L.top - bt, hiY = L.bottom - (bt + r.height);
    if (hiX < loX) hiX = loX; if (hiY < loY) hiY = loY;
    desp.x = Math.round(Math.max(loX, Math.min(hiX, nx))); desp.y = Math.round(Math.max(loY, Math.min(hiY, ny)));
    t.style.transform = "translate(" + desp.x + "px," + desp.y + "px)";
    e.preventDefault();
  });
  function fin() { ini = null; }
  asa.addEventListener("pointerup", fin); asa.addEventListener("pointercancel", fin);
  return asa;
}
/* v2.85: convierte los puntos marcados en una capa local (igual que una capa importada). Un cuadro permite elegir el nombre de la capa,
   si se conserva la línea que une los puntos o se guardan como puntos independientes (estaciones), y el nombre de cada punto. */
var modalCapa = null;
function cerrarModalCapa() { if (modalCapa) modalCapa.classList.remove("on"); }
async function crearCapaDePuntos(pm, o) {
  var alts = []; for (var i = 0; i < pm.length; i++) alts.push(await altitudDe(pm[i]));
  var fc = { type: "FeatureCollection", features: [] };
  if (o.linea && pm.length > 1) fc.features.push({ type: "Feature", properties: { nombre: o.nombre, tipo: "ruta", puntos: pm.length, distancia_m: Math.round(distanciaTotalManual(pm.length - 1)) }, geometry: { type: "LineString", coordinates: pm.map(function (q) { return [q.lng, q.lat]; }) } });
  pm.forEach(function (q, k) {
    var nom = (o.nombres[k] || "").trim() || "Punto " + (k + 1);
    var p = { nombre: nom, orden: k + 1, lat: +q.lat.toFixed(6), lon: +q.lng.toFixed(6) };
    if (!o.linea) p.estacion = nom;
    if (alts[k]) p.altitud_m = alts[k].m;
    if (o.linea && k > 0) p.distancia_acum_m = Math.round(distanciaTotalManual(k));
    fc.features.push({ type: "Feature", properties: p, geometry: { type: "Point", coordinates: [q.lng, q.lat] } });
  });
  var f = new File([JSON.stringify(fc)], o.nombre + ".geojson", { type: "application/geo+json" });
  await importarCapaLocal(f, o.mapaId, o.vinculo);
}
function guardarPuntosComoCapa() {
  var pm = puntosManuales.slice(); if (!pm.length) return;
  var ids = Object.keys(inst);
  function contiene(id, q) { var a = inst[id].area; return !a || (q.lng >= a[0] && q.lng <= a[2] && q.lat >= a[1] && q.lat <= a[3]); }
  var mid = ids.length ? ((mapaImportId && inst[mapaImportId] && contiene(mapaImportId, pm[0])) ? mapaImportId : (ids.filter(function (i) { return contiene(i, pm[0]); })[0] || "")) : "";
  var selMapaCap = el("select", { id: "cap-mapa" });
  selMapaCap.appendChild(el("option", { value: "", texto: "Sin mapa (capa independiente)" }));
  ids.sort().forEach(function (id) { selMapaCap.appendChild(el("option", { value: id, texto: nombreCorto(inst[id].nombre) })); });
  selMapaCap.value = mid;
  var vincCap = ""; var selVincCap = selectorVinculo("", function (v) { vincCap = v; });
  if (!modalCapa) {
    modalCapa = el("div", { class: "modal-bg", id: "mp-modal-capa" });
    modalCapa.addEventListener("click", function (e) { if (e.target === modalCapa) cerrarModalCapa(); });
    document.body.appendChild(modalCapa);
  }
  modalCapa.textContent = "";
  var inpNom = el("input", { type: "text", id: "cap-nombre", autocomplete: "off", spellcheck: "false", value: "Ruta marcada " + fechaHM() });
  var rLinea = el("input", { type: "radio", name: "cap-modo", id: "cap-modo-linea", value: "linea" }), rPuntos = el("input", { type: "radio", name: "cap-modo", id: "cap-modo-puntos", value: "puntos" });
  (pm.length > 1 ? rLinea : rPuntos).checked = true;
  if (pm.length < 2) { rLinea.disabled = true; }
  var cajaNombres = el("div", { class: "mp-cap-nombres", id: "cap-nombres" }), inps = [];
  pm.forEach(function (q, k) {
    var inp = el("input", { type: "text", autocomplete: "off", spellcheck: "true", placeholder: "Punto " + (k + 1), "aria-label": "Nombre del punto " + (k + 1) });
    inps.push(inp);
    cajaNombres.appendChild(el("div", { class: "mp-cap-fila" }, [el("span", { class: "mp-cap-n", texto: String(k + 1) }), inp, el("span", { class: "mp-suave mp-cap-co", texto: q.lat.toFixed(5) + ", " + q.lng.toFixed(5) })]));
  });
  var msg = el("p", { class: "campo-ayuda", id: "cap-msg", style: "min-height:1.2em;" });
  var btnOk = el("button", { type: "button", class: "primario", id: "cap-guardar", texto: "Guardar capa", onclick: async function () {
    var nombre = inpNom.value.replace(/[\\\/:*?"<>|.]+/g, " ").replace(/\s+/g, " ").trim();
    if (!nombre) { msg.textContent = "Escribe un nombre para la capa."; return; }
    btnOk.disabled = true;
    await crearCapaDePuntos(pm, { nombre: nombre, mapaId: selMapaCap.value, vinculo: vincCap, linea: rLinea.checked, nombres: inps.map(function (x) { return x.value; }) });
    btnOk.disabled = false; cerrarModalCapa();
  } });
  var caja = el("div", { class: "modal" }, [
    el("div", { class: "mp-panel-cab mp-gestor-cab" }, [el("h2", { texto: "Guardar como capa", style: "margin:0;font-size:1.1rem;" }), el("button", { type: "button", class: "mp-panel-x", texto: "✕", "aria-label": "Cerrar", onclick: cerrarModalCapa })]),
    el("div", { class: "field" }, [el("label", { texto: "Nombre de la capa", for: "cap-nombre" }), inpNom]),
    el("div", { class: "field" }, [el("label", { texto: "Asociar a un mapa descargado (opcional)", for: "cap-mapa" }), selMapaCap]),
    el("div", { class: "field" }, [el("label", { texto: "Vincular a una sesión o proyecto (opcional)" }), selVincCap, el("span", { class: "campo-ayuda", texto: "Las capas vinculadas viajan en el .zip de esa sesión o proyecto." })]),
    el("div", { class: "mp-suave", texto: "Qué guardar" }),
    el("label", { class: "mp-chk" }, [rLinea, el("span", { texto: "Ruta: los puntos y la línea que los une" })]),
    el("label", { class: "mp-chk" }, [rPuntos, el("span", { texto: "Solo puntos independientes (por ejemplo, estaciones)" })]),
    el("div", { class: "mp-suave", texto: "Nombre de cada punto (si lo dejas vacío se llamará «Punto 1», «Punto 2»…)" }),
    cajaNombres, msg,
    el("div", { class: "mp-fila" }, [el("button", { type: "button", texto: "Cancelar", onclick: cerrarModalCapa }), btnOk])
  ]);
  modalCapa.appendChild(caja);
  modalCapa.classList.add("on");
}
function mostrarTarjetaPuntoManual() {
  var t = $("mp-tarjeta"); if (!t || selManual < 0 || !puntosManuales[selManual]) return;
  var pm = puntosManuales[selManual], n = puntosManuales.length, txt = textoCoordenada(pm);
  t.textContent = "";
  t.appendChild(crearAsaTarjeta(t)); aplicarDespTarjeta(t);
  t.appendChild(el("b", { texto: n > 1 ? "Punto " + (selManual + 1) + " de " + n : "Punto marcado" }));
  t.appendChild(el("div", { texto: "Lat " + pm.lat.toFixed(6) + "  ·  Lon " + pm.lng.toFixed(6) }));
  var lnAlt = el("div", { class: "mp-suave", texto: pm.alt === undefined ? "Altitud: calculando…" : (pm.alt ? textoAltitud(pm.alt) : "") });
  if (pm.alt === null) lnAlt.style.display = "none";
  t.appendChild(lnAlt);
  if (pm.alt === undefined) altitudDe(pm).then(function (a) { if (a) lnAlt.textContent = textoAltitud(a); else lnAlt.style.display = "none"; });
  if (n > 1) {
    var ant = selManual > 0 ? distanciaM(puntosManuales[selManual - 1], pm) : null;
    t.appendChild(el("div", { class: "mp-medida", texto: "Distancia total de la ruta: " + textoDistancia(distanciaTotalManual(n - 1)) }));
    if (ant !== null) t.appendChild(el("div", { class: "mp-suave", texto: "Desde el punto " + selManual + ": " + textoDistancia(ant) + " · acumulado hasta aquí: " + textoDistancia(distanciaTotalManual(selManual)) }));
    else t.appendChild(el("div", { class: "mp-suave", texto: "Es el inicio de la ruta medida." }));
  }
  if (gps.fix) {
    var yo = { lng: gps.fix.lng, lat: gps.fix.lat };
    t.appendChild(el("div", { class: "mp-suave", texto: "A " + textoDistancia(distanciaM(yo, pm)) + " hacia el " + puntoCardinal(rumboGrados(yo, pm)) + " desde tu ubicación" }));
  } else {
    t.appendChild(el("div", { class: "mp-suave", texto: "Activa el GPS para ver la distancia y navegar hasta aquí." }));
  }
  t.appendChild(el("div", { class: "mp-suave", texto: eleccion ? "Toca otro lugar para mover la marca. Con «Usar esta coordenada» vuelves con latitud y longitud cargadas." : n > 1 ? "Marcas temporales. Mantén pulsado en otro lugar para sumar un punto; toca un punto para elegirlo." : "Es una marca temporal. Mantén pulsado en otro lugar para sumar puntos y medir una ruta." }));
  var botones = [
    el("button", { class: "primario", texto: "💾 Guardar registro aquí", onclick: function () { guardarPuntoManual(pm); } }),
    el("button", { texto: "🗂 Guardar como capa", onclick: guardarPuntosComoCapa }),
    el("button", { texto: "📋 Copiar coordenada", onclick: function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { LC.toast("Coordenadas copiadas: " + txt, 3200); }, function () { LC.toast("Coordenadas: " + txt, 5000); });
      else LC.toast("Coordenadas: " + txt, 5000);
    } }),
    el("button", { texto: "🧭 Navegar hasta aquí", onclick: function () { iniciarNavegacion({ lng: pm.lng, lat: pm.lat, nombre: "el punto marcado" }); } })
  ];
  if (n > 1) botones.push(el("button", { texto: "🧭 Navegar la ruta", onclick: iniciarRutaManual }));
  botones.push(el("button", { texto: "Quitar", onclick: function () { quitarPuntoManual(); } }));
  if (n > 1) botones.push(el("button", { texto: "Quitar todos", onclick: quitarTodosManuales }));
  if (eleccion) botones = [
    el("button", { class: "primario", texto: "✔ Usar esta coordenada", onclick: function () { usarCoordenadaElegida(pm); } }),
    botones.filter(function (b) { return /Copiar/.test(b.textContent); })[0],
    el("button", { texto: "Cancelar", onclick: cancelarEleccion })
  ];
  t.appendChild(el("div", { class: "mp-fila" }, botones));
  t.style.display = "block";
}
function instalarPulsacionLarga() {
  var cont = map.getCanvasContainer(), timer = null, ini = null;
  function cancelar() { clearTimeout(timer); timer = null; }
  cont.addEventListener("pointerdown", function (e) {
    cancelar();
    if (e.isPrimary === false) return;
    ini = { x: e.clientX, y: e.clientY };
    timer = setTimeout(function () {
      timer = null;
      var r = cont.getBoundingClientRect(), pt = [ini.x - r.left, ini.y - r.top], dest = destinoEn(pt);
      pulsacionReciente = true; setTimeout(function () { pulsacionReciente = false; }, 1000);
      if (navigator.vibrate) navigator.vibrate(35);
      if (dest) { iniciarNavegacion(dest); return; }
      var ll = map.unproject(pt);
      marcarPuntoManual(ll.lng, ll.lat);
    }, 650);
  });
  cont.addEventListener("pointermove", function (e) { if (timer && ini && Math.hypot(e.clientX - ini.x, e.clientY - ini.y) > 10) cancelar(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { cont.addEventListener(ev, cancelar); });
  cont.addEventListener("contextmenu", function (e) { e.preventDefault(); });
}

/* ---------- lista flotante "Mis puntos": todos los conjuntos de puntos disponibles ---------- */
function conjuntosPuntos() {
  var porSesion = {}, out = [];
  LC.state.registros.forEach(function (r) {
    var la = numOk(r.lat), lo = numOk(r.lon); if (la === null || lo === null) return;
    var g = porSesion[r.sesionId] = porSesion[r.sesionId] || { coords: [], regs: [] };
    g.coords.push([lo, la]);
    if (r.tipo === "observacion" && r.obsTermino) { var l2 = numOk(r.obsTermino.lat), o2 = numOk(r.obsTermino.lon); if (l2 !== null && o2 !== null) g.coords.push([o2, l2]); }
    g.regs.push({ id: r.id, codigo: r.codigo || r.notaTitulo || "(sin código)", clase: claseMarca(r), tipo: ROT_TIPO[r.tipo] || "Registro", fecha: (r.fecha || "") + (r.hora ? " " + r.hora : ""), lng: lo, lat: la });
  });
  listaRecorridos().forEach(function (rc) {   /* v2.45: los recorridos grabados se listan dentro de su sesión */
    if (!rc.sesionId) return;
    var sg = segmentosRec(rc); if (!sg.length) return;
    var g = porSesion[rc.sesionId] = porSesion[rc.sesionId] || { coords: [], regs: [] };
    sg.forEach(function (c) { c.forEach(function (x) { g.coords.push(x); }); });
    g.regs.push({ id: rc.id, rec: rc, codigo: rc.nombre || "Recorrido", clase: "trk", tipo: "Recorrido", fecha: textoRecorrido(rc), pts: sg });
  });
  LC.state.sesiones.slice().sort(function (a, b) {
    if (a.id === LC.state.sesionActivaId) return -1; if (b.id === LC.state.sesionActivaId) return 1;
    return (b.creada || "").localeCompare(a.creada || "");
  }).forEach(function (x) {
    if (!porSesion[x.id]) return;
    var rg = porSesion[x.id].regs, nRec = rg.filter(function (r) { return r.clase === "trk"; }).length;
    out.push({ tipo: "sesion", clave: x.id, nombre: LC.nombreSesionMostrar(x), activa: x.id === LC.state.sesionActivaId, color: LC.colorSesion(x.id), n: rg.length - nRec, nRec: nRec, coords: porSesion[x.id].coords, regs: rg });
  });
  var rutas = {};   /* v2.67: recorridos de ruta de un proyecto (sin sesión) */
  listaRecorridos().forEach(function (rc) {
    if (rc.sesionId || !rc.viajeId) return;
    var sg = segmentosRec(rc); if (!sg.length) return;
    var g = rutas[rc.viajeId] = rutas[rc.viajeId] || { coords: [], n: 0 };
    sg.forEach(function (c) { c.forEach(function (x) { g.coords.push(x); }); }); g.n++;
  });
  Object.keys(rutas).forEach(function (vid) {
    var v = LC.viajePorId ? LC.viajePorId(vid) : null; if (!v) return;
    out.push({ tipo: "ruta", clave: "vj:" + vid, nombre: "🧭 " + v.nombre, sub: rutas[vid].n + (rutas[vid].n === 1 ? " recorrido de ruta" : " recorridos de ruta"), coords: rutas[vid].coords });
  });
  capasActuales.forEach(function (c) {
    out.push({ tipo: "capa", clave: c.clave, nombre: c.nombre, origen: c.origen, resumen: resumenCuenta(c.datos.cuenta), bbox: c.datos.bbox });
  });
  return out;
}
function encuadrarConjunto(c) {
  var b = new maplibregl.LngLatBounds();
  if (c.tipo === "sesion" || c.tipo === "ruta") c.coords.forEach(function (x) { b.extend(x); });
  else { b.extend([c.bbox[0], c.bbox[1]]); b.extend([c.bbox[2], c.bbox[3]]); }
  map.fitBounds(b, { padding: 70, maxZoom: 17, duration: 500 });
}
function cerrarPanelPuntos() { var pn = $("mp-panel-puntos"); if (pn) pn.style.display = "none"; var b = $("mp-puntos"); if (b) b.classList.remove("on"); var m = $("mp-puntos-menu"); if (m) m.style.display = "none"; }
function textoSubSesion(c) {
  var ocultos = c.regs.filter(function (r) { return !visReg(r.id); }).length;
  return (c.n || !c.nRec ? c.n + (c.n === 1 ? " punto" : " puntos") : "") + (c.nRec ? (c.n ? " · " : "") + c.nRec + (c.nRec === 1 ? " recorrido" : " recorridos") : "") + (c.activa ? " · activa" : "") + (ocultos ? " · " + ocultos + (ocultos === 1 ? " oculto" : " ocultos") : "");
}
function verRegistroEnMapa(r) {
  if (!map || !mapaListo) return;
  if (r.clase === "trk") {
    var b = new maplibregl.LngLatBounds();
    r.pts.forEach(function (sg) { sg.forEach(function (x) { b.extend(x); }); });
    map.fitBounds(b, { padding: 70, maxZoom: 17, duration: 500 }); cerrarPanelPuntos(); return;
  }
  map.easeTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 500 });
  ponerResaltado({ lng: r.lng, lat: r.lat }, false);
  cerrarPanelPuntos();
}
function filaRegistro(c, r) {
  var cb = el("input", { type: "checkbox" }); cb.checked = visReg(r.id);
  var fila = el("div", { class: "mp-panel-reg" + (cb.checked ? "" : " off") });
  cb.onchange = function () {
    if (!capasVis.regs) capasVis.regs = {};
    if (cb.checked) delete capasVis.regs[r.id]; else capasVis.regs[r.id] = false;
    fila.classList.toggle("off", !cb.checked);
    guardarJSON(LS_CAPAS, capasVis); aplicarFiltroPuntos();
    var sub = document.querySelector('[data-sub-sesion="' + c.clave + '"]'); if (sub) sub.textContent = textoSubSesion(c);
  };
  var letra = el("span", { class: "mp-letra" + (r.clase === "nota" ? " rombo" : r.clase === "trk" ? " linea" : ""), style: "background:" + c.color, texto: r.clase === "rec" ? "R" : r.clase === "obs" ? "O" : r.clase === "nota" ? "N" : r.clase === "trk" ? "━" : "" });
  var ver = el("button", { type: "button", class: "mp-panel-ver", onclick: function () { verRegistroEnMapa(r); } }, [el("b", { texto: r.codigo }), el("span", { class: "mp-suave", texto: r.tipo + (r.fecha ? " · " + r.fecha : "") })]);
  fila.appendChild(cb); fila.appendChild(letra); fila.appendChild(ver);
  if (r.clase === "trk") {   /* v2.45: un recorrido grabado se puede borrar desde aquí */
    fila.appendChild(el("button", { type: "button", class: "mp-exp", "aria-label": "Borrar el recorrido", texto: "🗑", onclick: function () { if (borrarRecorrido(r.rec)) renderPanelPuntos(); } }));
  }
  return fila;
}
function renderPanelPuntos() {
  var pn = $("mp-panel-puntos"); if (!pn) return;
  var vivos = {}; LC.state.registros.forEach(function (r) { vivos[r.id] = 1; });
  if (capasVis.regs) {   /* limpia las marcas de registros que ya no existen */
    var cambio = false;
    Object.keys(capasVis.regs).forEach(function (k) { if (!vivos[k]) { delete capasVis.regs[k]; cambio = true; } });
    if (cambio) { guardarJSON(LS_CAPAS, capasVis); aplicarFiltroPuntos(); }
  }
  pn.textContent = "";
  var cab = el("div", { class: "mp-panel-cab" }, [el("b", { texto: "Puntos y capas" }), el("button", { type: "button", class: "mp-panel-x", texto: "✕", "aria-label": "Cerrar", onclick: cerrarPanelPuntos })]);
  pn.appendChild(cab);
  var lista = conjuntosPuntos();
  if (!lista.length) pn.appendChild(el("p", { class: "mp-suave", texto: "Aún no hay registros con ubicación ni capas cargadas." }));
  var grupos = [["sesion", "Registros por sesión"], ["ruta", "Rutas de proyecto"], ["capa", "Capas del mapa"]];
  grupos.forEach(function (g) {
    var items = lista.filter(function (c) { return c.tipo === g[0]; });
    if (!items.length) return;
    pn.appendChild(el("div", { class: "mp-panel-grupo", texto: g[1] }));
    items.forEach(function (c) {
      if (c.tipo === "ruta") {
        pn.appendChild(el("div", { class: "mp-panel-fila" }, [el("span", { class: "mp-punto", style: "background:#5a4616" }),
          el("button", { type: "button", class: "mp-panel-ver", onclick: function () { encuadrarConjunto(c); cerrarPanelPuntos(); } }, [el("b", { texto: c.nombre }), el("span", { class: "mp-suave", texto: c.sub })])]));
        return;
      }
      var inp = el("input", { type: "checkbox" });
      inp.checked = c.tipo === "sesion" ? visSesion(c.clave) : visCapa(c.clave);
      var regs = null;
      inp.onchange = function () {
        if (c.tipo === "sesion") {
          if (!capasVis.sesiones) capasVis.sesiones = {}; capasVis.sesiones[c.clave] = inp.checked; aplicarFiltroPuntos();
          if (regs) regs.classList.toggle("sesion-oculta", !inp.checked);
        } else { if (!capasVis.capas) capasVis.capas = {}; capasVis.capas[c.clave] = inp.checked; aplicarFiltrosCapas(); }
        guardarJSON(LS_CAPAS, capasVis);
      };
      var punto = c.tipo === "sesion" ? el("span", { class: "mp-punto", style: "background:" + c.color }) : el("span", { class: "mp-punto mp-punto-capa", style: "background:" + (c.origen === "local" ? estiloDe(capasLoc.filter(function (x) { return x.id === c.id; })[0]).color : COL_CAT) });
      var subEl = el("span", { class: "mp-suave", texto: c.tipo === "sesion" ? textoSubSesion(c) : c.resumen + (c.origen === "local" ? " · importada" : " · catálogo") });
      if (c.tipo === "sesion") subEl.setAttribute("data-sub-sesion", c.clave);
      var ver = el("button", { type: "button", class: "mp-panel-ver", onclick: function () { encuadrarConjunto(c); cerrarPanelPuntos(); } }, [el("b", { texto: c.nombre }), subEl]);
      var fila = el("div", { class: "mp-panel-fila" }, [inp, punto, ver]);
      if (c.tipo === "sesion") {
        var abierta = !!panelAbiertos[c.clave];
        var exp = el("button", { type: "button", class: "mp-exp", "aria-label": "Ver los registros de la sesión", texto: abierta ? "▾" : "▸" });
        regs = el("div", { class: "mp-panel-regs" + (inp.checked ? "" : " sesion-oculta") });
        regs.style.display = abierta ? "" : "none";
        c.regs.forEach(function (r) { regs.appendChild(filaRegistro(c, r)); });
        exp.onclick = function () {
          panelAbiertos[c.clave] = !panelAbiertos[c.clave];
          regs.style.display = panelAbiertos[c.clave] ? "" : "none"; exp.textContent = panelAbiertos[c.clave] ? "▾" : "▸";
        };
        fila.appendChild(exp);
        pn.appendChild(fila); pn.appendChild(regs);
      } else pn.appendChild(fila);
    });
  });
  if (lista.length) pn.appendChild(el("p", { class: "mp-suave", style: "margin:8px 0 0;", texto: "La casilla muestra u oculta el conjunto. Toca ▸ para ver sus registros y ocultar alguno. Toca el nombre para acercar el mapa." }));
}
function alternarPanelPuntos() {
  var pn = $("mp-panel-puntos"); if (!pn) return;
  if (pn.style.display === "block") { cerrarPanelPuntos(); return; }
  renderPanelPuntos(); pn.style.display = "block"; $("mp-puntos").classList.add("on");
}
/* v2.92: "Puntos" abre una pestaña pequeña con dos botones: Puntos (lista de conjuntos) y Etiquetas (activar/desactivar con un toque) */
function alternarMenuPuntos() {
  var m = $("mp-puntos-menu"); if (!m) return;
  var pn = $("mp-panel-puntos");
  if (m.style.display === "flex" || (pn && pn.style.display === "block")) { cerrarPanelPuntos(); return; }
  m.style.display = "flex"; $("mp-puntos").classList.add("on");
}
function abrirListaPuntos() {
  var m = $("mp-puntos-menu"); if (m) m.style.display = "none";
  var pn = $("mp-panel-puntos"); if (!pn) return;
  if (pn.style.display === "block") { cerrarPanelPuntos(); return; }
  alternarPanelPuntos();
}

/* ---------- Guardar punto aquí ---------- */
function guardarPuntoAqui() {
  var btn = document.createElement("button"), orig = "", cen = $("mp-centrar");   /* v2.74: ya no hay botón propio; el progreso se muestra con un aviso y el ◎ pulsando */
  if (LC.gpsCapturaActiva()) { LC.gpsCapturaActiva().cerrarYa(); return; }
  if (!LC.exigirSesionActiva()) return;
  if (!navigator.geolocation) { LC.toast("Este navegador no tiene GPS disponible"); return; }
  LC.toast("📡 Buscando tu posición para guardar el punto…", 3500);
  if (cen) cen.classList.add("buscando");
  LC.obtenerPosicionMejorada(btn, "📡 Afinando", function (pos) {
    if (cen) cen.classList.remove("buscando");
    var c = pos.coords;
    LC.abrirRegistro();   /* crea (o recupera) el registro en curso y abre Nuevo; sin sesión activa, crea una */
    var d = LC.state.draft;
    if (!d || d._editando || d._viendo) { LC.toast("Hay un registro en edición. Usa Capturar ubicación dentro de Nuevo.", 5000); return; }
    LC.aplicarPosicionAlBorrador(c.latitude, c.longitude, c.altitude, c.accuracy, pos.muestras);
  }, function (err) {
    if (cen) cen.classList.remove("buscando");
    var msg = "No se pudo obtener la ubicación. Intenta de nuevo.";
    if (err && err.code === 1) msg = "Permiso de ubicación denegado. Actívalo en los ajustes del navegador.";
    else if (err && err.code === 3) msg = "Se agotó el tiempo de espera del GPS. Intenta de nuevo.";
    LC.toast(msg, 5000);
  });
}

/* ---------- gestor "Mapas sin conexión" ---------- */
var modal = null, modalCuerpo = null, vistaGestor = "catalogo";
/* ---------- v2.70: pedir un mapa nuevo (solo administrador) ----------
   Lanza en GitHub el flujo "Nueva localidad de mapa" (nueva-localidad.yml), que corta el mapa base y el relieve,
   actualiza catalogo.json y publica. El token vive solo en este teléfono (Config, modo administrador). */
var LS_PEDIDO = "libretacampo_mapa_pedido_v1";
var pedido = leerJSON(LS_PEDIDO, null);   /* { runId, nombre, modo, url, estado, fin } */
var pedidoTimer = null, modalPedir = null;
function adminMapas() { return (LC && LC.mapaAdmin) ? LC.mapaAdmin() : null; }
function ghLlamar(a, ruta, op) {
  op = op || {};
  var h = { "Authorization": "Bearer " + a.token, "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (op.body) h["Content-Type"] = "application/json";
  return fetch("https://api.github.com" + ruta, { method: op.method || "GET", headers: h, body: op.body ? JSON.stringify(op.body) : undefined, cache: "no-store" });
}
function mensajeGh(r, cuerpo) {
  if (r.status === 401) return "El token no es válido o venció. Cámbialo en Config, Gestión de mapas.";
  if (r.status === 403 || r.status === 404) return "GitHub no permite la acción (" + r.status + "). Revisa que el token tenga el permiso «Actions: Read and write» sobre el repositorio.";
  if (r.status === 422) return "GitHub rechazó los datos" + (cuerpo && cuerpo.message ? ": " + cuerpo.message : ".");
  return "GitHub respondió " + r.status + (cuerpo && cuerpo.message ? ": " + cuerpo.message : ".");
}
var RADIO_MAX_KM = 60;   /* v2.79: antes 30. Con radios grandes el flujo baja solo el zoom del mapa base para no pasar el tope de MB */
function numDecimal(t) { var n = parseFloat(String(t == null ? "" : t).trim().replace(",", ".")); return isFinite(n) ? n : null; }
function validarPedido(d) {
  if (!d.nombre) return "Falta el nombre de la localidad.";
  if (!d.region) return "Falta la región.";
  var la = numDecimal(d.lat), lo = numDecimal(d.lon), ra = numDecimal(d.radio);
  if (la == null || la < -90 || la > 90) return "La latitud debe estar entre -90 y 90.";
  if (lo == null || lo < -180 || lo > 180) return "La longitud debe estar entre -180 y 180.";
  if (ra == null || ra < 0.5 || ra > RADIO_MAX_KM) return "El radio debe estar entre 0,5 y " + RADIO_MAX_KM + " km.";
  if (d.id && !/^[a-z0-9_]+$/.test(d.id)) return "El identificador solo admite minúsculas, números y guion bajo.";
  return null;
}
function guardarPedido() { if (pedido) guardarJSON(LS_PEDIDO, pedido); else { try { localStorage.removeItem(LS_PEDIDO); } catch (e) {} } }
function textoPedido() {
  if (!pedido) return "";
  var e = pedido.estado;
  if (e === "enviando") return "Enviando el pedido a GitHub…";
  if (e === "buscando") return "Pedido enviado. Esperando que GitHub lo inicie…";
  if (e === "en_curso") return "Preparando «" + pedido.nombre + "» en GitHub. Suele tardar entre 2 y 8 minutos. Puedes cerrar esta ventana.";
  if (pedido.modo === "borrar") {
    if (e === "enviando") return "Enviando el borrado a GitHub…";
    if (e === "buscando") return "Borrado enviado. Esperando que GitHub lo inicie…";
    if (e === "en_curso") return "Borrando «" + pedido.nombre + "» del catálogo en GitHub. Suele tardar 1 o 2 minutos. Puedes cerrar esta ventana.";
    if (e === "ok") return "✅ «" + pedido.nombre + "» borrado del catálogo. Si la lista aún lo muestra, espera un minuto y vuelve a abrir el gestor.";
  }
  if (e === "ok") return pedido.modo === "solo_medir" ? "Medición lista. Revisa el resumen en GitHub (no se publicó nada)." : "✅ «" + pedido.nombre + "» publicado. Ya está en el catálogo.";
  if (e === "fallo") return "El pedido terminó con error" + (pedido.detalle ? " (" + pedido.detalle + ")" : "") + ". Revisa el detalle en GitHub.";
  return "";
}
async function sondearPedido() {
  clearTimeout(pedidoTimer); pedidoTimer = null;
  var a = adminMapas(); if (!a || !pedido || pedido.fin) return;
  try {
    if (!pedido.runId) {
      var rl = await ghLlamar(a, "/repos/" + a.repo + "/actions/workflows/" + (pedido.workflow || a.workflow) + "/runs?event=workflow_dispatch&per_page=10");
      var jl = await rl.json();
      if (!rl.ok) throw new Error(mensajeGh(rl, jl));
      var titulo = pedido.titulo || ("Mapa: " + pedido.nombre + " (" + pedido.modo + ")");
      var hit = (jl.workflow_runs || []).filter(function (w) { return Date.parse(w.created_at) >= pedido.t0 - 90000 && (w.display_title === titulo || w.name === titulo); })[0];
      if (hit) { pedido.runId = hit.id; pedido.url = hit.html_url; pedido.estado = "en_curso"; guardarPedido(); }
      else if (Date.now() - pedido.t0 > 180000) { pedido.estado = "fallo"; pedido.detalle = "GitHub no inició el flujo"; pedido.fin = true; guardarPedido(); renderGestor(); return; }
    } else {
      var rr = await ghLlamar(a, "/repos/" + a.repo + "/actions/runs/" + pedido.runId);
      var jr = await rr.json();
      if (!rr.ok) throw new Error(mensajeGh(rr, jr));
      pedido.url = jr.html_url || pedido.url;
      if (jr.status === "completed") {
        pedido.fin = true; pedido.estado = jr.conclusion === "success" ? "ok" : "fallo"; pedido.detalle = jr.conclusion === "success" ? "" : (jr.conclusion || "");
        guardarPedido();
        if (pedido.estado === "ok") {
          LC.toast(pedido.modo === "solo_medir" ? "📏 Medición lista" : pedido.modo === "borrar" ? "🗑 Mapa borrado del catálogo" : "🗺️ Mapa nuevo publicado", 5000);
          if (pedido.modo !== "solo_medir") { await cargarCatalogo(); await leerAlmacenamiento(); refrescarUI(); }
        } else LC.toast("El pedido de mapa terminó con error", 6000);
        renderGestor(); return;
      }
      if (Date.now() - pedido.t0 > 40 * 60000) { pedido.estado = "fallo"; pedido.detalle = "pasó demasiado tiempo"; pedido.fin = true; guardarPedido(); renderGestor(); return; }
    }
  } catch (e) { anotarError("pedido de mapa", e); }
  renderGestor();
  pedidoTimer = setTimeout(sondearPedido, pedido.runId ? 10000 : 5000);
}
async function enviarPedido(d) {
  var a = adminMapas(); if (!a) return "No hay token de administrador en este teléfono.";
  if (pedido && !pedido.fin) return "Ya hay un pedido en curso.";
  var err = validarPedido(d); if (err) return err;
  if (!online) return "Sin conexión. Necesitas internet para pedir un mapa.";
  var inputs = {
    nombre: d.nombre, region: d.region, latitud: String(numDecimal(d.lat)), longitud: String(numDecimal(d.lon)), radio_km: String(numDecimal(d.radio)),
    id: d.id || "", zoom_base: String(d.zoom || "15"), max_mb: String(d.maxmb || "30"), modo: d.soloMedir ? "solo_medir" : "publicar"
  };
  pedido = { runId: null, nombre: d.nombre, modo: inputs.modo, titulo: "Mapa: " + d.nombre + " (" + inputs.modo + ")", url: "", estado: "enviando", fin: false, t0: Date.now() };
  renderGestor();
  try {
    var r = await ghLlamar(a, "/repos/" + a.repo + "/actions/workflows/" + a.workflow + "/dispatches", { method: "POST", body: { ref: a.ref, inputs: inputs } });
    var cuerpo = null; try { cuerpo = await r.json(); } catch (e) {}
    if (!r.ok) { var m = mensajeGh(r, cuerpo); pedido = null; guardarPedido(); renderGestor(); return m; }
    pedido.estado = "buscando";
    var id = cuerpo && (cuerpo.workflow_run_id || cuerpo.id);
    if (id) { pedido.runId = id; pedido.url = cuerpo.html_url || cuerpo.run_url || ""; pedido.estado = "en_curso"; }
    guardarPedido(); renderGestor();
    pedidoTimer = setTimeout(sondearPedido, 4000);
    return null;
  } catch (e) {
    anotarError("pedido de mapa", e); pedido = null; guardarPedido(); renderGestor();
    return "No se pudo contactar a GitHub. Revisa la conexión.";
  }
}
/* v2.83: borrar un mapa del catálogo (solo administrador). Lanza el flujo borrar-localidad.yml del repositorio de mapas, que quita la
   entrada de catalogo.json y los archivos que ningún otro mapa usa. El flujo debe existir en el repositorio (ver Guía de mapas). */
var WORKFLOW_BORRAR = "borrar-localidad.yml";
async function enviarBorrado(entrada) {
  var a = adminMapas(); if (!a) return "No hay token de administrador en este teléfono.";
  if (pedido && !pedido.fin) return "Ya hay un pedido en curso. Espera a que termine.";
  if (!online) return "Sin conexión. Necesitas internet para borrar un mapa del catálogo.";
  pedido = { runId: null, nombre: entrada.nombre, modo: "borrar", workflow: WORKFLOW_BORRAR, titulo: "Borrar mapa: " + entrada.id, url: "", estado: "enviando", fin: false, t0: Date.now() };
  renderGestor();
  try {
    var r = await ghLlamar(a, "/repos/" + a.repo + "/actions/workflows/" + WORKFLOW_BORRAR + "/dispatches", { method: "POST", body: { ref: a.ref, inputs: { id: entrada.id } } });
    var cuerpo = null; try { cuerpo = await r.json(); } catch (e) {}
    if (!r.ok) {
      pedido = null; guardarPedido(); renderGestor();
      if (r.status === 404) return "GitHub no encontró el flujo «" + WORKFLOW_BORRAR + "» en el repositorio. Agrégalo una vez (carpeta .github/workflows) con el archivo que acompaña esta versión.";
      return mensajeGh(r, cuerpo);
    }
    pedido.estado = "buscando";
    var id = cuerpo && (cuerpo.workflow_run_id || cuerpo.id);
    if (id) { pedido.runId = id; pedido.url = cuerpo.html_url || cuerpo.run_url || ""; pedido.estado = "en_curso"; }
    guardarPedido(); renderGestor();
    pedidoTimer = setTimeout(sondearPedido, 4000);
    return null;
  } catch (e) {
    anotarError("borrado de mapa", e); pedido = null; guardarPedido(); renderGestor();
    return "No se pudo contactar a GitHub. Revisa la conexión.";
  }
}
function cerrarPedir() { if (modalPedir) modalPedir.classList.remove("on"); }
function abrirPedir() {
  if (!adminMapas()) { LC.toast("Este teléfono no tiene el modo administrador"); return; }
  if (!modalPedir) {
    modalPedir = el("div", { class: "modal-bg", id: "mp-modal-pedir" });
    modalPedir.addEventListener("click", function (e) { if (e.target === modalPedir) cerrarPedir(); });
    document.body.appendChild(modalPedir);
  }
  modalPedir.textContent = "";
  var campo = function (rot, id, ayuda, attrs) {
    var inp = el("input", Object.assign({ type: "text", id: id, autocomplete: "off", autocapitalize: "off", spellcheck: "false" }, attrs || {}));
    return { inp: inp, nodo: el("div", { class: "field" }, [el("label", { texto: rot, for: id }), inp, ayuda ? el("span", { class: "campo-ayuda", texto: ayuda }) : null]) };
  };
  var fNom = campo("Nombre de la localidad", "ped-nombre", "Ej.: La Higuera, Elqui. El identificador se arma con el texto antes de la coma.", { autocapitalize: "words" });
  var fReg = campo("Región", "ped-region", "Ej.: Región de Coquimbo", { autocapitalize: "words" });
  var fLat = campo("Latitud del centro", "ped-lat", null, { inputmode: "decimal" });
  var fLon = campo("Longitud del centro", "ped-lon", null, { inputmode: "decimal" });
  var fRad = campo("Radio (km)", "ped-radio", "Entre 0,5 y " + RADIO_MAX_KM + ". Se agregan 0,5 km de margen. Con radios grandes baja el zoom del mapa base o sube el tope de MB.", { inputmode: "decimal", value: "8" });
  var fId = campo("Identificador (opcional)", "ped-id", "Vacío: se arma con el nombre.");
  var fZ = campo("Zoom máximo del mapa base", "ped-zoom", "13 a 15. Baja solo si se supera el tope.", { inputmode: "numeric", value: "15" });
  var fMb = campo("Tope de tamaño (MB)", "ped-maxmb", "Base más relieve.", { inputmode: "numeric", value: "30" });
  var chk = el("input", { type: "checkbox", id: "ped-medir" });
  var msg = el("p", { class: "campo-ayuda", id: "ped-msg", style: "min-height:1.2em;" });
  var leer = function () {
    return { nombre: fNom.inp.value.trim(), region: fReg.inp.value.trim(), lat: fLat.inp.value, lon: fLon.inp.value, radio: fRad.inp.value, id: fId.inp.value.trim(), zoom: fZ.inp.value.trim(), maxmb: fMb.inp.value.trim(), soloMedir: chk.checked };
  };
  var ponerCentro = function (lat, lon, quien) { fLat.inp.value = lat.toFixed(6); fLon.inp.value = lon.toFixed(6); msg.textContent = "Centro tomado de " + quien + "."; };
  var bCentro = el("button", { type: "button", texto: "🗺️ Centro del mapa", onclick: function () {
    if (!map || !mapaListo) { msg.textContent = "Abre la pestaña Mapa para usar su centro."; return; }
    var c = map.getCenter(); ponerCentro(c.lat, c.lng, "la vista del mapa");
  } });
  var bGps = el("button", { type: "button", texto: "📡 Mi posición", onclick: function () {
    if (gps.fix) { ponerCentro(gps.fix.lat, gps.fix.lng, "tu GPS (±" + Math.round(gps.fix.acc) + " m)"); return; }
    if (!navigator.geolocation) { msg.textContent = "Este navegador no entrega la posición."; return; }
    msg.textContent = "Buscando tu posición…";
    navigator.geolocation.getCurrentPosition(function (p) { ponerCentro(p.coords.latitude, p.coords.longitude, "tu GPS (±" + Math.round(p.coords.accuracy) + " m)"); }, function () { msg.textContent = "No se pudo obtener la posición."; }, { enableHighAccuracy: true, timeout: 20000 });
  } });
  var bEnviar = el("button", { type: "button", class: "primario", texto: "Pedir mapa", onclick: async function () {
    var d = leer(), e = validarPedido(d);
    if (e) { msg.textContent = e; return; }
    if (!confirm("¿Pedir el mapa «" + d.nombre + "»?\n\nCentro " + numDecimal(d.lat) + ", " + numDecimal(d.lon) + " · radio " + numDecimal(d.radio) + " km." + (d.soloMedir ? "\n\nSolo se mide: no se publica nada." : "\n\nSe publicará en el catálogo de mapas."))) return;
    bEnviar.disabled = true; msg.textContent = "Enviando…";
    var r = await enviarPedido(d);
    if (r) { msg.textContent = r; bEnviar.disabled = false; } else cerrarPedir();
  } });
  var caja = el("div", { class: "modal" }, [
    el("div", { class: "mp-panel-cab mp-gestor-cab" }, [el("h2", { texto: "Pedir mapa nuevo", style: "margin:0;font-size:1.1rem;" }), el("button", { type: "button", class: "mp-panel-x", texto: "✕", "aria-label": "Cerrar", onclick: cerrarPedir })]),
    el("p", { class: "mp-suave", texto: "GitHub corta el mapa base y el relieve, actualiza el catálogo y lo publica. Después aparece en la lista para descargarlo." }),
    fNom.nodo, fReg.nodo, fLat.nodo, fLon.nodo,
    el("div", { class: "mp-fila", style: "margin:-4px 0 10px;" }, [bCentro, bGps]),
    fRad.nodo,
    el("label", { class: "mp-chk" }, [chk, el("span", { texto: "Solo medir el tamaño (no publica)" })]),
    el("details", { style: "margin:8px 0;" }, [el("summary", { texto: "Opciones avanzadas", style: "font-weight:700;cursor:pointer;" }), fId.nodo, fZ.nodo, fMb.nodo]),
    msg,
    el("div", { class: "mp-fila" }, [el("button", { type: "button", texto: "Cancelar", onclick: cerrarPedir }), bEnviar])
  ]);
  modalPedir.appendChild(caja);
  modalPedir.classList.add("on");
}
function cajaPedido() {
  if (!pedido) return null;
  var hijos = [el("p", { class: "mp-suave", texto: textoPedido() })];
  if (!pedido.fin) hijos.push(el("progress", { max: "1" }));
  var fila = [];
  if (pedido.url) fila.push(el("button", { type: "button", texto: "Ver en GitHub", onclick: function () { window.open(pedido.url, "_blank", "noopener"); } }));
  if (pedido.fin) fila.push(el("button", { type: "button", texto: "Cerrar aviso", onclick: function () { pedido = null; guardarPedido(); renderGestor(); } }));
  if (fila.length) hijos.push(el("div", { class: "mp-fila" }, fila));
  return el("div", { class: "mp-caja" }, [el("h3", { texto: "Pedido de mapa" })].concat(hijos));
}

function crearModal() {
  modal = el("div", { class: "modal-bg", id: "mp-modal-mapas" });
  var caja = el("div", { class: "modal" });
  /* v2.47: la X arriba a la derecha reemplaza al botón Cerrar del final (igual que en "Mis puntos") */
  caja.appendChild(el("div", { class: "mp-panel-cab mp-gestor-cab" }, [
    el("h2", { texto: "Mapas sin conexión", style: "margin:0;font-size:1.1rem;" }),
    el("button", { type: "button", class: "mp-panel-x", texto: "✕", "aria-label": "Cerrar", onclick: cerrarGestor })]));
  modalCuerpo = el("div", { id: "mp-modal-cuerpo" });
  caja.appendChild(modalCuerpo);
  modal.appendChild(caja);
  modal.addEventListener("click", function (e) { if (e.target === modal) cerrarGestor(); });
  document.body.appendChild(modal);
}
function abrirGestor(vista) {
  if (!modal) crearModal();
  vistaGestor = vista === "mapas" || !vista ? "catalogo" : vista;   /* v2.92: "mapas" se conserva como alias de la pestaña Mapas sin conexión */
  modal.classList.add("on");
  leerAlmacenamiento().then(renderGestor);
  renderGestor();
}
function cerrarGestor() { if (modal) modal.classList.remove("on"); }
function gestorAbierto() { return !!(modal && modal.classList.contains("on")); }

var busquedaMapas = "";
function normBusqueda(t) { return String(t == null ? "" : t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim(); }

function tarjetaMapa(entrada, enCatalogo) {
  var id = entrada.id, i = inst[id], cuerpo = [];
  cuerpo.push(el("h3", { texto: entrada.nombre }));
  cuerpo.push(el("p", { class: "mp-suave", texto: (entrada.region || "") + " · versión " + (entrada.version || "?") }));
  var lista = archivosDe(entrada);
  if (lista.length) cuerpo.push(el("p", { class: "mp-suave", texto: "Tamaño: " + mb(totalBytes(entrada)) + " (" + lista.map(function (a) { return a.tipo + " " + mb(a.bytes || 0); }).join(", ") + ")" }));
  var cdis = capasDe(entrada);
  if (cdis.length) cuerpo.push(el("p", { class: "mp-suave", texto: "Capas (" + cdis.length + "): " + cdis.map(function (c) { return c.nombre || c.id; }).join(", ") }));
  var nUso = sesionesQueUsan(id);
  if (nUso) cuerpo.push(el("p", { class: "mp-suave", texto: "Asociado a " + nUso + " sesión(es)." }));
  if (desc && desc.id === id) {
    cuerpo.push(el("progress", { max: String(desc.total || 1), value: String(desc.hecho) }));
    cuerpo.push(el("p", { class: "mp-suave", texto: "Descargando " + Math.round(desc.hecho / (desc.total || 1) * 100) + "% (" + mb(desc.hecho) + " de " + mb(desc.total) + ")" }));
    cuerpo.push(el("div", { class: "mp-fila" }, [el("button", { texto: "Cancelar descarga", onclick: function () { desc.ctrl.abort(); } })]));
  } else {
    var fila = [];
    if (i) {
      cuerpo.push(el("p", { class: "mp-suave", texto: "Instalado, versión " + i.version + ", guardado " + i.fecha + "" }));
      var chkAct = el("input", { type: "checkbox" }); chkAct.checked = mapaActivo(id);
      chkAct.onchange = function () { ponerMapaActivo(id, chkAct.checked); };
      cuerpo.push(el("label", { class: "mp-chk" }, [chkAct, el("span", { texto: "Mostrar en el mapa" })]));
      var nLoc = capasLoc.filter(function (c) { return c.mapaId === id; }).length;
      cuerpo.push(el("p", { class: "mp-suave", texto: "Capas instaladas: " + (i.capas || []).length + (nLoc ? " · importadas: " + nLoc : "") }));
      var hayVersion = enCatalogo && entrada.version && entrada.version !== i.version, pend = enCatalogo ? capasPendientes(entrada) : [];
      if (hayVersion) fila.push(el("button", { class: "primario", texto: "Actualizar a " + entrada.version, disabled: online ? null : "disabled", onclick: function () { descargarMapa(entrada); } }));
      else if (pend.length) fila.push(el("button", { class: "primario", texto: "Descargar capas (" + pend.length + ")", disabled: online ? null : "disabled", onclick: function () { descargarMapa(entrada, true); } }));
      fila.unshift(el("button", { texto: "🗺️ Ver en el mapa", onclick: function () { verMapa(id); } }));
      fila.push(el("button", { texto: "Eliminar", onclick: function () {
        if (confirm("¿Eliminar el mapa guardado en el teléfono?\n" + entrada.nombre + (nUso ? "\n\nHay " + nUso + " sesión(es) asociadas; seguirán apuntando a él hasta que lo vuelvas a descargar." : "") + (nLoc ? "\n\nSe eliminarán también las " + nLoc + " capa(s) importadas asociadas a este mapa. Si las necesitas, vuelve a importarlas desde su archivo original." : ""))) eliminarMapa(id);
      } }));
    } else if (enCatalogo) {
      var b = el("button", { class: "primario", texto: "Descargar (" + mb(totalBytes(entrada)) + ")", onclick: function () { descargarMapa(entrada); } });
      if (!online || desc) b.setAttribute("disabled", "disabled");
      fila.push(b);
    }
    cuerpo.push(el("div", { class: "mp-fila" }, fila));
    if (enCatalogo && adminMapas()) {
      cuerpo.push(el("div", { class: "mp-fila" }, [el("button", { class: "peligro", texto: "🗑 Borrar del catálogo (administrador)", disabled: online && !(pedido && !pedido.fin) ? null : "disabled", onclick: async function () {
        if (!confirm("¿Borrar «" + entrada.nombre + "» del CATÁLOGO PÚBLICO?\n\nSe quita de la lista y se eliminan sus archivos del repositorio de mapas. Nadie más podrá descargarlo. Los teléfonos que ya lo tienen instalado lo conservan.\n\nPara reemplazarlo, bórralo y luego pídelo de nuevo con «Pedir mapa nuevo».")) return;
        var t = prompt("Para confirmar, escribe el identificador del mapa:\n" + id);
        if (t == null) return;
        if (t.trim() !== id) { LC.toast("El identificador no coincide. No se borró nada.", 4500); return; }
        var r = await enviarBorrado(entrada);
        if (r) alert(r);
      } })]));
    }
  }
  return el("div", { class: "mp-caja" + (i && !mapaActivo(id) ? " inactivo" : "") }, cuerpo);
}

function infoDiag() {
  var L = [];
  L.push("Libreta de Campo · mapa · " + LC.appBuild);
  L.push("Fecha: " + fechaHM());
  L.push("Navegador: " + navigator.userAgent);
  L.push("Pantalla: " + screen.width + "x" + screen.height + " px, factor " + (window.devicePixelRatio || 1) + ", ventana " + innerWidth + "x" + innerHeight);
  L.push("Instalada como app: " + ((window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone ? "sí" : "no"));
  L.push("Conexión: " + (online ? "en línea" : "sin conexión") + ". Service worker: " + (navigator.serviceWorker && navigator.serviceWorker.controller ? "activo" : "no activo"));
  L.push("Almacenamiento de mapas: " + Alm.modo());
  L.push("Espacio: usado " + (almEst.usado != null ? mb(almEst.usado) : "?") + " de " + (almEst.cuota != null ? mb(almEst.cuota) : "?") + ". Protegido: " + (almEst.protegido == null ? "?" : almEst.protegido ? "sí" : "no"));
  L.push("Mapas instalados: " + (Object.keys(inst).map(function (k) { return inst[k].nombre + " v" + inst[k].version; }).join("; ") || "ninguno"));
  L.push("Mapas mostrados a la vez: " + (Object.keys(inst).length || "ninguno") + ", con relieve " + relieveNombres.length + ". Apertura hasta imagen estable: " + (metricas.aperturaMs != null ? metricas.aperturaMs + " ms" : "sin medir"));
  metricas.descargas.forEach(function (d) { L.push("Descarga: " + mb(d.bytes) + " en " + d.seg.toFixed(1) + " s (" + (d.bytes / 1048576 / d.seg).toFixed(2) + " MB/s)"); });
  if (tiemposCurvas.length) {
    var ps = tiemposCurvas.map(function (x) { return x.proc; }).sort(function (a, b) { return a - b; });
    var prom = function (k) { return Math.round(tiemposCurvas.reduce(function (s, x) { return s + x[k]; }, 0) / tiemposCurvas.length); };
    L.push("Curvas de nivel (" + tiemposCurvas.length + " teselas calculadas): total medio " + prom("dur") + " ms, trazado medio " + prom("proc") + " ms, peor trazado " + Math.round(ps[ps.length - 1]) + " ms");
  } else L.push("Curvas de nivel: aún sin teselas calculadas");
  L.push("Fluidez: " + (metricas.fluidez || "sin medir"));
  L.push("GPS último: " + (metricas.gpsUltimo ? "±" + metricas.gpsUltimo.acc + " m a las " + metricas.gpsUltimo.hora : "sin lectura"));
  L.push("Batería: " + (bateria || "sin dato"));
  L.push("Capas del mapa abierto: " + capasActuales.length + " (catálogo " + capasActuales.filter(function (c) { return c.origen === "catalogo"; }).length + ", importadas " + capasActuales.filter(function (c) { return c.origen === "local"; }).length + ")");
  L.push("Registros con coordenadas: " + geoPuntos().features.length + " de " + LC.state.registros.length);
  L.push("Errores recientes: " + (errores.length ? "\n  " + errores.join("\n  ") : "ninguno"));
  return L.join("\n");
}
if (navigator.getBattery) navigator.getBattery().then(function (b) {
  function f() { bateria = Math.round(b.level * 100) + "% " + (b.charging ? "(cargando)" : "(descargando)"); }
  f(); b.addEventListener("levelchange", f); b.addEventListener("chargingchange", f);
});

function pruebaFluidez() {
  if (!map || !Object.keys(inst).length) { LC.toast("Instala un mapa primero"); return; }
  cerrarGestor();
  if (LC.state.currentView !== "mapa") { LC.irA("mapa"); }
  var dur = 15000, t0 = performance.now(), last = t0, dts = [], fin = false;
  var c = map.getCenter(), z0 = map.getZoom();
  var pasos = [[0.012, 0.006, 14.5], [-0.012, 0.009, 13], [-0.01, -0.008, 15], [0.01, -0.006, 12.5], [0, 0, z0]], k = 0;
  LC.toast("Prueba de fluidez: 15 s, no toques el mapa", 15000);
  function paso() {
    if (fin) return;
    var p = pasos[k++ % pasos.length];
    map.easeTo({ center: [c.lng + p[0], c.lat + p[1]], zoom: p[2], duration: 2600, easing: function (t) { return t; } });
    map.once("moveend", paso);
  }
  function loop(t) {
    dts.push(t - last); last = t;
    if (t - t0 < dur) requestAnimationFrame(loop);
    else {
      fin = true; map.stop();
      var orden = dts.slice().sort(function (a, b) { return a - b; });
      var p95 = orden[Math.floor(orden.length * 0.95)] || 0, max = orden[orden.length - 1] || 0;
      var lentos = dts.filter(function (x) { return x > 50; }).length;
      metricas.fluidez = (dts.length / ((t - t0) / 1000)).toFixed(1) + " cuadros/s en promedio, p95 " + p95.toFixed(0) + " ms, peor " + max.toFixed(0) + " ms, " + lentos + " cuadros sobre 50 ms (movimiento automático, " + (gps.watch != null ? "con GPS" : "sin GPS") + ")";
      abrirGestor("diag");
    }
  }
  paso(); requestAnimationFrame(loop);
}

function entradasMapas() {
  var entradas = [], vistos = {};
  if (cat) cat.mapas.forEach(function (e) { vistos[e.id] = 1; entradas.push({ e: e, enCat: true }); });
  Object.keys(inst).forEach(function (id) {
    if (vistos[id]) return;
    entradas.push({ e: { id: id, nombre: inst[id].nombre, region: inst[id].region, version: inst[id].version, archivos: inst[id].archivos.map(function (a) { return { tipo: a.tipo, bytes: a.bytes }; }) }, enCat: false });
  });
  return entradas;
}
function renderGestor() {
  if (!modal || !gestorAbierto()) return;
  var cu = modalCuerpo, sc = cu.scrollTop;
  cu.textContent = "";
  var nInst = Object.keys(inst).length;
  var pestanas = el("div", { class: "mp-fila mp-pestanas", style: "margin:0 0 10px;" }, [
    el("button", { class: vistaGestor === "catalogo" ? "primario" : "", texto: "Mapas sin conexión", onclick: function () { vistaGestor = "catalogo"; renderGestor(); } }),
    el("button", { class: vistaGestor === "mis" ? "primario" : "", texto: "Mis mapas", onclick: function () { vistaGestor = "mis"; renderGestor(); } }),
    el("button", { class: vistaGestor === "capas" ? "primario" : "", texto: "Mis capas", onclick: function () { vistaGestor = "capas"; renderGestor(); } })
  ]);
  cu.appendChild(pestanas);
  if (vistaGestor === "catalogo") {
    var cajaBusca = el("div", { class: "mp-busca" });   /* v2.58: buscador destacado, fijo arriba de la lista */
    cu.appendChild(cajaBusca);
    var entradas = entradasMapas().filter(function (x) { return !inst[x.e.id]; });
    var nAct = entradasMapas().filter(function (x) { var i = inst[x.e.id]; return i && x.enCat && x.e.version && x.e.version !== i.version; }).length;
    cu.appendChild(el("div", { class: "mp-caja" }, [
      el("p", { class: "mp-suave", texto: "Con conexión, el mapa usa imágenes satelitales. Los mapas descargados permiten usarlo donde no hay señal." }),
      el("p", { class: "mp-suave", texto: (online ? "En línea. " : "Sin conexión. ") + catInfo }),
      el("p", { class: "mp-suave", texto: "Espacio usado por la app: " + (almEst.usado != null ? mb(almEst.usado) : "?") + " de " + (almEst.cuota != null ? mb(almEst.cuota) : "?") + ". Almacenamiento protegido: " + (almEst.protegido == null ? "sin dato" : almEst.protegido ? "sí" : "no") + "." }),
      nAct ? el("p", { class: "mp-suave", texto: "Hay " + nAct + (nAct === 1 ? " actualización disponible" : " actualizaciones disponibles") + ". Se instalan desde la pestaña Mis mapas." }) : null,
      el("div", { class: "mp-fila" }, [
        el("button", { texto: "Actualizar catálogo", disabled: online ? null : "disabled", onclick: async function () { await cargarCatalogo(); await leerAlmacenamiento(); refrescarUI(); } }),
        almEst.protegido === false ? el("button", { texto: "Pedir protección", onclick: async function () { try { await navigator.storage.persist(); } catch (e) {} await leerAlmacenamiento(); renderGestor(); } }) : null,
        adminMapas() ? el("button", { class: "primario", texto: "➕ Pedir mapa nuevo", disabled: (online && !(pedido && !pedido.fin)) ? null : "disabled", onclick: abrirPedir }) : null,
        el("button", { texto: "🛠 Diagnóstico", onclick: function () { vistaGestor = "diag"; renderGestor(); } })
      ])
    ]));
    if (adminMapas() && pedido) cu.appendChild(cajaPedido());
    if (!online) cu.appendChild(el("p", { class: "mp-suave", texto: "Sin conexión solo puedes usar o eliminar los mapas instalados." }));
    /* Buscador: filtra por nombre, región, versión o nombre de capa, sin tildes ni mayúsculas.
       Solo se vuelve a dibujar la lista (no la caja), para no perder el foco del teclado al escribir. */
    var listaCat = el("div", { class: "mp-bloque mp-bloque-cat" });
    var cuenta = el("p", { class: "mp-suave", style: "margin:6px 0 0;" });
    var pintarLista = function () {
      var q = normBusqueda(busquedaMapas), nC = 0;
      listaCat.textContent = "";
      var hC = el("h3", { class: "mp-bloque-tit" });
      listaCat.appendChild(hC); listaCat.appendChild(el("p", { class: "mp-bloque-sub", texto: "Todavía no están en este teléfono. Se descargan con internet." }));
      entradas.forEach(function (x) {
        if (q) {
          var pajar = normBusqueda([x.e.nombre, x.e.region, x.e.version, x.e.id].concat(capasDe(x.e).map(function (c) { return c.nombre || c.id; })).join(" "));
          if (q.split(" ").some(function (t) { return t && pajar.indexOf(t) < 0; })) return;
        }
        nC++; listaCat.appendChild(tarjetaMapa(x.e, x.enCat));
      });
      hC.textContent = "Catálogo: mapas disponibles (" + (q ? nC + " de " + entradas.length : entradas.length) + ")";
      if (!nC) listaCat.appendChild(el("p", { class: "mp-suave", texto: q ? "Ningún mapa del catálogo coincide con «" + busquedaMapas.trim() + "»." : (cat ? "Todos los mapas disponibles ya están descargados." : "Sin catálogo. Conéctate para verlo.") }));
      cuenta.textContent = q ? nC + " de " + entradas.length + " mapas" : entradas.length + " mapas";
    };
    var buscador = el("input", { type: "search", placeholder: "Nombre, región, versión o capa…", autocomplete: "off", autocapitalize: "off", spellcheck: "false", class: "mp-busca-input" });
    buscador.value = busquedaMapas;
    buscador.addEventListener("input", function () { busquedaMapas = buscador.value; pintarLista(); });
    cajaBusca.appendChild(el("label", { class: "mp-busca-rot", texto: "🔍 Buscar en el catálogo de mapas" }));
    cajaBusca.appendChild(buscador);
    cajaBusca.appendChild(cuenta);
    cu.appendChild(listaCat);
    pintarLista();
  } else if (vistaGestor === "mis") {
    var misE = entradasMapas().filter(function (x) { return !!inst[x.e.id]; }).sort(function (a, b) { return String(a.e.nombre).localeCompare(String(b.e.nombre)); });
    var listaDesc = el("div", { class: "mp-bloque mp-bloque-desc" });
    listaDesc.appendChild(el("h3", { class: "mp-bloque-tit", texto: "Mapas descargados (" + misE.length + ")" }));
    listaDesc.appendChild(el("p", { class: "mp-bloque-sub", texto: "Guardados en este teléfono. Funcionan sin conexión. La casilla muestra u oculta cada mapa." }));
    if (!misE.length) listaDesc.appendChild(el("p", { class: "mp-suave", texto: "No hay mapas descargados. Descárgalos en la pestaña Mapas sin conexión." }));
    misE.forEach(function (x) { listaDesc.appendChild(tarjetaMapa(x.e, x.enCat)); });
    if (idsActivos().length) listaDesc.appendChild(el("div", { class: "mp-fila", style: "margin:10px;" }, [el("button", { texto: "🗺️ Ver todos en el mapa", onclick: function () { verTodosLosMapas(); cerrarGestor(); if (LC.state.currentView !== "mapa") LC.irA("mapa"); } })]));
    cu.appendChild(listaDesc);
    var tieneRel = relieveNombres.length > 0 || mapasOrdenados().some(function (m) { return archivoTipo(m, "relieve"); });
    var chk = function (clave, texto, habil) {
      var inp = el("input", { type: "checkbox" }); inp.checked = (clave === "topo" || clave === "calles") ? capasVis[clave] !== false : !!capasVis[clave]; if (!habil) inp.disabled = true;
      inp.onchange = function () {
        capasVis[clave] = inp.checked; guardarJSON(LS_CAPAS, capasVis);
        var v = inp.checked ? "visible" : "none";
        if (!map || !mapaListo) return;
        if (clave === "sombra" && map.getLayer("relieve-sombra")) map.setLayoutProperty("relieve-sombra", "visibility", v);
        if (clave === "curvas") ["curvas-linea", "curvas-texto"].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); });
        if (clave === "topo") aplicarVisBase();
        if (clave === "calles") { resolverCalles(); botonesBase(); if (LC.state.currentView === "mapa" && estiloFirma !== firmaMapas()) aplicarMapas().then(function () { refrescarPuntos(); }); }
      };
      return el("label", { class: "mp-chk" }, [inp, el("span", { texto: texto })]);
    };
    cu.appendChild(el("h3", { texto: "Visualización", style: "margin:16px 0 6px;font-size:1rem;" }));
    cu.appendChild(chk("calles", "Calles, direcciones y lugares en línea (donde no hay mapa descargado)", true));
    cu.appendChild(el("p", { class: "mp-suave", style: "margin:0 0 8px 28px;", texto: "Usa OpenStreetMap vía OpenFreeMap. Necesita conexión; los mapas descargados tienen prioridad y siguen funcionando sin internet." }));
    cu.appendChild(chk("sombra", "Sombreado del relieve", tieneRel));
    cu.appendChild(chk("curvas", "Curvas de nivel (calculadas en el teléfono)", tieneRel));
    var selCurv = el("select", { id: "mp-curvas-color" });
    selCurv.appendChild(el("option", { value: "auto", texto: "Automático (marrón en el mapa, amarillo en el satélite)" }));
    Object.keys(CURVAS_COLORES).forEach(function (k) { selCurv.appendChild(el("option", { value: k, texto: CURVAS_COLORES[k].rot })); });
    selCurv.value = capasVis.curvasColor && CURVAS_COLORES[capasVis.curvasColor] ? capasVis.curvasColor : "auto";
    selCurv.onchange = function () {
      capasVis.curvasColor = selCurv.value; guardarJSON(LS_CAPAS, capasVis);
      if (!map || !mapaListo) return;
      var pal = paletaCurvas(satActivo());
      if (map.getLayer("curvas-linea")) map.setPaintProperty("curvas-linea", "line-color", pal.c);
      if (map.getLayer("curvas-texto")) { map.setPaintProperty("curvas-texto", "text-color", pal.t); map.setPaintProperty("curvas-texto", "text-halo-color", pal.h); }
    };
    cu.appendChild(el("div", { class: "field" }, [el("label", { texto: "Color de las curvas de nivel", for: "mp-curvas-color" }), selCurv]));
    cu.appendChild(chk("topo", "Nombres de lugares (poblados, áreas protegidas, cerros y puntos de interés)", true));
    if (!tieneRel) cu.appendChild(el("p", { class: "mp-suave", texto: "Ninguno de los mapas instalados trae relieve." }));
  } else if (vistaGestor === "capas") {
    cu.appendChild(el("p", { class: "mp-suave", texto: "Aquí están las capas del catálogo y las que creaste con «Guardar como capa» o subiste desde un archivo. La casilla las muestra u oculta en el mapa. Las creadas o subidas pueden asociarse a un mapa descargado o quedar sin mapa, se pueden descargar (GeoJSON, GPX o CSV) y vincular a una sesión o proyecto. Solo se guardan en este teléfono." }));
    {
      if (!capasActuales.length) cu.appendChild(el("p", { class: "mp-suave", texto: "Todavía no hay capas." }));
      var mapaGrupo = null;
      capasActuales.forEach(function (c) {
        if (c.mapaId !== mapaGrupo) { mapaGrupo = c.mapaId; cu.appendChild(el("div", { class: "mp-panel-grupo", texto: !c.mapaId ? "Capas sin mapa" : (inst[c.mapaId] ? inst[c.mapaId].nombre : c.mapaId) })); }
        var inp = el("input", { type: "checkbox" }); inp.checked = visCapa(c.clave);
        inp.onchange = function () {
          if (!capasVis.capas) capasVis.capas = {};
          capasVis.capas[c.clave] = inp.checked; guardarJSON(LS_CAPAS, capasVis); aplicarFiltrosCapas();
        };
        var enV = c.origen === "local" ? capasLoc.filter(function (x) { return x.id === c.id; })[0] : null;
        var sub = resumenCuenta(c.datos.cuenta) + (c.origen === "local" ? " · creada o subida, solo en este teléfono" : " · del catálogo") + (enV && enV.vinculo ? " · 🔗 " + nombreVinculo(enV.vinculo) : "");
        var texto = el("span", {}, [el("b", { texto: c.nombre }), el("br"), el("span", { class: "mp-suave", texto: sub })]);
        var fila = [el("label", { class: "mp-chk", style: "flex:1;" }, [inp, texto])];
        var caja = el("div", { style: "display:flex;align-items:center;gap:8px;" }, fila);
        if (c.origen === "local") caja.appendChild(el("button", { texto: "Eliminar", style: "min-height:40px;padding:0 10px;border-radius:10px;border:1px solid var(--borde);background:var(--card);color:var(--texto);font-weight:700;", onclick: function () { if (confirm("¿Eliminar la capa importada «" + c.nombre + "»?")) eliminarCapaLocal(c.id); } }));
        if (c.origen === "local") {
          var abierto = estiloAbierto === c.id;
          caja.insertBefore(el("button", { texto: "🎨 Estilo", style: "min-height:40px;padding:0 10px;border-radius:10px;border:1px solid var(--borde);background:" + (abierto ? "var(--verde-claro, #e3eedf)" : "var(--card)") + ";color:var(--texto);font-weight:700;", onclick: function () { estiloAbierto = abierto ? null : c.id; renderGestor(); } }), caja.lastChild);
        }
        if (c.origen === "local") caja.insertBefore(el("button", { texto: "⬇ Más", "aria-label": "Descargar o vincular la capa", style: "min-height:40px;padding:0 10px;border-radius:10px;border:1px solid var(--borde);background:" + (opcionesCapaAbierta === c.id ? "var(--verde-claro, #e3eedf)" : "var(--card)") + ";color:var(--texto);font-weight:700;", onclick: function () { opcionesCapaAbierta = opcionesCapaAbierta === c.id ? null : c.id; renderGestor(); } }), caja.lastChild);
        cu.appendChild(caja);
        if (c.origen === "local" && opcionesCapaAbierta === c.id && enV) {
          var selMapaC = el("select", {});
          selMapaC.appendChild(el("option", { value: "", texto: "Sin mapa" }));
          Object.keys(inst).sort().forEach(function (id) { selMapaC.appendChild(el("option", { value: id, texto: nombreCorto(inst[id].nombre) })); });
          selMapaC.value = enV.mapaId || "";
          selMapaC.onchange = async function () { enV.mapaId = selMapaC.value; guardarJSON(LS_CAPAS_LOC, capasLoc); await recargarCapas(); };
          var selVinc = selectorVinculo(enV.vinculo, function (v) { enV.vinculo = v; guardarJSON(LS_CAPAS_LOC, capasLoc); renderGestor(); });
          cu.appendChild(el("div", { class: "mp-estilo" }, [
            el("div", { class: "mp-suave", texto: "Descargar la capa" }),
            el("div", { class: "mp-fila" }, [
              el("button", { texto: "GeoJSON", onclick: function () { descargarCapaLocal(c.id, "geojson"); } }),
              el("button", { texto: "GPX", onclick: function () { descargarCapaLocal(c.id, "gpx"); } }),
              el("button", { texto: "CSV (solo puntos)", onclick: function () { descargarCapaLocal(c.id, "csv"); } })
            ]),
            el("label", {}, [el("span", { class: "mp-suave", texto: "Asociada al mapa" }), selMapaC]),
            el("label", {}, [el("span", { class: "mp-suave", texto: "Vinculada a (viaja en el .zip de esa sesión o proyecto)" }), selVinc])
          ]));
        }
        if (c.origen === "local" && estiloAbierto === c.id) cu.appendChild(panelEstiloCapa(c));
      });
      var inpArch = el("input", { type: "file", accept: ".csv,.tsv,.txt,text/csv,.geojson,.json,.gpx,.zip,application/geo+json,application/json,application/gpx+xml,application/zip", style: "display:none;" });
      var idsInst = Object.keys(inst).sort();
      if (mapaImportId !== "__sin" && (!mapaImportId || !inst[mapaImportId])) { var sA = LC.sesionActiva(); mapaImportId = sA && sA.mapaId && inst[sA.mapaId] ? sA.mapaId : (idsInst[0] || "__sin"); }
      var selImp = el("select", { id: "mp-import-sel" });
      selImp.appendChild(el("option", { value: "__sin", texto: "Sin mapa (capa independiente)" }));
      idsInst.forEach(function (id) { selImp.appendChild(el("option", { value: id, texto: nombreCorto(inst[id].nombre) })); });
      selImp.value = mapaImportId;
      selImp.onchange = function () { mapaImportId = selImp.value; };
      cu.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;margin:16px 0 6px;" }, [
        el("h3", { texto: "Importar una capa", style: "margin:0;font-size:1rem;" }),
        el("button", { type: "button", class: "mp-ayuda-btn" + (ayudaCsvAbierta ? " on" : ""), texto: "?", "aria-label": "Cómo preparar el CSV", onclick: function () { ayudaCsvAbierta = !ayudaCsvAbierta; renderGestor(); } })
      ]));
      if (ayudaCsvAbierta) cu.appendChild(el("div", { class: "mp-ayuda" }, [
        el("b", { texto: "Cómo preparar una planilla CSV" }),
        el("p", { texto: "Una fila de encabezados y una fila por punto. Se puede guardar desde Excel o Calc con «Guardar como… CSV»." }),
        el("p", { texto: "Columnas necesarias: latitud y longitud, en grados decimales (por ejemplo -41.4693 y -72.9424). Se reconocen los encabezados latitud, lat, longitud, lon, long y lng." }),
        el("p", { texto: "Columna recomendada: nombre (también sirve estacion, codigo, sitio o id). Es el texto que se ve junto al punto." }),
        el("p", { texto: "Columnas opcionales: descripcion, localidad, localidad_especifica o cualquier otra. Quedan como datos del punto y se ven al tocarlo." }),
        el("pre", { class: "mp-pre", texto: "nombre,latitud,longitud,descripcion\nE-01,-41.4693,-72.9424,Orilla del estero\nE-02,-41.4710,-72.9388,Bosque nativo" }),
        el("p", { texto: "Se acepta coma, punto y coma o tabulador como separador, y coma decimal (-41,4693). El nombre de la capa es el nombre del archivo. Las filas sin coordenadas válidas se omiten y la app avisa cuántas. Las coordenadas deben ser WGS 84; no se admiten grados, minutos y segundos ni UTM. Tras importar, el botón «🎨 Estilo» cambia color, forma y tamaño." })
      ]));
      cu.appendChild(el("p", { class: "mp-suave", texto: "Asociar la capa al mapa:" }));
      cu.appendChild(el("div", { class: "field" }, [selImp]));
      var vincImp = ""; cu.appendChild(el("p", { class: "mp-suave", texto: "Vincular a una sesión o proyecto (opcional):" }));
      cu.appendChild(el("div", { class: "field" }, [selectorVinculo("", function (v) { vincImp = v; })]));
      inpArch.onchange = function () { var f = inpArch.files && inpArch.files[0]; inpArch.value = ""; if (f) importarCapaLocal(f, mapaImportId === "__sin" ? "" : mapaImportId, vincImp); };
      cu.appendChild(inpArch);
      cu.appendChild(el("div", { class: "mp-fila" }, [el("button", { class: "primario", texto: "⬆️ Importar capa desde un archivo", onclick: function () { inpArch.click(); } })]));
      cu.appendChild(el("p", { class: "mp-suave", texto: "CSV (toca el «?» para ver el formato), GeoJSON, GPX o shapefile en .zip. El nombre de la capa es el del archivo. La capa puede quedar asociada a un mapa (se borra si eliminas ese mapa) o sin mapa. Solo se guarda en este teléfono y no se publica; si la vinculas a una sesión o proyecto, viaja en el .zip de esa sesión o proyecto. Útil para sitios sensibles." }));
    }
  } else {
    cu.appendChild(el("div", { class: "mp-fila", style: "margin:0 0 10px;" }, [el("button", { texto: "← Volver a Mapas sin conexión", onclick: function () { vistaGestor = "catalogo"; renderGestor(); } })]));
    cu.appendChild(el("pre", { class: "mp-pre", texto: infoDiag() }));
    cu.appendChild(el("div", { class: "mp-fila" }, [
      el("button", { texto: "Copiar informe", onclick: function () {
        var t = infoDiag();
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { LC.toast("Informe copiado"); }, function () { LC.toast("No se pudo copiar"); });
        else LC.toast("Este navegador no permite copiar");
      } }),
      el("button", { texto: "Prueba de fluidez (15 s)", onclick: pruebaFluidez }),
      el("button", { texto: "Apagar GPS", onclick: function () { gpsApagarManual(); } })
    ]));
  }
  cu.scrollTop = sc;
}

/* ---------- bloque "Mapa asociado" (pestaña Sesión) ---------- */
function estadoAsociado(s) {
  if (!s.mapaId) return { txt: "Sin mapa sin conexión asociado. Con internet, la pestaña Mapa usa el fondo satelital. Si esta zona no tiene señal de celular, asocia un mapa y descárgalo antes de salir: así la app te avisa si falta y te lleva a su zona al abrir la sesión.", cls: "" };
  if (desc && desc.id === s.mapaId) return { txt: "Descargando… " + Math.round(desc.hecho / (desc.total || 1) * 100) + "%", cls: "aviso" };
  if (inst[s.mapaId]) return { txt: "✅ Listo para salir: mapa instalado (" + mb(archivosDe(inst[s.mapaId]).reduce(function (t, a) { return t + (a.bytes || 0); }, 0)) + ", versión " + inst[s.mapaId].version + ").", cls: "ok" };
  var e = entradaCatalogo(s.mapaId);
  if (e) return { txt: "⚠️ Pendiente de instalar (" + mb(totalBytes(e)) + "). Hay que descargarlo con conexión antes de salir a terreno.", cls: "aviso" };
  return { txt: "⚠️ Este mapa no está instalado ni figura en el catálogo guardado. Actualiza el catálogo con conexión.", cls: "aviso" };
}
function renderAsociado(s) {
  var cont = $("sesion-mapa-asoc"); if (!cont || !s) return;
  cont.textContent = "";
  if (!LISTO) { cont.appendChild(el("p", { class: "campo-ayuda", texto: "🗺️ El mapa no está disponible: faltan archivos de la carpeta de apoyo." })); return; }
  var campo = el("div", { class: "mp-asoc-caja" });
  campo.appendChild(el("div", { class: "bloque-titulo", texto: "🗺️ Mapa sin conexión (opcional)" }));
  var sel = el("select", { id: "mp-asoc-sel" });
  sel.appendChild(el("option", { value: "", texto: "Sin mapa" }));
  var ids = [], vistos = {};
  if (cat) cat.mapas.forEach(function (m) { if (!vistos[m.id]) { vistos[m.id] = 1; ids.push({ id: m.id, nombre: m.nombre }); } });
  Object.keys(inst).forEach(function (id) { if (!vistos[id]) { vistos[id] = 1; ids.push({ id: id, nombre: inst[id].nombre }); } });
  if (s.mapaId && !vistos[s.mapaId]) ids.push({ id: s.mapaId, nombre: s.mapaId + " (no disponible)" });
  ids.forEach(function (m) { sel.appendChild(el("option", { value: m.id, texto: (inst[m.id] ? "✅ " : "⬇️ ") + nombreCorto(m.nombre) })); });
  sel.value = s.mapaId || "";
  sel.onchange = function () {
    var sesion = LC.sesionPorId(s.id) || (LC.sesionEnPantalla() && LC.sesionEnPantalla().id === s.id ? LC.sesionEnPantalla() : null);   /* incluye la sesión nueva sin guardar */
    if (!sesion) return;
    sesion.mapaId = sel.value || null;
    if (!sesion.mapaId) delete sesion.mapaId;
    LC.guardarSesion();
    renderAsociado(sesion);
    LC.actualizarPestanaMapa();
    LC.toast(sesion.mapaId ? "Mapa asociado a la sesión" : "Sesión sin mapa");
  };
  campo.appendChild(el("div", { class: "field" }, [sel]));
  var est = estadoAsociado(s);
  campo.appendChild(el("p", { class: "mp-asoc-estado " + est.cls, id: "mp-asoc-estado", texto: est.txt }));
  var fila = [];
  if (s.mapaId && !inst[s.mapaId] && entradaCatalogo(s.mapaId)) {
    var bd = el("button", { type: "button", class: "btnfull btn-primary", style: "margin:8px 0 0;", texto: "⬇️ Descargar este mapa", onclick: function () { descargarMapa(entradaCatalogo(s.mapaId)); } });
    if (!online || desc) bd.setAttribute("disabled", "disabled");
    fila.push(bd);
  }
  if (s.mapaId && inst[s.mapaId]) fila.push(el("button", { type: "button", class: "btnfull btn-secondary", style: "margin:8px 0 0;", texto: "🗺️ Ver este mapa", onclick: function () { verMapa(s.mapaId); } }));
  fila.push(el("button", { type: "button", class: "btnfull btn-secondary", style: "margin:8px 0 0;", texto: "⚙️ Gestionar mapas sin conexión", onclick: function () { abrirGestor("mapas"); } }));
  fila.forEach(function (b) { campo.appendChild(b); });
  cont.appendChild(campo);
}

function refrescarUI() {
  renderGestor();
  var v = LC && LC.state.currentView;
  if (v === "sesion") renderAsociado(LC.sesionEnPantalla());
}

/* ---------- v2.79: buscador de topónimos y coordenadas decimales ----------
   Las coordenadas se entienden en el teléfono (sin conexión). Los nombres de lugar se consultan en OpenStreetMap (Nominatim), solo con conexión. */
var bsqMarca = null;
function leerCoordenadas(texto) {
  var t = String(texto == null ? "" : texto).replace(/\u2212/g, "-").replace(/[°º]/g, " ").trim();
  if (!t) return null;
  var re = /([-+]?\d+(?:[.,]\d+)?)\s*([NSEWOnsewo](?![A-Za-z]))?/g, partes = [], m;
  while ((m = re.exec(t)) !== null) partes.push({ n: parseFloat(m[1].replace(",", ".")), h: m[2] ? m[2].toUpperCase() : "" });
  if (partes.length !== 2) return null;
  if (t.replace(re, "").replace(/[\s,;\/]/g, "") !== "") return null;
  var a = partes[0], b = partes[1], lat, lon;
  if (a.h || b.h) {
    var pl = a.h === "N" || a.h === "S" ? a : (b.h === "N" || b.h === "S" ? b : null);
    var po = a.h === "E" || a.h === "W" || a.h === "O" ? a : (b.h === "E" || b.h === "W" || b.h === "O" ? b : null);
    if (!pl || !po || pl === po) return null;
    lat = pl.h === "S" ? -Math.abs(pl.n) : Math.abs(pl.n);
    lon = po.h === "E" ? Math.abs(po.n) : -Math.abs(po.n);
  } else {
    lat = a.n; lon = b.n;
    if (Math.abs(lat) > 90 && Math.abs(lon) <= 90) { var x = lat; lat = lon; lon = x; }   /* se escribió «longitud, latitud» */
  }
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: lat, lon: lon };
}
function panelBusqueda(abrir) {
  var p = $("mp-bsq"); if (!p) return;
  var ver = abrir === undefined ? p.style.display !== "block" : abrir;
  p.style.display = ver ? "block" : "none";
  var b = $("mp-buscar"); if (b) b.classList.toggle("on", ver || !!bsqMarca);
  if (ver) {
    var q = $("mp-bsq-q"); sugerirCoordenadas();
    setTimeout(function () { try { q.focus(); q.select(); } catch (e) {} }, 60);
  } else { try { $("mp-bsq-q").blur(); } catch (e) {} }
}
function bsqMensaje(txt) { var r = $("mp-bsq-res"); r.textContent = ""; if (txt) r.appendChild(el("div", { class: "mp-suave mp-bsq-msg", texto: txt })); return r; }
function bsqFila(titulo, detalle, fn) {
  return el("button", { type: "button", class: "mp-bsq-fila-res", onclick: fn }, [el("b", { texto: titulo }), detalle ? el("span", { class: "mp-suave", texto: detalle }) : null]);
}
function sugerirCoordenadas() {
  var c = leerCoordenadas($("mp-bsq-q").value), r = $("mp-bsq-res");
  r.textContent = "";
  if (c) r.appendChild(bsqFila("📍 Ir a " + c.lat.toFixed(6) + ", " + c.lon.toFixed(6), "Coordenadas decimales (latitud, longitud)", function () { irAlLugar(c.lat, c.lon, null, "Coordenadas"); }));
  else if (bsqMarca) r.appendChild(el("button", { type: "button", class: "mp-bsq-quitar", texto: "Quitar el marcador del mapa", onclick: quitarMarcaBusqueda }));
  if (!c && !String($("mp-bsq-q").value).trim()) r.appendChild(el("div", { class: "mp-suave mp-bsq-msg", texto: "Escribe un lugar (con conexión) o coordenadas decimales, por ejemplo -38,6575 -72,5929 o 38.6575 S 72.5929 O." }));
}
function quitarMarcaBusqueda() {
  if (bsqMarca) { bsqMarca.remove(); bsqMarca = null; }
  var b = $("mp-buscar"); if (b) b.classList.remove("on");
  sugerirCoordenadas();
}
function irAlLugar(lat, lon, bbox, nombre) {
  if (!map || !mapaListo) { LC.toast("El mapa todavía no está listo", 2800); return; }
  if (bsqMarca) bsqMarca.remove();
  var punto = el("div", { class: "mp-bsq-marca", title: nombre || "" }, [el("i")]);
  bsqMarca = new maplibregl.Marker({ element: punto, anchor: "center" }).setLngLat([lon, lat]).addTo(map);
  if (bbox) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, maxZoom: 15, duration: 600 });
  else map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
  panelBusqueda(false);
  LC.toast("📍 " + (nombre ? nombre.split(",")[0] + " · " : "") + lat.toFixed(5) + ", " + lon.toFixed(5), 3200);
}
var bsqTok = 0;
async function buscarAhora() {
  var q = String($("mp-bsq-q").value || "").trim();
  if (!q) { sugerirCoordenadas(); return; }
  var c = leerCoordenadas(q);
  if (c) { irAlLugar(c.lat, c.lon, null, "Coordenadas"); return; }
  if (!online) { bsqMensaje("Sin conexión. La búsqueda por nombre necesita internet; las coordenadas decimales funcionan sin conexión."); return; }
  var tok = ++bsqTok;
  bsqMensaje("Buscando…");
  try {
    var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&accept-language=es&q=" + encodeURIComponent(q);
    if (map && mapaListo) { var b = map.getBounds(); url += "&viewbox=" + [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(","); }
    var r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var lista = await r.json();
    if (tok !== bsqTok) return;
    if (!Array.isArray(lista) || !lista.length) { bsqMensaje("No se encontró «" + q + "». Prueba con otro nombre o con coordenadas."); return; }
    var res = bsqMensaje("");
    lista.forEach(function (it) {
      var lat = parseFloat(it.lat), lon = parseFloat(it.lon); if (!isFinite(lat) || !isFinite(lon)) return;
      var bb = it.boundingbox && it.boundingbox.length === 4 ? [parseFloat(it.boundingbox[2]), parseFloat(it.boundingbox[0]), parseFloat(it.boundingbox[3]), parseFloat(it.boundingbox[1])] : null;
      if (bb && !bb.every(isFinite)) bb = null;
      var partes = String(it.display_name || it.name || "").split(",");
      res.appendChild(bsqFila(partes[0].trim() || q, partes.slice(1, 4).join(",").trim() + (it.type ? " · " + it.type : ""), function () { irAlLugar(lat, lon, bb, it.display_name || it.name); }));
    });
    res.appendChild(el("div", { class: "mp-suave mp-bsq-msg", texto: "Resultados de OpenStreetMap (© colaboradores de OpenStreetMap)." }));
  } catch (e) {
    anotarError("búsqueda", e);
    if (tok === bsqTok) bsqMensaje("No se pudo buscar ahora. Revisa la conexión e inténtalo de nuevo.");
  }
}

/* ---------- arranque ---------- */
function construirPantalla() {
  var pant = $("s-mapa"); if (!pant) return;
  pant.innerHTML =
    '<div class="topbar mp-topbar"><div class="brand"><span class="ic">🗺️</span><div><h2>Mapa</h2><p class="sub" id="mp-sub">Sin mapa instalado</p></div></div></div>' +
    '<div id="mp-lienzo">' +
    '<div id="mp-mapa"></div>' +
    '<div id="mp-barra"><button type="button" class="mp-chip mp-chip-btn" id="mp-chip-gps">GPS activar</button><button type="button" class="mp-chip mp-chip-btn rojo" id="mp-chip-rec" style="display:none"></button><button type="button" class="mp-chip mp-chip-btn rojo" id="mp-chip-grab" style="display:none"></button><span class="mp-chip" id="mp-chip-red" style="display:none">Sin conexión</span><button type="button" class="mp-chip mp-chip-btn rojo" id="mp-cancelar-elec" style="display:none">✕ Cancelar elección de coordenada</button><button type="button" class="mp-chip mp-chip-btn ok" id="mp-volver-reg" style="display:none">↩ Volver al registro</button></div>' +
    '<div id="mp-fila-sup">' + btnTb("mp-puntos", "📍", "Puntos") + btnTb("mp-mapas", "🗺️", "Mapas") + '</div>' +
    '<div id="mp-ctrl">' +
      btnTb("mp-sat", "🛰️", "Satélite") + btnTb("mp-nombres", "🔤", "Topónimos") + btnTb("mp-rutas", "🛣️", "Rutas") + btnTb("mp-buscar", "🔎", "Buscar") +
    '</div>' +
    '<div id="mp-tracks-caja">' +
      '<div id="mp-panel-tracks"><div class="mp-panel-tit">Tracks</div>' +
        '<button type="button" class="mp-btn chico" id="mp-grabar">⏺ Grabar recorrido</button>' +
        '<button type="button" class="mp-btn chico" id="mp-bloqueo" disabled>🔒 Bloqueo (solo al grabar)</button>' +
        '<button type="button" class="mp-btn chico" id="mp-pantalla">🔆 Pantalla encendida</button>' +
      '</div>' + btnTb("mp-tracks", "⏺", "Tracks") +
    '</div>' +
    '<button type="button" class="mp-btn mp-gps-btn sin-gps" id="mp-centrar" aria-label="Centrar en mi ubicación. Mantén presionado para guardar un punto aquí">◎</button>' +
    '<div id="mp-leyenda" role="group" aria-label="Tipos de punto: toca para mostrar u ocultar"></div>' +
    '<div id="mp-aviso"></div>' +
    '<div id="mp-bsq"><div class="mp-bsq-fila"><input type="search" id="mp-bsq-q" placeholder="Lugar o coordenadas (-38,6575 -72,5929)" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"><button type="button" class="mp-btn chico" id="mp-bsq-ir">Ir</button><button type="button" class="mp-panel-x" id="mp-bsq-x" aria-label="Cerrar la búsqueda">✕</button></div><div id="mp-bsq-res"></div></div>' +
    '<div id="mp-puntos-menu" role="group" aria-label="Puntos y etiquetas"><button type="button" class="mp-btn mp-pm" id="mp-pm-puntos">📍 Puntos</button><button type="button" class="mp-btn mp-pm" id="mp-pm-etiq" aria-pressed="true">🏷️ Etiquetas</button></div><div id="mp-panel-puntos"></div>' +
    '<div id="mp-nav"><div class="mp-nav-cab"><b id="mp-nav-nombre">Hacia</b><button type="button" class="mp-panel-x" id="mp-nav-cerrar" aria-label="Terminar navegación">✕</button></div>' +
      '<div class="mp-nav-cuerpo">' + dibujarRosa() + '<div class="mp-nav-datos"><div id="mp-nav-rumbo" class="mp-nav-grande">—</div><div id="mp-nav-dist" class="mp-nav-med"></div></div></div>' +
      '<div id="mp-nav-eta" class="mp-suave"></div>' +
      '<div id="mp-nav-modo-txt" class="mp-suave mp-nav-modo-txt"></div>' +
      '<div id="mp-nav-ruta" class="mp-nav-ruta"><button type="button" id="mp-nav-ant" aria-label="Punto anterior">◀</button><div id="mp-nav-pts" class="mp-nav-pts"></div><button type="button" id="mp-nav-sig" aria-label="Punto siguiente">▶</button></div></div>' +
    '<div id="mp-tarjeta"></div>' +
    '</div>';
  $("mp-chip-gps").onclick = function () { if (gps.watch == null) gpsEncender(); else gpsApagarManual(); };
  instalarCentrar();
  $("mp-puntos").onclick = alternarMenuPuntos; $("mp-pm-puntos").onclick = abrirListaPuntos; $("mp-pm-etiq").onclick = alternarEtiquetas;
  $("mp-buscar").onclick = function () { panelBusqueda(); };
  $("mp-bsq-x").onclick = function () { panelBusqueda(false); };
  $("mp-bsq-ir").onclick = function () { buscarAhora(); };
  $("mp-bsq-q").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); buscarAhora(); } });
  $("mp-bsq-q").addEventListener("input", function () { sugerirCoordenadas(); });
  $("mp-mapas").onclick = function () { abrirGestor(Object.keys(inst).length ? "mis" : "catalogo"); };
  $("mp-sat").onclick = alternarSatelite; botonSatelite();
  $("mp-rutas").onclick = alternarRutas; $("mp-nombres").onclick = alternarNombres; botonesBase();
  instalarBrujula(); actualizarModoNav();
  var navEl = $("mp-nav"); navEl.insertBefore(crearAsaTarjeta(navEl, navDesp), navEl.firstChild);
  $("mp-nav-cerrar").onclick = terminarNavegacion;
  $("mp-nav-ant").onclick = function () { avanzarRuta(-1); };
  $("mp-nav-sig").onclick = function () { avanzarRuta(1); };
  $("mp-volver-reg").onclick = volverAlRegistro;
  $("mp-cancelar-elec").onclick = cancelarEleccion;
  $("mp-grabar").onclick = function () { panelTracks(false); if (grab.rc) detenerGrabacion(false); else iniciarGrabacion(); };
  $("mp-tracks").onclick = function () { panelTracks(); };
  botonEtiquetas();
  $("mp-chip-grab").onclick = function () { detenerGrabacion(false); };
  $("mp-pantalla").onclick = alternarPantalla; botonPantalla();
  $("mp-bloqueo").onclick = function () { panelTracks(false); bloquear(); };
  construirLeyenda();
  $("mp-chip-rec").onclick = function () { LC.abrirRegistro(); };   /* vuelve a la Observación que se está grabando */
}

/* v2.72: fondo satelital (Esri World Imagery), solo con conexión. Sin conexión vuelve solo al mapa guardado. */
function botonSatelite() {
  var b = $("mp-sat"); if (!b) return;
  b.classList.toggle("on", satActivo());
  rotuloTb("mp-sat", "🛰️", fondoSat && !online ? "Sin señal" : "Satélite");
}
function satRefrescar() {
  botonSatelite(); chipMapa(); actualizarAviso();
  if (map && mapaListo && LC && LC.state.currentView === "mapa" && estiloFirma !== firmaMapas()) aplicarMapas();
}
/* v2.74: botones cuadrados con ícono y rótulo corto */
function btnTb(id, icono, texto, extra) { return '<button type="button" class="mp-btn mp-tb" id="' + id + '"' + (extra || "") + '><span class="i">' + icono + '</span><span class="t">' + texto + '</span></button>'; }
function rotuloTb(id, icono, texto) { var b = $(id); if (!b) return; var i = b.querySelector(".i"), t = b.querySelector(".t"); if (i) i.textContent = icono; if (t) t.textContent = texto; }
var ROT_ETIQ = { abajo: ["🏷️", "Etiq. ↓", "Etiquetas debajo del punto"], derecha: ["🏷️", "Etiq. →", "Etiquetas a la derecha del punto"], izquierda: ["🏷️", "Etiq. ←", "Etiquetas a la izquierda del punto"],
  arriba: ["🏷️", "Etiq. ↑", "Etiquetas sobre el punto"], auto: ["🏷️", "Etiq. auto", "Etiquetas automáticas: se acomodan y no se superponen (si no caben, se ocultan)"], ocultas: ["🚫", "Sin etiq.", "Etiquetas ocultas"] };
var modoEtiqVis = modoEtiq !== "ocultas" ? modoEtiq : "abajo";   /* v2.92: último modo visible, para volver a él al activar */
function botonEtiquetas() {
  var b = $("mp-pm-etiq"); if (!b) return;
  var on = modoEtiq !== "ocultas", r = ROT_ETIQ[modoEtiq] || ROT_ETIQ.abajo;
  b.classList.toggle("on", on); b.setAttribute("aria-pressed", on ? "true" : "false");
  b.textContent = r[0] + " " + r[1]; b.title = r[2];
}
function aplicarEtiquetas() {
  botonEtiquetas();
  if (!map || !mapaListo || !map.getLayer("puntos-texto")) return;
  var P = propsEtiq(modoEtiq);
  /* primero se limpian las propiedades que el modo anterior pudo dejar puestas */
  ["text-anchor", "text-offset", "text-variable-anchor", "text-radial-offset"].forEach(function (k) { map.setLayoutProperty("puntos-texto", k, undefined); });
  Object.keys(P).forEach(function (k) { if (P[k] !== undefined) map.setLayoutProperty("puntos-texto", k, P[k]); });
}
function alternarEtiquetas() {
  var i = MODOS_ETIQ.indexOf(modoEtiq); modoEtiq = MODOS_ETIQ[(i + 1) % MODOS_ETIQ.length];
  if (modoEtiq !== "ocultas") modoEtiqVis = modoEtiq;
  guardarJSON(LS_ETIQ, modoEtiq);
  aplicarEtiquetas();
  LC.toast(ROT_ETIQ[modoEtiq][0] + " " + ROT_ETIQ[modoEtiq][2], 2200);
}
/* v2.74: ◎ centra en el GPS con un toque; con presión sostenida guarda un punto en la ubicación actual (antes era el botón "Guardar punto aquí") */
function centrarEnGps() {
  if (gps.watch == null) { gpsEncender(); LC.toast("📡 Activando el GPS…", 2500); return; }
  if (!gps.fix) { LC.toast("Buscando señal GPS…", 2500); return; }
  if (map) map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 16), duration: 400 });
}
function instalarCentrar() {
  var b = $("mp-centrar"), t = null, largo = false;
  b.addEventListener("pointerdown", function () {
    largo = false; b.classList.add("pulsando"); clearTimeout(t);
    t = setTimeout(function () { t = null; largo = true; b.classList.remove("pulsando"); if (navigator.vibrate) navigator.vibrate(40); guardarPuntoAqui(); }, 700);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) { b.addEventListener(ev, function () { clearTimeout(t); t = null; b.classList.remove("pulsando"); }); });
  b.addEventListener("click", function (e) { if (largo) { largo = false; e.preventDefault(); return; } centrarEnGps(); });
  b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
}
/* v2.74: menú desplegable "Tracks" (grabar, bloqueo de pantalla, pantalla encendida) */
function panelTracks(abrir) {
  var p = $("mp-panel-tracks"); if (!p) return;
  var ver = abrir === undefined ? p.style.display !== "block" : abrir;
  p.style.display = ver ? "block" : "none";
  $("mp-tracks").classList.toggle("on", ver && !grab.rc);
}
/* v2.73: encuadra todas las zonas de los mapas instalados */
function verTodosLosMapas() {
  var as = mapasOrdenados().map(function (m) { return m.area; }).filter(function (a) { return a && a.length === 4; });
  if (!as.length || !map) { LC.toast("No hay mapas instalados"); return; }
  var b = as.reduce(function (r, a) { return [Math.min(r[0], a[0]), Math.min(r[1], a[1]), Math.max(r[2], a[2]), Math.max(r[3], a[3])]; }, as[0].slice());
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 50, duration: 700, maxZoom: 12 });
}
function alternarSatelite() {
  if (!fondoSat && !online) { LC.toast("El satélite necesita conexión a internet"); return; }
  fondoSat = !fondoSat; guardarJSON(LS_FONDO, fondoSat ? "sat" : "mapa");
  LC.toast(fondoSat ? "🛰️ Fondo satelital (necesita señal)" : "Fondo: mapa guardado");
  satRefrescar();
}

async function precargarArchivos() {
  /* El service worker guarda lo que se descarga; las tipografías solo se piden al dibujar, así que se piden todas una vez por versión. */
  try {
    if (localStorage.getItem(LS_PRECARGA) === LC.appBuild || !online) return;
    var lista = await (await fetch(RUTA_MAPA + "archivos.json")).json();
    await Promise.all(lista.map(function (f) { return fetch(RUTA_MAPA + f).then(function (r) { if (!r.ok) throw new Error(f); }); }));
    localStorage.setItem(LS_PRECARGA, LC.appBuild);
  } catch (e) { anotarError("precarga", e); }
}
function alDesactivar() {
  if (grab.rc) detenerGrabacion(true);   /* al apagar el mapa se guarda lo grabado */
  clearInterval(vivoTimer); vivoTimer = null; apagarRumbo(false);
  nav = null; gpsApagar(true); cerrarGestor(); cerrarPanelPuntos();
  document.body.classList.remove("vista-mapa");
}

async function init(lc) {
  LC = lc;
  window.addEventListener("online", function () { online = true; resolverCalles(); chipMapa(); cargarCatalogo().then(refrescarUI); satRefrescar(); });
  window.addEventListener("offline", function () { online = false; chipMapa(); refrescarUI(); satRefrescar(); });
  if (!LISTO) return;
  construirPantalla();
  resolverCalles();
  estiloPromesa = fetch(RUTA_MAPA + "estilo-base.json").then(function (r) { return r.json(); }).then(function (j) { ESTILO_BASE = j; }).catch(function (e) { anotarError("estilo", e); });
  await estiloPromesa;
  await reconciliar();
  await leerAlmacenamiento();
  await cargarCatalogo();
  refrescarUI(); chipMapa();
  LC.actualizarPestanaMapa();
  if (LC.state.currentView === "mapa") alMostrar();
  precargarArchivos();
  if (pedido && !pedido.fin && adminMapas()) sondearPedido();
}

window.MapaPro = {
  init: init, alMostrar: alMostrar, alOcultar: alOcultar, renderAsociado: renderAsociado,
  abrirGestor: abrirGestor, alDesactivar: alDesactivar, verPunto: verPunto, verRecorrido: verRecorrido, elegirCoordenada: elegirCoordenada,
  /* para pruebas */
  capasVinculadas: capasVinculadas,
  _debug: function () { return { listo: function () { return mapaListo; }, capasActualesRef: function () { return capasActuales; }, fcAGpx: fcAGpx, fcACsv: fcACsv, descargarCapaLocal: descargarCapaLocal, capasLocRef: function () { return capasLoc; }, importarCapaLocal: importarCapaLocal, altitudAprox: altitudAprox, iniciarRutaManual: iniciarRutaManual, guardarPuntosComoCapa: guardarPuntosComoCapa, marcarPuntoManual: marcarPuntoManual, avanzarRuta: avanzarRuta, actualizarNavegacion: actualizarNavegacion, geoNav: geoNav, nav: nav, capas: capasActuales, capasLoc: capasLoc, map: map, inst: inst, Alm: Alm, metricas: metricas, errores: errores, estiloFirma: estiloFirma, relieveNombres: relieveNombres, construirEstilo: construirEstilo, verMapa: verMapa, aplicarMapas: aplicarMapas, gps: gps, rumbo: rumbo, geoPuntos: geoPuntos, geoTracks: geoTracks, geoVivo: geoVivo, conjuntosPuntos: conjuntosPuntos, rumboDispositivo: rumboDispositivo, alOrientacion: alOrientacion, encenderRumbo: encenderRumbo, apagarRumbo: apagarRumbo, refrescarVivo: refrescarVivo, renderPanelPuntos: renderPanelPuntos, grab: grab, iniciarGrabacion: iniciarGrabacion, detenerGrabacion: detenerGrabacion, geoRecorridos: geoRecorridos, grabPunto: grabPunto, refrescarRecorridos: refrescarRecorridos, borrarRecorrido: borrarRecorrido, chipGrab: chipGrab, marcarPuntoManual: marcarPuntoManual, quitarPuntoManual: quitarPuntoManual, quitarTodosManuales: quitarTodosManuales, seleccionarPuntoManual: seleccionarPuntoManual, puntosManuales: function () { return puntosManuales; }, csvAGeoJSON: csvAGeoJSON, normalizarFC: normalizarFC, geoCapas: geoCapas, panelEstiloCapa: panelEstiloCapa, tipoPorNombre: tipoPorNombre, omitidas: function () { return csvOmitidas; } }; }
};
})();
