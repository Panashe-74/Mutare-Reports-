/* Mutare Reports - offline-first field reporting PWA */
(function () {
  "use strict";

  var MUTARE = [-18.9707, 32.6709];
  var DB_NAME = "mutare-reports";
  var STORE = "reports";
  var db = null;
  var map, markersLayer, pickMarker = null, userDot = null;
  var pickedLatLng = null;
  var photoDataUrl = null;
  var reports = [];
  var openId = null;
  var picking = false;

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }

  function showFormError(msg) {
    var el = $("form-error");
    el.textContent = msg;
    el.hidden = false;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  function uid() {
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  // ---------- IndexedDB ----------
  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(mode) { return db.transaction(STORE, mode).objectStore(STORE); }

  function dbAll() {
    return new Promise(function (resolve, reject) {
      var r = tx("readonly").getAll();
      r.onsuccess = function () { resolve(r.result || []); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function dbPut(item) {
    return new Promise(function (resolve, reject) {
      var r = tx("readwrite").put(item);
      r.onsuccess = function () { resolve(); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function dbDelete(id) {
    return new Promise(function (resolve, reject) {
      var r = tx("readwrite").delete(id);
      r.onsuccess = function () { resolve(); };
      r.onerror = function () { reject(r.error); };
    });
  }

  // ---------- map ----------
  function initMap() {
    map = L.map("map", { zoomControl: true }).setView(MUTARE, 13);
    var streets = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri, HERE, Garmin, OpenStreetMap contributors"
    });
    var topo = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri, HERE, Garmin, USGS, OpenStreetMap contributors"
    });
    var satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19,
      maxNativeZoom: 17,
      attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics"
    });
    streets.addTo(map);
    L.control.layers({ "Streets": streets, "Topographic": topo, "Satellite": satellite }, null, { position: "topright" }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);

    map.on("click", function (e) {
      if ($("form-dialog").open) return;
      setPicked(e.latlng.lat, e.latlng.lng, "Location picked on map");
      if (picking) {
        picking = false;
        $("pick-banner").hidden = true;
        $("form-dialog").showModal();
      }
    });
  }

  var sevColor = { Low: "#4f8f5b", Medium: "#c98a12", High: "#b3261e" };

  function renderMarkers() {
    markersLayer.clearLayers();
    reports.forEach(function (r) {
      var m = L.circleMarker([r.lat, r.lng], {
        radius: 9,
        color: "#fff",
        weight: 2,
        fillColor: sevColor[r.severity] || "#0f6b4f",
        fillOpacity: 0.95
      });
      m.on("click", function () { showDetail(r.id); });
      m.bindTooltip(r.category);
      m.addTo(markersLayer);
    });
  }

  var accCircle = null;
  var watchId = null;
  var watchTimer = null;

  function setPicked(lat, lng, msg, accuracy) {
    pickedLatLng = { lat: lat, lng: lng, accuracy: accuracy || null };
    if (pickMarker) map.removeLayer(pickMarker);
    if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
    pickMarker = L.marker([lat, lng], { draggable: true }).addTo(map);
    pickMarker.on("dragend", function () {
      var p = pickMarker.getLatLng();
      if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
      pickedLatLng = { lat: p.lat, lng: p.lng, accuracy: null };
      $("loc-status").textContent = "Pin moved by hand (" + p.lat.toFixed(5) + ", " + p.lng.toFixed(5) + ")";
      if (picking) {
        picking = false;
        $("pick-banner").hidden = true;
        $("form-dialog").showModal();
      }
    });
    if (accuracy) {
      accCircle = L.circle([lat, lng], { radius: accuracy, color: "#0f6b4f", weight: 1, fillOpacity: 0.12 }).addTo(map);
    }
    $("loc-status").textContent = msg + " (" + lat.toFixed(5) + ", " + lng.toFixed(5) + ")";
  }

  function clearPicked() {
    stopWatch();
    pickedLatLng = null;
    if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; }
    if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
    $("loc-status").textContent = "No location yet. Use GPS or pick on the map.";
  }

  // ---------- GPS ----------
  // Listens to the GPS for up to GPS_MAX_MS, averages the good readings (sharper readings
  // count more), and stops early once the best reading is within GPS_TARGET_M metres.
  var GPS_TARGET_M = 5;
  var GPS_MAX_MS = 10000;

  function stopWatch() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearTimeout(watchTimer);
  }

  function gpsQuality(m) {
    if (m <= 5) return "excellent";
    if (m <= 10) return "good";
    if (m <= 30) return "fair";
    return "poor, so tap GPS again, move outdoors, or adjust the pin on the map";
  }

  function locate() {
    if (!navigator.geolocation) {
      $("loc-status").textContent = "GPS is not supported on this device. Use Pick on map.";
      return;
    }
    stopWatch();
    var samples = [];
    var first = true;
    $("loc-status").textContent = "Getting GPS fix (about 10 seconds). Stay still, ideally outdoors.";

    // Position = weighted average of the good readings; accuracy shown = the best single
    // reading, which is the cautious figure.
    function estimate() {
      var bestAcc = Infinity;
      samples.forEach(function (s) { if (s.acc < bestAcc) bestAcc = s.acc; });
      var limit = Math.max(bestAcc * 2, bestAcc + 5);
      var sw = 0, la = 0, lo = 0;
      samples.forEach(function (s) {
        if (s.acc > limit) return;
        var w = 1 / (s.acc * s.acc);
        sw += w; la += w * s.lat; lo += w * s.lng;
      });
      return { lat: la / sw, lng: lo / sw, accuracy: Math.round(bestAcc) };
    }

    function finish() {
      stopWatch();
      if (!samples.length) {
        $("loc-status").textContent = "No GPS fix. Move outdoors or use Pick on map.";
        return;
      }
      var e = estimate();
      setPicked(e.lat, e.lng, "GPS fix ±" + e.accuracy + " m, " + gpsQuality(e.accuracy), e.accuracy);
      map.setView([e.lat, e.lng], 17);
    }

    watchId = navigator.geolocation.watchPosition(function (pos) {
      var c = pos.coords;
      if (!c.accuracy || c.accuracy <= 0) return;
      samples.push({ lat: c.latitude, lng: c.longitude, acc: c.accuracy });
      var e = estimate();
      setPicked(e.lat, e.lng, "Improving, now ±" + e.accuracy + " m", e.accuracy);
      if (first) { map.setView([e.lat, e.lng], 17); first = false; }
      if (e.accuracy <= GPS_TARGET_M && samples.length >= 3) finish();
    }, function (err) {
      stopWatch();
      if (samples.length) { finish(); return; }
      $("loc-status").textContent = "GPS failed: " + err.message + ". Use Pick on map.";
    }, { enableHighAccuracy: true, timeout: GPS_MAX_MS, maximumAge: 0 });

    watchTimer = setTimeout(finish, GPS_MAX_MS);
  }

  // ---------- photo (resized so storage stays small) ----------
  function readPhoto(file) {
    return new Promise(function (resolve) {
      if (!file) { resolve(null); return; }
      var reader = new FileReader();
      reader.onload = function () {
        var img = new Image();
        img.onload = function () {
          var max = 1024;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.round(img.width * scale);
          c.height = Math.round(img.height * scale);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/jpeg", 0.75));
        };
        img.onerror = function () { resolve(null); };
        img.src = reader.result;
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsDataURL(file);
    });
  }

  // ---------- list + detail ----------
  function renderList() {
    var ul = $("report-list");
    ul.innerHTML = "";
    $("count").textContent = reports.length;
    $("empty").hidden = reports.length > 0;
    reports.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); })
      .forEach(function (r) {
        var li = document.createElement("li");
        li.innerHTML =
          (r.photo ? '<img alt="" src="' + r.photo + '">' : "") +
          '<div class="meta"><div class="title">' + esc(r.category) +
          ' <span class="sev ' + esc(r.severity) + '">' + esc(r.severity) + "</span></div>" +
          '<div class="muted">' + esc(r.suburb || "No area given") + " · " + esc(fmtDate(r.createdAt)) + "</div></div>";
        li.addEventListener("click", function () { showDetail(r.id); });
        ul.appendChild(li);
      });
  }

  function showDetail(id) {
    var r = reports.find(function (x) { return x.id === id; });
    if (!r) return;
    openId = id;
    $("detail-body").innerHTML =
      "<h2>" + esc(r.category) + ' <span class="sev ' + esc(r.severity) + '">' + esc(r.severity) + "</span></h2>" +
      (r.photo ? '<img alt="Report photo" src="' + r.photo + '">' : "") +
      "<p>" + esc(r.description || "No description") + "</p>" +
      '<p class="muted">Area: ' + esc(r.suburb || "n/a") + "<br>" +
      "Location: " + r.lat.toFixed(5) + ", " + r.lng.toFixed(5) +
      (r.accuracy ? " (±" + r.accuracy + " m)" : "") + "<br>" +
      "Recorded: " + esc(fmtDate(r.createdAt)) + "</p>";
    $("detail-dialog").showModal();
  }

  async function refresh() {
    reports = await dbAll();
    renderMarkers();
    renderList();
  }

  // ---------- export ----------
  function download(name, mime, text) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function stamp() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }

  function exportGeoJSON() {
    if (!reports.length) { toast("Nothing to export yet"); return; }
    var fc = {
      type: "FeatureCollection",
      name: "mutare_reports",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
      features: reports.map(function (r) {
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [r.lng, r.lat] },
          properties: {
            id: r.id,
            category: r.category,
            severity: r.severity,
            suburb: r.suburb || "",
            description: r.description || "",
            gps_accuracy_m: r.accuracy || null,
            created_at: r.createdAt,
            has_photo: !!r.photo
          }
        };
      })
    };
    download("mutare-reports-" + stamp() + ".geojson", "application/geo+json", JSON.stringify(fc, null, 2));
    toast("GeoJSON exported");
  }

  function csvCell(v) {
    var s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCSV() {
    if (!reports.length) { toast("Nothing to export yet"); return; }
    var head = ["id", "category", "severity", "suburb", "description", "lat", "lng", "gps_accuracy_m", "created_at"];
    var rows = [head.join(",")];
    reports.forEach(function (r) {
      rows.push([r.id, r.category, r.severity, r.suburb, r.description, r.lat, r.lng, r.accuracy, r.createdAt]
        .map(csvCell).join(","));
    });
    download("mutare-reports-" + stamp() + ".csv", "text/csv", rows.join("\n"));
    toast("CSV exported");
  }

  // ---------- events ----------
  function bindUi() {
    document.querySelectorAll(".tabs button").forEach(function (b) {
      b.addEventListener("click", function () {
        document.querySelectorAll(".tabs button").forEach(function (x) { x.classList.remove("active"); });
        document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
        b.classList.add("active");
        $(b.dataset.view).classList.add("active");
        if (b.dataset.view === "view-map") setTimeout(function () { map.invalidateSize(); }, 50);
      });
    });

    $("btn-new").addEventListener("click", function () {
      picking = false;
      $("pick-banner").hidden = true;
      $("report-form").reset();
      photoDataUrl = null;
      $("photo-preview").hidden = true;
      $("form-error").hidden = true;
      if (!pickedLatLng) clearPicked();
      $("form-dialog").showModal();
      if (!pickedLatLng) locate();
    });

    $("btn-pick").addEventListener("click", function () {
      stopWatch();
      picking = true;
      $("form-dialog").close();
      $("pick-banner").hidden = false;
    });

    $("btn-pick-back").addEventListener("click", function () {
      picking = false;
      $("pick-banner").hidden = true;
      $("form-dialog").showModal();
    });

    $("btn-cancel").addEventListener("click", function () {
      $("form-dialog").close();
      clearPicked();
    });

    $("btn-locate").addEventListener("click", locate);

    $("photo").addEventListener("change", async function (e) {
      photoDataUrl = await readPhoto(e.target.files[0]);
      var prev = $("photo-preview");
      if (photoDataUrl) { prev.src = photoDataUrl; prev.hidden = false; } else { prev.hidden = true; }
    });

    $("report-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      if (!pickedLatLng) {
        showFormError("Add a location first: tap \"Use my GPS location\" or \"Pick on map instead\".");
        return;
      }
      var f = new FormData($("report-form"));
      var item = {
        id: uid(),
        category: f.get("category"),
        severity: f.get("severity"),
        suburb: (f.get("suburb") || "").trim(),
        description: (f.get("description") || "").trim(),
        lat: pickedLatLng.lat,
        lng: pickedLatLng.lng,
        accuracy: pickedLatLng.accuracy || null,
        photo: photoDataUrl,
        createdAt: new Date().toISOString()
      };
      try {
        await dbPut(item);
        $("form-dialog").close();
        clearPicked();
        await refresh();
        toast("Report saved on this phone");
      } catch (err) {
        showFormError("Could not save: " + err.message);
      }
    });

    $("btn-close").addEventListener("click", function () { $("detail-dialog").close(); });

    $("btn-delete").addEventListener("click", async function () {
      if (!openId) return;
      if (!confirm("Delete this report?")) return;
      await dbDelete(openId);
      $("detail-dialog").close();
      openId = null;
      await refresh();
      toast("Report deleted");
    });

    $("btn-geojson").addEventListener("click", exportGeoJSON);
    $("btn-csv").addEventListener("click", exportCSV);

    function net() {
      var el = $("netstatus");
      el.textContent = navigator.onLine ? "online" : "offline";
      el.classList.toggle("offline", !navigator.onLine);
    }
    window.addEventListener("online", net);
    window.addEventListener("offline", net);
    net();
  }

  // ---------- categories (from config.js) ----------
  var DEFAULT_CATEGORIES = ["Blocked drain", "Flooding", "Burst water pipe", "Sewer overflow",
    "Illegal dumping", "Road damage", "Street light fault", "Other"];

  function fillCategories() {
    var cfg = window.APP_CONFIG || {};
    var list = (cfg.CATEGORIES && cfg.CATEGORIES.length) ? cfg.CATEGORIES : DEFAULT_CATEGORIES;
    var sel = document.querySelector('#report-form select[name="category"]');
    sel.innerHTML = '<option value="">Select…</option>' +
      list.map(function (c) { return "<option>" + esc(c) + "</option>"; }).join("");
  }

  // ---------- start ----------
  async function start() {
    if (typeof L === "undefined") {
      document.body.insertAdjacentHTML("afterbegin",
        '<p style="padding:70px 16px">The map library could not load. Open the app once with internet so it can be saved for offline use.</p>');
      return;
    }
    db = await openDb();
    fillCategories();
    initMap();
    bindUi();
    await refresh();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  }

  start();
})();
