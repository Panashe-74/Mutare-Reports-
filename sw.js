/* Service worker: caches the app shell and Leaflet, and map tiles as they are viewed. */
var VERSION = "v3";
var SHELL_CACHE = "mutare-shell-" + VERSION;
var TILE_CACHE = "mutare-tiles-" + VERSION;
var MAX_TILES = 600;

var SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        // Cache each item separately so one failure does not block install.
        return cache.add(url).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== SHELL_CACHE && k !== TILE_CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function trimCache(name, max) {
  caches.open(name).then(function (cache) {
    cache.keys().then(function (keys) {
      if (keys.length > max) {
        cache.delete(keys[0]).then(function () { trimCache(name, max); });
      }
    });
  });
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);

  // Map tiles: cache-first, fill as the user browses.
  if (url.hostname.indexOf("server.arcgisonline.com") !== -1) {
    event.respondWith(
      caches.open(TILE_CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && res.status === 200) {
              cache.put(req, res.clone());
              trimCache(TILE_CACHE, MAX_TILES);
            }
            return res;
          }).catch(function () { return hit || Response.error(); });
        });
      })
    );
    return;
  }

  // App shell and Leaflet: network-first for own files so updates arrive, cache fallback offline.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && (url.origin === location.origin || url.hostname === "unpkg.com")) {
        var copy = res.clone();
        caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match("./index.html");
      });
    })
  );
});
