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

var relieveNombre = null, demSource = null;
function nuevoManagerDem() {
  demSource.manager = new mlcontour.LocalDemManager({
    demUrlPattern: "lcdem://{z}/{x}/{y}", cacheSize: 128, encoding: "terrarium", maxzoom: 12, timeoutMs: 20000,
    getTile: async function (url) {
      var m = /(\d+)\/(\d+)\/(\d+)$/.exec(url);
      if (!m || !relieveNombre) throw new Error("sin relieve");
      var d = await bytesTesela(relieveNombre, +m[1], +m[2], +m[3]);
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
var actualId = localStorage.getItem(LS_ACTUAL) || null;   /* mapa mostrado en la pestaña Mapa */
var estiloId = undefined;                /* mapa cuyo estilo está aplicado (null = fondo liso) */
var ultimaSesionVista = null;
var capasVis = leerJSON(LS_CAPAS, { sombra: true, curvas: true, anteriores: true });
var online = navigator.onLine !== false;
var map = null, mapaListo = false, ESTILO_BASE = [], estiloPromesa = null;
var gps = { watch: null, fix: null, primera: true, quiere: false };
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
  if (m && m.capas) m.capas.forEach(function (c) { out.push({ clave: "c:" + mapaId + ":" + c.id, id: c.id, nombre: c.nombre || c.id, origen: "catalogo", archivo: c.archivo, tipo: c.tipo }); });
  capasLoc.filter(function (c) { return c.mapaId === mapaId; }).forEach(function (c) { out.push({ clave: "l:" + c.id, id: c.id, nombre: c.nombre, origen: "local", archivo: c.archivo, tipo: c.tipo }); });
  return out;
}
async function cargarCapasMapa(mapaId) {
  var lista = mapaId ? capasDelMapa(mapaId) : [], res = [];
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
async function recargarCapas() { await cargarCapasMapa(estiloId); refrescarCapasMapa(); renderGestor(); }
function crearRombo(col) {
  var c = document.createElement("canvas"); c.width = c.height = 32;
  var g = c.getContext("2d");
  g.beginPath(); g.moveTo(16, 2); g.lineTo(30, 16); g.lineTo(16, 30); g.lineTo(2, 16); g.closePath();
  g.fillStyle = col; g.fill(); g.lineWidth = 3; g.strokeStyle = "#ffffff"; g.stroke();
  var d = g.getImageData(0, 0, 32, 32);
  return { width: 32, height: 32, data: d.data };
}
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
async function importarCapaLocal(file) {
  if (!estiloId || !inst[estiloId]) { LC.toast("Abre un mapa primero"); return; }
  var tipo = tipoPorNombre(file.name);
  if (!tipo) { LC.toast("Formato no admitido. Usa GeoJSON, GPX o shapefile en .zip", 5000); return; }
  if (file.size > 25 * 1048576) { LC.toast("El archivo pesa más de 25 MB", 5000); return; }
  var m = inst[estiloId], r;
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
  capasLoc.push({ id: id, mapaId: estiloId, nombre: file.name.replace(/\.[^.]+$/, ""), archivo: archivo, tipo: tipo, bytes: blob.size, fecha: fechaHM(), elementos: r.cuenta });
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
  if (actualId && !inst[actualId]) { actualId = null; localStorage.removeItem(LS_ACTUAL); }
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
    if (actualId === entrada.id) estiloId = undefined;   /* fuerza redibujar con los archivos nuevos */
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
  if (actualId === id) { actualId = null; localStorage.removeItem(LS_ACTUAL); estiloId = undefined; }
  await leerAlmacenamiento();
  refrescarUI();
  if (LC.state.currentView === "mapa") alMostrar();
  LC.toast("Mapa eliminado");
  LC.actualizarPestanaMapa();
}

/* ---------- puntos de la libreta (registros con coordenadas) ---------- */
function geoPuntos() {
  var fs = [];
  LC.state.registros.forEach(function (r) {
    var la = parseFloat(r.lat), lo = parseFloat(r.lon);
    if (!isFinite(la) || !isFinite(lo) || r.lat === "" || r.lon === "") return;
    fs.push({ type: "Feature",
      properties: { id: r.id, codigo: r.codigo || r.notaTitulo || "", sesion: r.sesionId, activa: r.sesionId === LC.state.sesionActivaId ? 1 : 0, color: LC.colorSesion(r.sesionId) },
      geometry: { type: "Point", coordinates: [lo, la] } });
  });
  return { type: "FeatureCollection", features: fs };
}
var pendienteVer = null, resaltado = null, resaltadoT = null;
function geoResaltado() {
  return { type: "FeatureCollection", features: resaltado ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [resaltado.lng, resaltado.lat] } }] : [] };
}
function ponerResaltado(p) {
  resaltado = p; clearTimeout(resaltadoT);
  if (map && mapaListo && map.getSource("resaltado")) map.getSource("resaltado").setData(geoResaltado());
  if (p) resaltadoT = setTimeout(function () { ponerResaltado(null); }, 15000);
}
function verPunto(reg) {
  if (!reg || !isFinite(reg.lat) || !isFinite(reg.lon)) { LC.toast("Este registro no tiene ubicación"); return; }
  var ses = reg.sesionId ? LC.sesionPorId(reg.sesionId) : null;
  if (ses && ses.mapaId && inst[ses.mapaId]) { actualId = ses.mapaId; localStorage.setItem(LS_ACTUAL, actualId); }
  pendienteVer = { lng: reg.lon, lat: reg.lat };
  LC.irA("mapa");
}
function refrescarPuntos() { if (map && mapaListo && map.getSource("puntos")) map.getSource("puntos").setData(geoPuntos()); }

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
  c.className = "mp-chip";
  if (gps.watch == null) { c.textContent = "GPS apagado"; return; }
  if (!gps.fix) { c.textContent = "GPS buscando…"; return; }
  var a = Math.round(gps.fix.acc);
  c.textContent = "GPS ±" + a + " m";
  c.className = "mp-chip " + (a <= 10 ? "ok" : a <= 25 ? "ambar" : "rojo");
}
function gpsOk(p) {
  gps.fix = { lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: Date.now() };
  metricas.gpsUltimo = { acc: Math.round(p.coords.accuracy), hora: fechaHM() };
  if (map && mapaListo && map.getSource("gps")) map.getSource("gps").setData(geoGps());
  chipGps();
  if (gps.primera) { gps.primera = false; map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 }); }
}
function gpsError(e) {
  var c = $("mp-chip-gps"); if (c) { c.className = "mp-chip rojo"; c.textContent = e.code === 1 ? "GPS sin permiso" : "GPS sin señal"; }
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
function filtroPuntos() { return capasVis.anteriores ? ["has", "id"] : ["==", ["get", "activa"], 1]; }

function construirEstilo(m) {
  var estilo = { version: 8, glyphs: rutaBase() + RUTA_MAPA + "fuentes/{fontstack}/{range}.pbf", sources: {}, layers: [] };
  var baseN = m ? archivoTipo(m, "base") : null, relN = m ? archivoTipo(m, "relieve") : null;
  var capas;
  if (baseN) {
    estilo.sources.base = { type: "vector", tiles: ["lcmap://" + baseN + "/{z}/{x}/{y}"], minzoom: 0, maxzoom: 15, bounds: m.area, attribution: "© OpenStreetMap" };
    capas = ESTILO_BASE.slice();
  } else capas = [{ id: "fondo", type: "background", paint: { "background-color": "#eef0ec" } }];
  var extra = [], etiquetas = [];
  if (relN) {
    estilo.sources.dem = { type: "raster-dem", tiles: [demSource.sharedDemProtocolUrl], tileSize: 512, maxzoom: 12, encoding: "terrarium", attribution: "Relieve: Mapterhorn" };
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
  var idx = capas.length;
  for (var i = 0; i < capas.length; i++) { if (capas[i].type === "line" && !/^water/.test(capas[i].id)) { idx = i; break; } }
  capas = capas.slice(0, idx).concat(extra, capas.slice(idx), etiquetas);
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
  capas.push({ id: "puntos-circ", type: "circle", source: "puntos", filter: filtroPuntos(),
    paint: { "circle-radius": ["case", ["==", ["get", "activa"], 1], 10, 6], "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  capas.push({ id: "puntos-texto", type: "symbol", source: "puntos", filter: filtroPuntos(),
    layout: { "text-field": ["get", "codigo"], "text-font": ["NotoSans-Medium"], "text-size": ["case", ["==", ["get", "activa"], 1], 13, 10], "text-offset": [0, 1.5], "text-anchor": "top", "text-allow-overlap": true },
    paint: { "text-color": "#222222", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
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
    container: "mp-mapa", style: construirEstilo(null), center: [-72.59, -38.66], zoom: 5, maxZoom: 19,
    attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 0
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 100 }), "bottom-right");
  map.on("error", function (ev) {
    var msg = ev && ev.error && ev.error.message ? ev.error.message : "";
    if (/fuera del área|sin relieve/.test(msg)) return;
    anotarError("mapa", ev.error || ev);
  });
  map.on("styleimagemissing", function (e) {
    if (e.id === "rombo-cat" || e.id === "rombo-local") map.addImage(e.id, crearRombo(e.id === "rombo-local" ? COL_LOC : COL_CAT));
  });
  map.on("click", function (ev) {
    if (resaltado) ponerResaltado(null);
    var p = ev.point, caja = [[p.x - 14, p.y - 14], [p.x + 14, p.y + 14]];
    if (map.getLayer("puntos-circ")) {
      var fs = map.queryRenderedFeatures(caja, { layers: ["puntos-circ"] });
      if (fs.length) { cerrarTarjeta(); LC.verRegistroExistente(fs[0].properties.id, "mapa"); return; }
    }
    var ls = ["capas-estaciones", "capas-lineas"].filter(function (l) { return map.getLayer(l); });
    if (ls.length) {
      var gs = map.queryRenderedFeatures(caja, { layers: ls });
      if (gs.length) { mostrarTarjetaCapa(gs[0], ev.lngLat); return; }
    }
    cerrarTarjeta();
  });
  map.on("mouseenter", "puntos-circ", function () { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "puntos-circ", function () { map.getCanvas().style.cursor = ""; });
  estiloId = null;
  map.once("load", function () { mapaListo = true; alMostrar(); });
}

async function aplicarMapa(id) {
  var m = id ? inst[id] : null;
  await cargarCapasMapa(id);
  return new Promise(function (res) {
    var t0 = performance.now();
    pmCache = {};
    relieveNombre = m ? archivoTipo(m, "relieve") : null;
    nuevoManagerDem();
    estiloId = id || null;
    map.setStyle(construirEstilo(m), { diff: false });
    var a = m && m.area;
    if (a) {
      var c = map.getCenter();
      var dentro = c.lng >= a[0] && c.lng <= a[2] && c.lat >= a[1] && c.lat <= a[3];
      if (!dentro || map.getZoom() < 10) map.fitBounds([[a[0], a[1]], [a[2], a[3]]], { padding: 20, animate: false, maxZoom: 14 });
    }
    map.once("idle", function () { metricas.aperturaMs = Math.round(performance.now() - t0); res(); });
    chipMapa();
  });
}

function mapaObjetivo() {
  var s = LC.sesionActiva() || LC.sesionEnPantalla();
  var sid = s ? s.id : null;
  if (sid !== ultimaSesionVista) {
    ultimaSesionVista = sid;
    if (s && s.mapaId && inst[s.mapaId]) { actualId = s.mapaId; localStorage.setItem(LS_ACTUAL, actualId); }
  }
  if (actualId && inst[actualId]) return actualId;
  return null;
}
function chipMapa() {
  var c = $("mp-sub"); if (!c) return;
  c.textContent = estiloId && inst[estiloId] ? nombreCorto(inst[estiloId].nombre) : "Sin mapa instalado";
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
  var obj = mapaObjetivo();
  if (estiloId !== obj) await aplicarMapa(obj);
  refrescarPuntos();
  actualizarAviso(); chipMapa(); chipGps();
  if (gps.quiere && gps.watch == null) gpsEncender();
  if (pendienteVer) {
    var pv = pendienteVer; pendienteVer = null;
    map.easeTo({ center: [pv.lng, pv.lat], zoom: Math.max(map.getZoom(), 16.5), duration: 600 });
    ponerResaltado(pv);
  }
}
function alOcultar() {
  cerrarTarjeta();
  document.body.classList.remove("vista-mapa");
  if (gps.watch != null) gpsApagar(false);   /* ahorra batería; vuelve a encender al regresar */
}

/* ---------- Guardar punto aquí ---------- */
function guardarPuntoAqui() {
  var btn = $("mp-guardar"), orig = "📍 Guardar punto aquí";
  if (LC.gpsCapturaActiva()) { LC.gpsCapturaActiva().cerrarYa(); return; }
  if (!navigator.geolocation) { LC.toast("Este navegador no tiene GPS disponible"); return; }
  var habiaSesion = !!LC.sesionActiva();
  btn.textContent = "📡 Buscando…";
  LC.obtenerPosicionMejorada(btn, "📡 Afinando", function (pos) {
    btn.textContent = orig;
    var c = pos.coords;
    LC.abrirRegistro();   /* crea (o recupera) el registro en curso y abre Nuevo; sin sesión activa, crea una */
    var d = LC.state.draft;
    if (!d || d._editando || d._viendo) { LC.toast("Hay un registro en edición. Usa Capturar ubicación dentro de Nuevo.", 5000); return; }
    if (!habiaSesion) {
      var s = LC.sesionActiva();
      if (s && !s.mapaId && actualId && inst[actualId]) { s.mapaId = actualId; LC.guardarListaSesiones(); }
    }
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
  caja.appendChild(el("h2", { texto: "Mapas sin conexión", style: "margin:0 0 10px;font-size:1.1rem;" }));
  modalCuerpo = el("div", { id: "mp-modal-cuerpo" });
  caja.appendChild(modalCuerpo);
  caja.appendChild(el("div", { class: "mp-fila" }, [el("button", { class: "primario", texto: "Cerrar", onclick: cerrarGestor })]));
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
      cuerpo.push(el("p", { class: "mp-suave", texto: "Instalado, versión " + i.version + ", guardado " + i.fecha + (actualId === id ? " · en uso" : "") }));
      var nLoc = capasLoc.filter(function (c) { return c.mapaId === id; }).length;
      cuerpo.push(el("p", { class: "mp-suave", texto: "Capas instaladas: " + (i.capas || []).length + (nLoc ? " · importadas: " + nLoc : "") }));
      var hayVersion = enCatalogo && entrada.version && entrada.version !== i.version, pend = enCatalogo ? capasPendientes(entrada) : [];
      if (hayVersion) fila.push(el("button", { class: "primario", texto: "Actualizar a " + entrada.version, disabled: online ? null : "disabled", onclick: function () { descargarMapa(entrada); } }));
      else if (pend.length) fila.push(el("button", { class: "primario", texto: "Descargar capas (" + pend.length + ")", disabled: online ? null : "disabled", onclick: function () { descargarMapa(entrada, true); } }));
      if (actualId !== id) fila.push(el("button", { texto: "Usar en el mapa", onclick: function () { actualId = id; localStorage.setItem(LS_ACTUAL, id); cerrarGestor(); if (LC.state.currentView === "mapa") alMostrar(); else LC.irA("mapa"); } }));
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
  L.push("Mapa en uso: " + (estiloId && inst[estiloId] ? inst[estiloId].nombre : "ninguno") + ". Apertura hasta imagen estable: " + (metricas.aperturaMs != null ? metricas.aperturaMs + " ms" : "sin medir"));
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
  if (!map || !estiloId) { LC.toast("Abre un mapa primero en la pestaña Mapa"); return; }
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
    var tieneRel = !!(estiloId && inst[estiloId] && archivoTipo(inst[estiloId], "relieve"));
    var chk = function (clave, texto, habil) {
      var inp = el("input", { type: "checkbox" }); inp.checked = !!capasVis[clave]; if (!habil) inp.disabled = true;
      inp.onchange = function () {
        capasVis[clave] = inp.checked; guardarJSON(LS_CAPAS, capasVis);
        var v = inp.checked ? "visible" : "none";
        if (!map || !mapaListo) return;
        if (clave === "sombra" && map.getLayer("relieve-sombra")) map.setLayoutProperty("relieve-sombra", "visibility", v);
        if (clave === "curvas") ["curvas-linea", "curvas-texto"].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); });
        if (clave === "anteriores") ["puntos-circ", "puntos-texto"].forEach(function (id) { if (map.getLayer(id)) map.setFilter(id, filtroPuntos()); });
      };
      return el("label", { class: "mp-chk" }, [inp, el("span", { texto: texto })]);
    };
    cu.appendChild(chk("sombra", "Sombreado del relieve", tieneRel));
    cu.appendChild(chk("curvas", "Curvas de nivel (calculadas en el teléfono)", tieneRel));
    cu.appendChild(chk("anteriores", "Puntos de sesiones anteriores", true));
    if (!tieneRel) cu.appendChild(el("p", { class: "mp-suave", texto: "El mapa abierto no trae relieve." }));
    cu.appendChild(el("h3", { texto: "Capas del mapa", style: "margin:16px 0 6px;font-size:1rem;" }));
    if (!estiloId || !inst[estiloId]) cu.appendChild(el("p", { class: "mp-suave", texto: "Abre un mapa para ver o importar sus capas." }));
    else {
      if (!capasActuales.length) cu.appendChild(el("p", { class: "mp-suave", texto: "Este mapa no tiene capas todavía." }));
      capasActuales.forEach(function (c) {
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
      inpArch.onchange = function () { var f = inpArch.files && inpArch.files[0]; inpArch.value = ""; if (f) importarCapaLocal(f); };
      cu.appendChild(inpArch);
      cu.appendChild(el("div", { class: "mp-fila" }, [el("button", { class: "primario", texto: "⬆️ Importar capa desde un archivo", onclick: function () { inpArch.click(); } })]));
      cu.appendChild(el("p", { class: "mp-suave", texto: "GeoJSON, GPX o shapefile en .zip. La capa queda asociada a este mapa y solo se guarda en este teléfono: no se publica ni se incluye en la exportación. Útil para sitios sensibles." }));
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
  if (!s.mapaId) return { txt: "Sin mapa asociado. La pestaña Mapa mostrará solo tus puntos sobre fondo liso.", cls: "" };
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
  var campo = el("div", { class: "field" });
  campo.appendChild(el("label", { texto: "🗺️ Mapa asociado" }));
  var sel = el("select", { id: "mp-asoc-sel" });
  sel.appendChild(el("option", { value: "", texto: "Sin mapa" }));
  var ids = [], vistos = {};
  if (cat) cat.mapas.forEach(function (m) { if (!vistos[m.id]) { vistos[m.id] = 1; ids.push({ id: m.id, nombre: m.nombre }); } });
  Object.keys(inst).forEach(function (id) { if (!vistos[id]) { vistos[id] = 1; ids.push({ id: id, nombre: inst[id].nombre }); } });
  if (s.mapaId && !vistos[s.mapaId]) ids.push({ id: s.mapaId, nombre: s.mapaId + " (no disponible)" });
  ids.forEach(function (m) { sel.appendChild(el("option", { value: m.id, texto: (inst[m.id] ? "✅ " : "⬇️ ") + nombreCorto(m.nombre) })); });
  sel.value = s.mapaId || "";
  sel.onchange = function () {
    var sesion = LC.sesionPorId(s.id); if (!sesion) return;
    sesion.mapaId = sel.value || null;
    if (!sesion.mapaId) delete sesion.mapaId;
    LC.guardarListaSesiones();
    if (sesion.id === (LC.sesionActiva() || {}).id && sesion.mapaId && inst[sesion.mapaId]) { actualId = sesion.mapaId; localStorage.setItem(LS_ACTUAL, actualId); }
    renderAsociado(sesion);
    LC.actualizarPestanaMapa();
    LC.toast(sesion.mapaId ? "Mapa asociado a la sesión" : "Sesión sin mapa");
  };
  campo.appendChild(sel);
  var est = estadoAsociado(s);
  campo.appendChild(el("p", { class: "mp-asoc-estado " + est.cls, id: "mp-asoc-estado", texto: est.txt }));
  var fila = [];
  if (s.mapaId && !inst[s.mapaId] && entradaCatalogo(s.mapaId)) {
    var bd = el("button", { type: "button", class: "btnfull btn-primary", style: "margin:8px 0 0;", texto: "⬇️ Descargar este mapa", onclick: function () { descargarMapa(entradaCatalogo(s.mapaId)); } });
    if (!online || desc) bd.setAttribute("disabled", "disabled");
    fila.push(bd);
  }
  if (s.mapaId && inst[s.mapaId]) fila.push(el("button", { type: "button", class: "btnfull btn-secondary", style: "margin:8px 0 0;", texto: "🗺️ Ver este mapa", onclick: function () { actualId = s.mapaId; localStorage.setItem(LS_ACTUAL, actualId); LC.irA("mapa"); } }));
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
    '<div id="mp-barra"><span class="mp-chip" id="mp-chip-gps">GPS apagado</span><span class="mp-chip" id="mp-chip-red" style="display:none">Sin conexión</span></div>' +
    '<div id="mp-ctrl">' +
      '<button type="button" class="mp-btn" id="mp-mas" aria-label="Acercar">+</button>' +
      '<button type="button" class="mp-btn" id="mp-menos" aria-label="Alejar">−</button>' +
      '<button type="button" class="mp-btn" id="mp-gps" aria-label="GPS y centrar">GPS</button>' +
      '<button type="button" class="mp-btn chico" id="mp-puntos">Mis puntos</button>' +
      '<button type="button" class="mp-btn chico" id="mp-mapas">Mapas</button>' +
    '</div>' +
    '<div id="mp-aviso"></div>' +
    '<div id="mp-tarjeta"></div>' +
    '<button type="button" class="mp-btn" id="mp-guardar">📍 Guardar punto aquí</button>' +
    '</div>';
  $("mp-mas").onclick = function () { if (map) map.zoomIn(); };
  $("mp-menos").onclick = function () { if (map) map.zoomOut(); };
  $("mp-gps").onclick = function () {
    if (gps.watch == null) gpsEncender();
    else if (gps.fix && map) map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 15), duration: 400 });
  };
  $("mp-gps").ondblclick = function () { gpsApagar(true); };
  $("mp-puntos").onclick = function () {
    var fs = geoPuntos().features.filter(function (f) { return f.properties.activa; });
    if (!fs.length) fs = geoPuntos().features;
    if (!fs.length) { LC.toast("Aún no hay registros con ubicación"); return; }
    var b = new maplibregl.LngLatBounds();
    fs.forEach(function (f) { b.extend(f.geometry.coordinates); });
    map.fitBounds(b, { padding: 60, maxZoom: 17, duration: 500 });
  };
  $("mp-mapas").onclick = function () { abrirGestor("mapas"); };
  $("mp-guardar").onclick = guardarPuntoAqui;
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
  gpsApagar(true); cerrarGestor();
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
  _debug: function () { return { capas: capasActuales, capasLoc: capasLoc, map: map, inst: inst, Alm: Alm, metricas: metricas, errores: errores, estiloId: estiloId, actualId: actualId, gps: gps }; }
};
})();
