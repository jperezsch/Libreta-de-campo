// Service Worker de Libreta de Campo (WikiTaxa)
// Estrategia: network-first, con caché como respaldo solo si no hay conexión.
// Así los cambios nuevos se ven de inmediato en cuanto hay internet.
var CACHE_NAME = "libreta-campo-v2";
var ARCHIVOS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", function(evt){
  evt.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(ARCHIVOS); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(evt){
  evt.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function(evt){
  if(evt.request.method !== "GET") return;
  evt.respondWith(
    fetch(evt.request).then(function(resp){
      var respClone = resp.clone();
      caches.open(CACHE_NAME).then(function(cache){ cache.put(evt.request, respClone); });
      return resp;
    }).catch(function(){
      return caches.match(evt.request).then(function(cached){
        return cached || caches.match("./index.html");
      });
    })
  );
});
