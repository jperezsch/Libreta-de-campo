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
var mapaImportId = null;                 /* v2.47: mapa elegido en Capas para importar una capa */
var ultimaSesionVista = null;
var capasVis = leerJSON(LS_CAPAS, { sombra: true, curvas: true, anteriores: true });
var online = navigator.onLine !== false;
var map = null, mapaListo = false, ESTILO_BASE = [], estiloPromesa = null;
var gps = { watch: null, fix: null, primera: true, quiere: false };
var rumbo = { activo: false, h: null, ultimo: 0, libre: 0, sensor: false, recibido: false };   /* v2.44: modo "rumbo arriba" (el mapa gira según hacia dónde apuntas) */
var panelAbiertos = {};   /* v2.44: sesiones desplegadas en "Mis puntos" */
var grab = { rc: null, watch: null, timer: null, wake: null, sucio: false, ultimoGuardado: 0, ultimoLat: null };   /* v2.45: recorrido que se está grabando */
var GRAB_ACC_MAX = 50, GRAB_DIST_MIN = 4, GRAB_T_MAX = 30000, GRAB_CORTE_T = 60000, GRAB_CORTE_D = 50;
var almEst = { usado: null, cuota: null, protegido: null };
var bateria = "";

function nombreDeUrl(u) { return decodeURIComponent(new URL(u, location.href).pathname.split("/").pop()); }
function archivosDe(e) { return (e.archivos || []).filter(function (a) { return a.tipo === "base" || a.tipo === "relieve"; }); }
function capasDe(e) { return ((e && e.capas) || []).filter(function (c) { return c && c.id && c.url && /^(geojson|gpx|shapefile_zip|shapefile)$/.test(c.tipo || "geojson"); }); }
function capaInstalada(m, c) { return !!(m && (m.capas || []).some(function (x) { return x.id === c.id && x.url === c.url; })); }
function capasPendientes(e) { var m = inst[e.id]; return m ? capasDe(e).filter(function (c) { return !capaInstalada(m, c); }) : capasDe(e); }
function totalBytes(e) { return archivosDe(e).concat(capasDe(e)).reduce(function (s, a) { return s + (a.bytes || 0); }, 0); }
function archivoTipo(m, tipo) { var a = (m.archivos || []).filter(function (x) { return x.tipo === tipo; })[0]; return a ? a.nombre : null; }
function nombreCorto(n) { return String(n || "").replace(/\s*\(SINTETICO.*$/, ""); }
function entradaCatalogo(id) { return cat ? (cat.mapas.filter(function (m) { return m.id === id; })[0] || null) : null; }
function sesionesQueUsan(id) { return LC.state.sesiones.filter(function (s) { return s.mapaId === id; }).length; }

/* ---------- capas: estaciones, tracks y límites ---------- */
var capasCache = {}, capasLoc = leerJSON(LS_CAPAS_LOC, []), capasActuales = [], shpPromesa = null;
var COL_CAT = "#6a1b9a", COL_LOC = "#e65100";
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
function tipoPorNombre(n) { n = String(n).toLowerCase(); if (/\.(geo)?json$/.test(n)) return "geojson"; if (/\.gpx$/.test(n)) return "gpx"; if (/\.zip$/.test(n)) return "shapefile_zip"; return null; }
function tipoCapa(t) { return t === "shapefile" ? "shapefile_zip" : (t || "geojson"); }
async function parsearCapa(file, tipo) {
  var j;
  if (tipo === "geojson") j = JSON.parse(await file.text());
  else if (tipo === "gpx") j = gpxAGeoJSON(await file.text());
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
async function cargarCapasMapa() {   /* v2.47: capas de todos los mapas instalados */
  var lista = [], res = [];
  Object.keys(inst).sort().forEach(function (id) { lista = lista.concat(capasDelMapa(id)); });
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
    c.datos.fc.features.forEach(function (f) {
      fs.push({ type: "Feature", properties: Object.assign({}, f.properties, { _capa: c.clave, _origen: c.origen }), geometry: f.geometry });
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
function cerrarTarjeta() { var t = $("mp-tarjeta"); if (t) t.style.display = "none"; }
function mostrarTarjetaCapa(f, lngLat) {
  var t = $("mp-tarjeta"); if (!t) return;
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
async function importarCapaLocal(file, mapaId) {
  if (!mapaId || !inst[mapaId]) { LC.toast("Elige primero un mapa instalado"); return; }
  var tipo = tipoPorNombre(file.name);
  if (!tipo) { LC.toast("Formato no admitido. Usa GeoJSON, GPX o shapefile en .zip", 5000); return; }
  if (file.size > 25 * 1048576) { LC.toast("El archivo pesa más de 25 MB", 5000); return; }
  var m = inst[mapaId], r;
  try { r = await parsearCapa(file, tipo); }
  catch (e) { LC.toast("No se pudo leer la capa: " + (e.message || e), 6000); anotarError("importar capa", e); return; }
  var total = r.cuenta.puntos + r.cuenta.lineas + r.cuenta.poligonos, a = m.area;
  if (a && (r.bbox[2] < a[0] || r.bbox[0] > a[2] || r.bbox[3] < a[1] || r.bbox[1] > a[3])) {
    var msg = "Ningún elemento de la capa cae dentro del área de este mapa.";
    if (!(r.bbox[3] < a[0] || r.bbox[1] > a[2] || r.bbox[2] < a[1] || r.bbox[0] > a[3])) msg += " Parece que las coordenadas están en orden latitud, longitud.";
    if (!confirm(msg + "\n\n¿Importarla igual?")) return;
  }
  if (total > 5000 && !confirm("La capa tiene " + total + " elementos y puede volver lento el mapa.\n\n¿Importarla igual?")) return;
  var id = "l" + Date.now().toString(36), archivo = "capa-local-" + id + ".geojson", blob = new Blob([JSON.stringify(r.fc)], { type: "application/geo+json" });
  try { await Alm.guardar(archivo, blob); }
  catch (e) { LC.toast("No se pudo guardar la capa: " + (e.message || e), 6000); anotarError("guardar capa", e); return; }
  capasLoc.push({ id: id, mapaId: mapaId, nombre: file.name.replace(/\.[^.]+$/, ""), archivo: archivo, tipo: tipo, bytes: blob.size, fecha: fechaHM(), elementos: r.cuenta });
  guardarJSON(LS_CAPAS_LOC, capasLoc);
  await recargarCapas();
  LC.toast("Capa importada: " + resumenCuenta(r.cuenta));
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
function catalogoUrl() { return PARAMS.get("catalogo") || (LC && LC.mapaCfg().catalogoUrl) || ""; }
async function cargarCatalogo() {
  var url = catalogoUrl(), sep = url.indexOf("?") >= 0 ? "&" : "?";
  try {
    if (!url) throw new Error("falta la dirección del catálogo");
    var r = await fetch(url + sep + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var j = await r.json();
    if (j.esquema !== 1 || !Array.isArray(j.mapas)) throw new Error("Catálogo con formato no reconocido");
    cat = j; catInfo = "Catálogo del " + (j.actualizado || "?") + ", consultado " + fechaHM();
    guardarJSON(LS_CAT, { fecha: fechaHM(), data: j });
    return true;
  } catch (e) {
    anotarError("catálogo", e);
    var g = leerJSON(LS_CAT, null);
    if (g && g.data) { cat = g.data; catInfo = "Sin poder consultar. Catálogo guardado el " + g.fecha; }
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
    if (fl && inst[capasLoc[li].mapaId]) locOk.push(capasLoc[li]); else if (fl) await Alm.borrar(capasLoc[li].archivo);
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
    var pr = { id: r.id, sesion: r.sesionId, activa: r.sesionId === LC.state.sesionActivaId ? 1 : 0, color: LC.colorSesion(r.sesionId), recto: 0 };
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
    var pr = { id: rc.id, sesion: rc.sesionId, color: LC.colorSesion(rc.sesionId), grabando: rc.enCurso ? 1 : 0 };
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
  if (b) { b.textContent = rc ? "⏹ Detener" : "⏺ Grabar"; b.classList.toggle("on", !!rc); b.classList.toggle("grabando", !!rc); }
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
async function pedirPantalla() {
  try {
    if (!grab.rc || !navigator.wakeLock || grab.wake) return;
    grab.wake = await navigator.wakeLock.request("screen");
    grab.wake.addEventListener("release", function () { grab.wake = null; });
  } catch (e) { grab.wake = null; }
}
function soltarPantalla() { try { if (grab.wake) grab.wake.release(); } catch (e) {} grab.wake = null; }
function grabPunto(p) {
  var rc = grab.rc; if (!rc) return;
  var c = p.coords, acc = (typeof c.accuracy === "number" && c.accuracy > 0) ? c.accuracy : 999;
  if (acc > GRAB_ACC_MAX) return;   /* lecturas muy imprecisas ensucian el track */
  var ahora = Date.now(), pts = rc.puntos, ult = pts.length ? pts[pts.length - 1] : null;
  var nuevo = { lat: +c.latitude.toFixed(6), lon: +c.longitude.toFixed(6), horaTs: ahora, accuracy: Math.round(acc) };
  if (ult) {
    var d = distRec(ult, nuevo), dt = ahora - ult.horaTs;
    if (d < GRAB_DIST_MIN && dt < GRAB_T_MAX) return;   /* parado: no se llena de puntos repetidos */
    if (dt > GRAB_CORTE_T && d > GRAB_CORTE_D) nuevo.corte = true;   /* hubo un hueco (pantalla bloqueada, sin señal): no se une con una recta inventada */
    else rc.distanciaM = (rc.distanciaM || 0) + d;
  }
  pts.push(nuevo); grab.sucio = true;
  if (ahora - grab.ultimoGuardado > 10000) guardarGrab(true);
  chipGrab();
}
function iniciarGrabacion() {
  if (grab.rc) return;
  if (!navigator.geolocation) { LC.toast("Este navegador no tiene GPS disponible"); return; }
  if (!LC.exigirSesionActiva()) return;
  var ses = LC.sesionActiva(); if (!ses) return;
  if (!LC.state.recorridos) LC.state.recorridos = [];
  var n = 1; LC.state.recorridos.forEach(function (x) { if (x.sesionId === ses.id && (x.n || 0) >= n) n = x.n + 1; });
  var rc = { id: "rc_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sesionId: ses.id, n: n, nombre: "Recorrido " + n, inicioTs: Date.now(), finTs: null, enCurso: true, interrumpido: false, distanciaM: 0, puntos: [] };
  LC.state.recorridos.push(rc); grab.rc = rc; grab.sucio = true; guardarGrab(true);
  grab.watch = navigator.geolocation.watchPosition(grabPunto, function (e) { anotarError("grabacion", e); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  grab.timer = setInterval(function () { guardarGrab(false); chipGrab(); refrescarRecorridos(false); }, 5000);
  if (gps.watch == null) gpsEncender();
  pedirPantalla();
  chipGrab(); refrescarRecorridos(true);
  LC.toast("Grabando recorrido. Mantén la pantalla encendida: si el teléfono se bloquea, la grabación se interrumpe.", 6000);
}
function detenerGrabacion(sinPreguntar) {
  var rc = grab.rc; if (!rc) return;
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
  if (document.visibilityState === "hidden") guardarGrab(true);
  else { pedirPantalla(); chipGrab(); }
});
window.addEventListener("pagehide", function () { guardarGrab(true); });

function refrescarTracks() { if (map && mapaListo && map.getSource("tracks")) { map.getSource("tracks").setData(geoTracks()); aplicarFiltroPuntos(); } }
var pendienteVer = null, resaltado = null, resaltadoT = null;
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
  b.style.display = retorno ? "" : "none";
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
  var cen = $("mp-centrar"); if (cen) cen.style.display = (gps.watch != null && gps.fix) ? "" : "none";
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
  gps.primera = true; gps.quiere = true;
  gps.watch = navigator.geolocation.watchPosition(gpsOk, gpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  var b = $("mp-gps"); if (b) b.classList.add("on");
  chipGps();
}
function gpsApagar(olvidar) {
  if (gps.watch != null) { try { navigator.geolocation.clearWatch(gps.watch); } catch (e) {} gps.watch = null; }
  if (olvidar) { gps.quiere = false; gps.fix = null; if (map && mapaListo && map.getSource("gps")) map.getSource("gps").setData(geoGps()); }
  var b = $("mp-gps"); if (b) b.classList.remove("on");
  chipGps();
}

/* ---------- estilo y mapa ---------- */
function rutaBase() { return location.origin + location.pathname.replace(/[^\/]*$/, ""); }
function vis(c) { return capasVis[c] ? "visible" : "none"; }
function visSesion(id) { return !(capasVis.sesiones && capasVis.sesiones[id] === false); }
function visReg(id) { return !(capasVis.regs && capasVis.regs[id] === false); }
function idsOcultos() { return Object.keys(capasVis.regs || {}).filter(function (k) { return capasVis.regs[k] === false; }); }
function filtroPuntos() {
  var ids = LC.state.sesiones.filter(function (x) { return visSesion(x.id); }).map(function (x) { return x.id; });
  var f = ["in", ["get", "sesion"], ["literal", ids]], oc = idsOcultos();
  return oc.length ? ["all", f, ["!", ["in", ["get", "id"], ["literal", oc]]]] : f;   /* v2.44: registros que se ocultaron uno a uno desde "Mis puntos" */
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
function mapasOrdenados() { return Object.keys(inst).sort().map(function (id) { return inst[id]; }); }
function firmaMapas() { return Object.keys(inst).sort().map(function (id) { return id + "@" + inst[id].version + "@" + inst[id].fecha; }).join("|"); }
/* v2.47: el estilo junta TODOS los mapas instalados. Cada mapa aporta su fuente "base<k>" y una copia de las capas del estilo base
   (intercaladas por orden, para que el apilado sea correcto entre mapas vecinos). El relieve y las curvas son una sola fuente que lee de todos los paquetes. */
function construirEstilo(sinMapas) {
  var estilo = { version: 8, glyphs: rutaBase() + RUTA_MAPA + "fuentes/{fontstack}/{range}.pbf", sources: {}, layers: [] };
  var ms = sinMapas ? [] : mapasOrdenados();
  var bases = ms.filter(function (m) { return archivoTipo(m, "base"); });
  var rels = ms.filter(function (m) { return archivoTipo(m, "relieve"); });
  var capas = [], extra = [], etiquetas = [];
  if (rels.length) {
    estilo.sources.dem = { type: "raster-dem", tiles: [demSource.sharedDemProtocolUrl], tileSize: 512, maxzoom: 12, encoding: "terrarium", attribution: ATTR_REL };
    estilo.sources.curvas = { type: "vector", maxzoom: 15, tiles: [demSource.contourProtocolUrl({
      thresholds: { 10: [100, 500], 11: [50, 250], 12: [20, 100], 13: [20, 100], 14: [10, 50], 15: [10, 50] },
      contourLayer: "contours", elevationKey: "ele", levelKey: "level", extent: 4096, buffer: 1 })] };
    extra.push({ id: "relieve-sombra", type: "hillshade", source: "dem", layout: { visibility: vis("sombra") },
      paint: { "hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#3b3f45", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#6b7078" } });
    extra.push({ id: "curvas-linea", type: "line", source: "curvas", "source-layer": "contours", layout: { visibility: vis("curvas") },
      paint: { "line-color": "#8a5a2b", "line-opacity": 0.75, "line-width": ["match", ["get", "level"], 1, 1.4, 0.6] } });
    etiquetas.push({ id: "curvas-texto", type: "symbol", source: "curvas", "source-layer": "contours", filter: [">", ["get", "level"], 0],
      layout: { visibility: vis("curvas"), "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "ele"]], " m"], "text-font": ["NotoSans-Regular"], "text-size": 11 },
      paint: { "text-color": "#6d4520", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
  }
  if (bases.length) {
    bases.forEach(function (m, k) {
      var fu = { type: "vector", tiles: ["lcmap://" + archivoTipo(m, "base") + "/{z}/{x}/{y}"], minzoom: 0, maxzoom: 15, bounds: m.area };
      if (k === 0) fu.attribution = ATTR_OSM;
      estilo.sources["base" + k] = fu;
    });
    var idx = ESTILO_BASE.length;
    for (var i = 0; i < ESTILO_BASE.length; i++) { if (ESTILO_BASE[i].type === "line" && !/^water/.test(ESTILO_BASE[i].id)) { idx = i; break; } }
    for (var j = 0; j < ESTILO_BASE.length; j++) {
      if (j === idx) capas = capas.concat(extra);
      bases.forEach(function (m, k) {
        var L = ESTILO_BASE[j];
        if (L.type === "background" && k > 0) return;
        var c = JSON.parse(JSON.stringify(L));
        if (L.source === "base") c.source = "base" + k;
        if (k > 0) c.id = L.id + "~" + k;
        capas.push(c);
      });
    }
    if (idx >= ESTILO_BASE.length) capas = capas.concat(extra);
    capas = capas.concat(etiquetas);
  } else {
    capas = [{ id: "fondo", type: "background", paint: { "background-color": "#eef0ec" } }].concat(extra, etiquetas);
  }
  estilo.sources.capas = { type: "geojson", data: geoCapas() };
  var COL = ["match", ["get", "_origen"], "local", COL_LOC, COL_CAT];
  capas.push({ id: "capas-pol-relleno", type: "fill", source: "capas", filter: filtroCapas("capas-pol-relleno"), paint: { "fill-color": COL, "fill-opacity": 0.07 } });
  capas.push({ id: "capas-pol-borde", type: "line", source: "capas", filter: filtroCapas("capas-pol-borde"), paint: { "line-color": COL, "line-width": 2, "line-dasharray": [3, 2] } });
  capas.push({ id: "capas-lineas", type: "line", source: "capas", filter: filtroCapas("capas-lineas"), layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": COL, "line-width": 2.5 } });
  capas.push({ id: "capas-lineas-texto", type: "symbol", source: "capas", filter: filtroCapas("capas-lineas-texto"),
    layout: { "symbol-placement": "line", "text-field": ["get", "nombre"], "text-font": ["NotoSans-Italic"], "text-size": 11 },
    paint: { "text-color": COL, "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
  capas.push({ id: "capas-estaciones", type: "symbol", source: "capas", filter: filtroCapas("capas-estaciones"),
    layout: { "icon-image": ["match", ["get", "_origen"], "local", "rombo-local", "rombo-cat"], "icon-size": 0.55, "icon-allow-overlap": true,
      "text-field": ["coalesce", ["get", "nombre"], ["get", "estacion"], ""], "text-font": ["NotoSans-Medium"], "text-size": 11, "text-offset": [0, 1.3], "text-anchor": "top", "text-optional": true },
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
    layout: { "text-field": ["get", "etq"], "text-font": ["NotoSans-Medium"], "text-size": ["case", ["==", ["get", "activa"], 1], 13, 10], "text-offset": ["case", ["==", ["get", "nota"], 1], ["literal", [0, 1.4]], ["literal", [0, 1.35]]], "text-anchor": "top", "text-allow-overlap": true },
    paint: { "text-color": "#222222", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  capas.push({ id: "nav-linea", type: "line", source: "nav", filter: ["==", ["get", "tipo"], "linea"], layout: { "line-cap": "round" },
    paint: { "line-color": "#c9962c", "line-width": 3, "line-dasharray": [2, 2] } });
  capas.push({ id: "nav-destino", type: "circle", source: "nav", filter: ["==", ["get", "tipo"], "destino"],
    paint: { "circle-radius": 15, "circle-color": "rgba(201,150,44,0.18)", "circle-stroke-color": "#c9962c", "circle-stroke-width": 4 } });
  capas.push({ id: "resaltado-anillo", type: "circle", source: "resaltado",
    paint: { "circle-radius": 19, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#c9962c", "circle-stroke-width": 4 } });
  capas.push({ id: "gps-precision", type: "fill", source: "gps", filter: ["==", ["get", "tipo"], "precision"], paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 } });
  capas.push({ id: "gps-punto", type: "circle", source: "gps", filter: ["==", ["get", "tipo"], "punto"],
    paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
  estilo.layers = capas;
  return estilo;
}

function crearMapa() {
  map = new maplibregl.Map({
    container: "mp-mapa", style: construirEstilo(true), center: [-72.59, -38.66], zoom: 5, maxZoom: 19,
    attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 0
  });
  map.touchZoomRotate.enableRotation();   /* v2.44: giro libre con dos dedos (sin inclinación) */
  map.on("rotate", actualizarNorte);
  map.on("rotatestart", function (e) { if (e && e.originalEvent && rumbo.activo) { apagarRumbo(false); LC.toast("Giro manual: rumbo arriba apagado"); } });
  map.on("dragstart", function (e) { if (e && e.originalEvent) rumbo.libre = Date.now(); });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 100 }), "bottom-right");
  map.on("error", function (ev) {
    var msg = ev && ev.error && ev.error.message ? ev.error.message : "";
    if (/fuera del área|sin relieve/.test(msg)) return;
    anotarError("mapa", ev.error || ev);
  });
  map.on("styleimagemissing", function (e) {
    if (e.id === "rombo-cat" || e.id === "rombo-local") map.addImage(e.id, crearRombo(e.id === "rombo-local" ? COL_LOC : COL_CAT));
    else if (/^nota-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(5), "N", true));
    else if (/^rec-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(4), "R", false));
    else if (/^obs-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(4), "O", false));
    else if (/^pt-/.test(e.id)) map.addImage(e.id, iconoLetra(e.id.slice(3), "", false));
  });
  instalarPulsacionLarga();
  map.on("click", function (ev) {
    if (pulsacionReciente) { pulsacionReciente = false; return; }
    cerrarPanelPuntos();
    if (resaltado) ponerResaltado(null);
    var p = ev.point, caja = [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]];
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
        var t = $("mp-tarjeta"), ses = LC.sesionPorId(rcSel.sesionId);
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
    map.once("idle", function () { metricas.aperturaMs = Math.round(performance.now() - t0); res(); });
    chipMapa();
  });
}
function centroEn(a) { var c = map.getCenter(); return !!a && c.lng >= a[0] && c.lng <= a[2] && c.lat >= a[1] && c.lat <= a[3]; }
function enfocarArea(a, animar) { map.fitBounds([[a[0], a[1]], [a[2], a[3]]], { padding: 20, animate: !!animar, duration: 700, maxZoom: 14 }); }
/* v2.47: "Ver en el mapa" desde el gestor o desde la pestaña Sesión: abre la pestaña Mapa y la lleva a la zona de ese mapa */
function verMapa(id) {
  if (!inst[id]) { LC.toast("Ese mapa no está instalado"); return; }
  pendienteEnfoque = id;
  cerrarGestor();
  if (LC.state.currentView === "mapa") alMostrar(); else LC.irA("mapa");
}
function chipMapa() {
  var c = $("mp-sub"); if (!c) return;
  var ids = Object.keys(inst);
  c.textContent = !ids.length ? "Sin mapa instalado" : ids.length === 1 ? nombreCorto(inst[ids[0]].nombre) : ids.length + " mapas";
  var r = $("mp-chip-red"); r.textContent = "Sin conexión"; r.style.display = online ? "none" : "inline-block";
}
function actualizarAviso() {
  var a = $("mp-aviso"); if (!a) return;
  var s = LC.sesionActiva() || LC.sesionEnPantalla(), txt = "";
  if (!Object.keys(inst).length) txt = "No hay mapas instalados. Toca Mapas para descargar uno. Mientras tanto ves tus puntos sobre fondo liso.";
  else if (s && s.mapaId && !inst[s.mapaId]) txt = "El mapa asociado a esta sesión no está instalado. Toca Mapas.";
  a.textContent = txt; a.style.display = txt ? "block" : "none";
}

async function alMostrar() {
  if (!LISTO) return;
  document.body.classList.add("vista-mapa");
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
  if (gps.quiere && gps.watch == null) gpsEncender();
  if (pendienteVer) {
    var pv = pendienteVer; pendienteVer = null;
    gps.primera = false;   /* v2.43: el primer dato del GPS no debe llevar la vista a la posición actual: se queda en el punto consultado */
    map.easeTo({ center: [pv.lng, pv.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 600 });
    ponerResaltado(pv, !!retorno);   /* con retorno, el anillo se mantiene hasta que se toque el mapa */
  }
  botonVolverRegistro();
}
function alOcultar() {
  clearInterval(vivoTimer); vivoTimer = null; apagarRumbo(false);
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
  if (!nav) return fc;
  fc.features.push({ type: "Feature", properties: { tipo: "destino" }, geometry: { type: "Point", coordinates: [nav.destino.lng, nav.destino.lat] } });
  if (gps.fix) fc.features.push({ type: "Feature", properties: { tipo: "linea" }, geometry: { type: "LineString", coordinates: [[gps.fix.lng, gps.fix.lat], [nav.destino.lng, nav.destino.lat]] } });
  return fc;
}
function refrescarNavMapa() { if (map && mapaListo && map.getSource("nav")) map.getSource("nav").setData(geoNav()); }
function dibujarRosa() {
  var marcas = "";
  for (var g = 0; g < 360; g += 30) marcas += '<line x1="0" y1="' + (g % 90 === 0 ? -46 : -49) + '" x2="0" y2="-54" transform="rotate(' + g + ')" class="mp-rosa-marca"/>';
  return '<svg id="mp-rosa" viewBox="-62 -62 124 124" aria-hidden="true">' +
    '<circle r="55" class="mp-rosa-aro"/>' + marcas +
    '<text x="0" y="-37" class="mp-rosa-n" text-anchor="middle">N</text><text x="39" y="4" class="mp-rosa-l" text-anchor="middle">E</text>' +
    '<text x="0" y="45" class="mp-rosa-l" text-anchor="middle">S</text><text x="-39" y="4" class="mp-rosa-l" text-anchor="middle">O</text>' +
    '<g id="mp-rosa-rumbo" style="display:none"><polygon points="0,-60 6,-51 -6,-51" class="mp-rosa-tu"/></g>' +
    '<g id="mp-rosa-aguja"><polygon points="0,-34 8,0 -8,0" class="mp-rosa-flecha"/><polygon points="0,26 6,0 -6,0" class="mp-rosa-cola"/><circle r="3" class="mp-rosa-eje"/></g></svg>';
}
function actualizarNavegacion() {
  var cuadro = $("mp-nav"); if (!cuadro) return;
  var br = $("mp-rumbo"); if (br) br.style.display = nav ? "" : "none";
  if (!nav && rumbo.activo) apagarRumbo(true);   /* al terminar la navegación el mapa vuelve al norte */
  if (!nav) { cuadro.style.display = "none"; return; }
  cuadro.style.display = "block";
  $("mp-nav-nombre").textContent = "Hacia " + nav.destino.nombre;
  var rum = $("mp-nav-rumbo"), dis = $("mp-nav-dist"), eta = $("mp-nav-eta"), aguja = $("mp-rosa-aguja"), tu = $("mp-rosa-rumbo");
  cuadro.classList.remove("llego");
  if (!gps.fix) {
    rum.textContent = "—"; dis.textContent = gps.watch == null ? "GPS apagado: toca GPS activar" : "Esperando señal GPS…"; eta.textContent = "";
    tu.style.display = "none"; refrescarNavMapa(); return;
  }
  var yo = { lng: gps.fix.lng, lat: gps.fix.lat }, d = distanciaM(yo, nav.destino), rb = rumboGrados(yo, nav.destino);
  aguja.setAttribute("transform", "rotate(" + rb.toFixed(1) + ")");
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
  if (rumboPropio != null && v != null && v >= 0.4) { tu.style.display = ""; tu.setAttribute("transform", "rotate(" + rumboPropio.toFixed(1) + ")"); } else tu.style.display = "none";
  var umbral = Math.max(10, Math.min(25, gps.fix.acc * 0.8));
  if (d <= umbral) {
    cuadro.classList.add("llego");
    dis.textContent = "¡Llegaste!"; eta.textContent = "A " + Math.round(d) + " m del punto";
    if (!nav.avisado) { nav.avisado = true; if (navigator.vibrate) navigator.vibrate([60, 40, 60]); }
  } else {
    nav.avisado = false;
    dis.textContent = textoDistancia(d);
    var kmh = nav.vel != null ? (nav.vel * 3.6).toFixed(1).replace(".", ",") + " km/h" : "";
    eta.textContent = (nav.vel != null && nav.vel >= 0.4) ? textoTiempo(d / nav.vel) + " · " + kmh : "Ponte en marcha para estimar el tiempo";
  }
  refrescarNavMapa();
}
function iniciarNavegacion(dest) {
  nav = { destino: dest, hist: gps.fix ? [{ t: gps.fix.t, lng: gps.fix.lng, lat: gps.fix.lat }] : [], vel: null, avisado: false };
  if (gps.watch == null) gpsEncender();
  cerrarPanelPuntos(); cerrarTarjeta();
  actualizarNavegacion();
  LC.toast("Navegando hacia " + dest.nombre + ". Toca ✕ para terminar", 3200);
}
function terminarNavegacion() { nav = null; actualizarNavegacion(); refrescarNavMapa(); }
function destinoEn(pt) {
  var caja = [[pt[0] - 14, pt[1] - 14], [pt[0] + 14, pt[1] + 14]];
  var capas = ["puntos-circ", "puntos-nota", "capas-estaciones"].filter(function (l) { return map.getLayer(l); });
  if (!capas.length) return null;
  var fs = map.queryRenderedFeatures(caja, { layers: capas });
  if (!fs.length) return null;
  var f = fs[0], pr = f.properties || {};
  return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], nombre: pr.codigo || pr.nombre || pr.estacion || "el punto" };
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
      var r = cont.getBoundingClientRect(), dest = destinoEn([ini.x - r.left, ini.y - r.top]);
      if (!dest) return;
      pulsacionReciente = true; setTimeout(function () { pulsacionReciente = false; }, 1000);
      if (navigator.vibrate) navigator.vibrate(35);
      iniciarNavegacion(dest);
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
  capasActuales.forEach(function (c) {
    out.push({ tipo: "capa", clave: c.clave, nombre: c.nombre, origen: c.origen, resumen: resumenCuenta(c.datos.cuenta), bbox: c.datos.bbox });
  });
  return out;
}
function encuadrarConjunto(c) {
  var b = new maplibregl.LngLatBounds();
  if (c.tipo === "sesion") c.coords.forEach(function (x) { b.extend(x); });
  else { b.extend([c.bbox[0], c.bbox[1]]); b.extend([c.bbox[2], c.bbox[3]]); }
  map.fitBounds(b, { padding: 70, maxZoom: 17, duration: 500 });
}
function cerrarPanelPuntos() { var pn = $("mp-panel-puntos"); if (pn) pn.style.display = "none"; var b = $("mp-puntos"); if (b) b.classList.remove("on"); }
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
  var grupos = [["sesion", "Registros por sesión"], ["capa", "Capas del mapa"]];
  grupos.forEach(function (g) {
    var items = lista.filter(function (c) { return c.tipo === g[0]; });
    if (!items.length) return;
    pn.appendChild(el("div", { class: "mp-panel-grupo", texto: g[1] }));
    items.forEach(function (c) {
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
      var punto = c.tipo === "sesion" ? el("span", { class: "mp-punto", style: "background:" + c.color }) : el("span", { class: "mp-punto mp-punto-capa", style: "background:" + (c.origen === "local" ? COL_LOC : COL_CAT) });
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

/* ---------- Guardar punto aquí ---------- */
function guardarPuntoAqui() {
  var btn = $("mp-guardar"), orig = "📍 Guardar punto aquí";
  if (LC.gpsCapturaActiva()) { LC.gpsCapturaActiva().cerrarYa(); return; }
  if (!LC.exigirSesionActiva()) return;
  if (!navigator.geolocation) { LC.toast("Este navegador no tiene GPS disponible"); return; }
  btn.textContent = "📡 Buscando…";
  LC.obtenerPosicionMejorada(btn, "📡 Afinando", function (pos) {
    btn.textContent = orig;
    var c = pos.coords;
    LC.abrirRegistro();   /* crea (o recupera) el registro en curso y abre Nuevo; sin sesión activa, crea una */
    var d = LC.state.draft;
    if (!d || d._editando || d._viendo) { LC.toast("Hay un registro en edición. Usa Capturar ubicación dentro de Nuevo.", 5000); return; }
    LC.aplicarPosicionAlBorrador(c.latitude, c.longitude, c.altitude, c.accuracy, pos.muestras);
  }, function (err) {
    btn.textContent = orig;
    var msg = "No se pudo obtener la ubicación. Intenta de nuevo.";
    if (err && err.code === 1) msg = "Permiso de ubicación denegado. Actívalo en los ajustes del navegador.";
    else if (err && err.code === 3) msg = "Se agotó el tiempo de espera del GPS. Intenta de nuevo.";
    LC.toast(msg, 5000);
  });
}

/* ---------- gestor "Mapas sin conexión" ---------- */
var modal = null, modalCuerpo = null, vistaGestor = "mapas";
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
  vistaGestor = vista || "mapas";
  modal.classList.add("on");
  leerAlmacenamiento().then(renderGestor);
  renderGestor();
}
function cerrarGestor() { if (modal) modal.classList.remove("on"); }
function gestorAbierto() { return !!(modal && modal.classList.contains("on")); }

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
  }
  return el("div", { class: "mp-caja" }, cuerpo);
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

function renderGestor() {
  if (!modal || !gestorAbierto()) return;
  var cu = modalCuerpo, sc = cu.scrollTop;
  cu.textContent = "";
  var pestanas = el("div", { class: "mp-fila", style: "margin:0 0 10px;" }, [
    el("button", { class: vistaGestor === "mapas" ? "primario" : "", texto: "Mapas", onclick: function () { vistaGestor = "mapas"; renderGestor(); } }),
    el("button", { class: vistaGestor === "capas" ? "primario" : "", texto: "Capas", onclick: function () { vistaGestor = "capas"; renderGestor(); } }),
    el("button", { class: vistaGestor === "diag" ? "primario" : "", texto: "Diagnóstico", onclick: function () { vistaGestor = "diag"; renderGestor(); } })
  ]);
  cu.appendChild(pestanas);
  if (vistaGestor === "mapas") {
    cu.appendChild(el("div", { class: "mp-caja" }, [
      el("p", { class: "mp-suave", texto: (online ? "En línea. " : "Sin conexión. ") + catInfo }),
      el("p", { class: "mp-suave", texto: "Espacio usado por la app: " + (almEst.usado != null ? mb(almEst.usado) : "?") + " de " + (almEst.cuota != null ? mb(almEst.cuota) : "?") + ". Almacenamiento protegido: " + (almEst.protegido == null ? "sin dato" : almEst.protegido ? "sí" : "no") + "." }),
      el("div", { class: "mp-fila" }, [
        el("button", { texto: "Actualizar catálogo", disabled: online ? null : "disabled", onclick: async function () { await cargarCatalogo(); await leerAlmacenamiento(); refrescarUI(); } }),
        almEst.protegido === false ? el("button", { texto: "Pedir protección", onclick: async function () { try { await navigator.storage.persist(); } catch (e) {} await leerAlmacenamiento(); renderGestor(); } }) : null
      ])
    ]));
    if (!online) cu.appendChild(el("p", { class: "mp-suave", texto: "Sin conexión solo puedes usar o eliminar los mapas instalados." }));
    var vistos = {};
    if (cat) cat.mapas.forEach(function (e) { vistos[e.id] = 1; cu.appendChild(tarjetaMapa(e, true)); });
    Object.keys(inst).forEach(function (id) {
      if (vistos[id]) return;
      cu.appendChild(tarjetaMapa({ id: id, nombre: inst[id].nombre, region: inst[id].region, version: inst[id].version, archivos: inst[id].archivos.map(function (a) { return { tipo: a.tipo, bytes: a.bytes }; }) }, false));
    });
  } else if (vistaGestor === "capas") {
    var tieneRel = relieveNombres.length > 0 || mapasOrdenados().some(function (m) { return archivoTipo(m, "relieve"); });
    var chk = function (clave, texto, habil) {
      var inp = el("input", { type: "checkbox" }); inp.checked = !!capasVis[clave]; if (!habil) inp.disabled = true;
      inp.onchange = function () {
        capasVis[clave] = inp.checked; guardarJSON(LS_CAPAS, capasVis);
        var v = inp.checked ? "visible" : "none";
        if (!map || !mapaListo) return;
        if (clave === "sombra" && map.getLayer("relieve-sombra")) map.setLayoutProperty("relieve-sombra", "visibility", v);
        if (clave === "curvas") ["curvas-linea", "curvas-texto"].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); });
      };
      return el("label", { class: "mp-chk" }, [inp, el("span", { texto: texto })]);
    };
    cu.appendChild(chk("sombra", "Sombreado del relieve", tieneRel));
    cu.appendChild(chk("curvas", "Curvas de nivel (calculadas en el teléfono)", tieneRel));
    if (!tieneRel) cu.appendChild(el("p", { class: "mp-suave", texto: "Ninguno de los mapas instalados trae relieve." }));
    cu.appendChild(el("h3", { texto: "Capas de los mapas", style: "margin:16px 0 6px;font-size:1rem;" }));
    if (!Object.keys(inst).length) cu.appendChild(el("p", { class: "mp-suave", texto: "Instala un mapa para ver o importar sus capas." }));
    else {
      if (!capasActuales.length) cu.appendChild(el("p", { class: "mp-suave", texto: "Los mapas instalados no tienen capas todavía." }));
      var mapaGrupo = null;
      capasActuales.forEach(function (c) {
        if (c.mapaId !== mapaGrupo) { mapaGrupo = c.mapaId; cu.appendChild(el("div", { class: "mp-panel-grupo", texto: inst[c.mapaId] ? inst[c.mapaId].nombre : c.mapaId })); }
        var inp = el("input", { type: "checkbox" }); inp.checked = visCapa(c.clave);
        inp.onchange = function () {
          if (!capasVis.capas) capasVis.capas = {};
          capasVis.capas[c.clave] = inp.checked; guardarJSON(LS_CAPAS, capasVis); aplicarFiltrosCapas();
        };
        var sub = resumenCuenta(c.datos.cuenta) + (c.origen === "local" ? " · importada, solo en este teléfono" : " · del catálogo");
        var texto = el("span", {}, [el("b", { texto: c.nombre }), el("br"), el("span", { class: "mp-suave", texto: sub })]);
        var fila = [el("label", { class: "mp-chk", style: "flex:1;" }, [inp, texto])];
        var caja = el("div", { style: "display:flex;align-items:center;gap:8px;" }, fila);
        if (c.origen === "local") caja.appendChild(el("button", { texto: "Eliminar", style: "min-height:40px;padding:0 10px;border-radius:10px;border:1px solid var(--borde);background:var(--card);color:var(--texto);font-weight:700;", onclick: function () { if (confirm("¿Eliminar la capa importada «" + c.nombre + "»?")) eliminarCapaLocal(c.id); } }));
        cu.appendChild(caja);
      });
      var inpArch = el("input", { type: "file", accept: ".geojson,.json,.gpx,.zip,application/geo+json,application/json,application/gpx+xml,application/zip", style: "display:none;" });
      var idsInst = Object.keys(inst).sort();
      if (!mapaImportId || !inst[mapaImportId]) { var sA = LC.sesionActiva(); mapaImportId = sA && sA.mapaId && inst[sA.mapaId] ? sA.mapaId : idsInst[0]; }
      var selImp = el("select", { id: "mp-import-sel" });
      idsInst.forEach(function (id) { selImp.appendChild(el("option", { value: id, texto: nombreCorto(inst[id].nombre) })); });
      selImp.value = mapaImportId;
      selImp.onchange = function () { mapaImportId = selImp.value; };
      cu.appendChild(el("h3", { texto: "Importar una capa", style: "margin:16px 0 6px;font-size:1rem;" }));
      cu.appendChild(el("p", { class: "mp-suave", texto: "Asociar la capa al mapa:" }));
      cu.appendChild(el("div", { class: "field" }, [selImp]));
      inpArch.onchange = function () { var f = inpArch.files && inpArch.files[0]; inpArch.value = ""; if (f) importarCapaLocal(f, mapaImportId); };
      cu.appendChild(inpArch);
      cu.appendChild(el("div", { class: "mp-fila" }, [el("button", { class: "primario", texto: "⬆️ Importar capa desde un archivo", onclick: function () { inpArch.click(); } })]));
      cu.appendChild(el("p", { class: "mp-suave", texto: "GeoJSON, GPX o shapefile en .zip. La capa queda asociada al mapa elegido (se borra si eliminas ese mapa) y solo se guarda en este teléfono: no se publica ni se incluye en la exportación. Útil para sitios sensibles." }));
    }
  } else {
    cu.appendChild(el("pre", { class: "mp-pre", texto: infoDiag() }));
    cu.appendChild(el("div", { class: "mp-fila" }, [
      el("button", { texto: "Copiar informe", onclick: function () {
        var t = infoDiag();
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { LC.toast("Informe copiado"); }, function () { LC.toast("No se pudo copiar"); });
        else LC.toast("Este navegador no permite copiar");
      } }),
      el("button", { texto: "Prueba de fluidez (15 s)", onclick: pruebaFluidez }),
      el("button", { texto: "Apagar GPS", onclick: function () { gpsApagar(true); } })
    ]));
  }
  cu.scrollTop = sc;
}

/* ---------- bloque "Mapa asociado" (pestaña Sesión) ---------- */
function estadoAsociado(s) {
  if (!s.mapaId) return { txt: "Sin mapa asociado. La pestaña Mapa mostrará igual todos los mapas instalados; asociar uno sirve para que la app te avise si falta descargarlo y para llevarte a su zona al abrir la sesión.", cls: "" };
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
  campo.appendChild(el("div", { class: "bloque-subtitulo", texto: "🗺️ Mapa asociado" }));
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

/* ---------- arranque ---------- */
function construirPantalla() {
  var pant = $("s-mapa"); if (!pant) return;
  pant.innerHTML =
    '<div class="topbar mp-topbar"><div class="brand"><span class="ic">🗺️</span><div><h2>Mapa</h2><p class="sub" id="mp-sub">Sin mapa instalado</p></div></div></div>' +
    '<div id="mp-lienzo">' +
    '<div id="mp-mapa"></div>' +
    '<div id="mp-barra"><button type="button" class="mp-chip mp-chip-btn" id="mp-chip-gps">GPS activar</button><button type="button" class="mp-chip mp-chip-btn rojo" id="mp-chip-rec" style="display:none"></button><button type="button" class="mp-chip mp-chip-btn rojo" id="mp-chip-grab" style="display:none"></button><span class="mp-chip" id="mp-chip-red" style="display:none">Sin conexión</span><button type="button" class="mp-chip mp-chip-btn ok" id="mp-volver-reg" style="display:none">↩ Volver al registro</button></div>' +
    '<div id="mp-ctrl">' +
      '<button type="button" class="mp-btn chico" id="mp-puntos">Mis puntos</button>' +
      '<button type="button" class="mp-btn chico" id="mp-mapas">Mapas</button>' +
      '<button type="button" class="mp-btn chico" id="mp-grabar">⏺ Grabar</button>' +
      '<button type="button" class="mp-btn mp-centrar" id="mp-centrar" aria-label="Centrar en mi ubicación" style="display:none">◎</button>' +
      '<button type="button" class="mp-btn mp-centrar" id="mp-norte" aria-label="Volver al norte" style="display:none"><svg viewBox="-13 -13 26 26" width="26" height="26" aria-hidden="true"><g id="mp-norte-g"><polygon points="0,-11 5,1 -5,1" fill="#b5473a"/><polygon points="0,11 5,1 -5,1" fill="#8a8f8a"/></g></svg></button>' +
      '<button type="button" class="mp-btn chico" id="mp-rumbo" style="display:none">Rumbo arriba</button>' +
    '</div>' +
    '<div id="mp-aviso"></div>' +
    '<div id="mp-panel-puntos"></div>' +
    '<div id="mp-nav"><div class="mp-nav-cab"><b id="mp-nav-nombre">Hacia</b><button type="button" class="mp-panel-x" id="mp-nav-cerrar" aria-label="Terminar navegación">✕</button></div>' +
      '<div class="mp-nav-cuerpo">' + dibujarRosa() + '<div class="mp-nav-datos"><div id="mp-nav-rumbo" class="mp-nav-grande">—</div><div id="mp-nav-dist" class="mp-nav-med"></div><div id="mp-nav-eta" class="mp-suave"></div></div></div></div>' +
    '<div id="mp-tarjeta"></div>' +
    '<button type="button" class="mp-btn" id="mp-guardar">📍 Guardar punto aquí</button>' +
    '</div>';
  $("mp-chip-gps").onclick = function () { if (gps.watch == null) gpsEncender(); else gpsApagar(true); };
  $("mp-centrar").onclick = function () { if (gps.fix && map) map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 16), duration: 400 }); };
  $("mp-puntos").onclick = alternarPanelPuntos;
  $("mp-mapas").onclick = function () { abrirGestor("mapas"); };
  $("mp-nav-cerrar").onclick = terminarNavegacion;
  $("mp-guardar").onclick = guardarPuntoAqui;
  $("mp-volver-reg").onclick = volverAlRegistro;
  $("mp-grabar").onclick = function () { if (grab.rc) detenerGrabacion(false); else iniciarGrabacion(); };
  $("mp-chip-grab").onclick = function () { detenerGrabacion(false); };
  $("mp-chip-rec").onclick = function () { LC.abrirRegistro(); };   /* vuelve a la Observación que se está grabando */
  $("mp-norte").onclick = function () { if (map) map.easeTo({ bearing: 0, duration: 300 }); if (rumbo.activo) apagarRumbo(false); };
  $("mp-rumbo").onclick = function () { if (rumbo.activo) apagarRumbo(true); else encenderRumbo(); };
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
  window.addEventListener("online", function () { online = true; chipMapa(); cargarCatalogo().then(refrescarUI); });
  window.addEventListener("offline", function () { online = false; chipMapa(); refrescarUI(); });
  if (!LISTO) return;
  construirPantalla();
  estiloPromesa = fetch(RUTA_MAPA + "estilo-base.json").then(function (r) { return r.json(); }).then(function (j) { ESTILO_BASE = j; }).catch(function (e) { anotarError("estilo", e); });
  await estiloPromesa;
  await reconciliar();
  await leerAlmacenamiento();
  await cargarCatalogo();
  refrescarUI();
  LC.actualizarPestanaMapa();
  if (LC.state.currentView === "mapa") alMostrar();
  precargarArchivos();
}

window.MapaPro = {
  init: init, alMostrar: alMostrar, alOcultar: alOcultar, renderAsociado: renderAsociado,
  abrirGestor: abrirGestor, alDesactivar: alDesactivar, verPunto: verPunto,
  /* para pruebas */
  _debug: function () { return { geoNav: geoNav, nav: nav, capas: capasActuales, capasLoc: capasLoc, map: map, inst: inst, Alm: Alm, metricas: metricas, errores: errores, estiloFirma: estiloFirma, relieveNombres: relieveNombres, construirEstilo: construirEstilo, verMapa: verMapa, aplicarMapas: aplicarMapas, gps: gps, rumbo: rumbo, geoPuntos: geoPuntos, geoTracks: geoTracks, geoVivo: geoVivo, conjuntosPuntos: conjuntosPuntos, rumboDispositivo: rumboDispositivo, alOrientacion: alOrientacion, encenderRumbo: encenderRumbo, apagarRumbo: apagarRumbo, refrescarVivo: refrescarVivo, renderPanelPuntos: renderPanelPuntos, grab: grab, iniciarGrabacion: iniciarGrabacion, detenerGrabacion: detenerGrabacion, geoRecorridos: geoRecorridos, grabPunto: grabPunto, refrescarRecorridos: refrescarRecorridos, borrarRecorrido: borrarRecorrido, chipGrab: chipGrab }; }
};
})();
