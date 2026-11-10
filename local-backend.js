/* On-device storage for the gym app.
   The original page saved everything through Claude's hosted database and photo store.
   This file provides the same small API (db.doc / db.collection / onSnapshot, assets.upload / delete)
   backed by IndexedDB on the phone, so the page code above it needs no changes.
   The AI features (coach review, "Read it with Claude", swap ideas) are not available here:
   use("sample") rejects, and the page already hides those buttons when it is missing. */
(function () {
  "use strict";
  var DB_NAME = "gym-plan-data", DOCS = "docs", BLOBS = "blobs";
  var docs = new Map();          // path -> plain object
  var listeners = [];            // {kind:"doc"|"col", key, cb}
  var urls = new Map();          // photo id -> object URL
  var idb = null;

  var clone = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); };
  var tick = function (fn) { Promise.resolve().then(fn); };

  function openIdb() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains(DOCS)) d.createObjectStore(DOCS);
          if (!d.objectStoreNames.contains(BLOBS)) d.createObjectStore(BLOBS);
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!idb) return resolve(undefined);
      try {
        var t = idb.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { resolve(out && out.result); };
        t.onerror = t.onabort = function () { reject(t.error || new Error("storage error")); };
      } catch (e) { reject(e); }
    });
  }
  function readAll(store) {
    return new Promise(function (resolve) {
      if (!idb) return resolve([]);
      var rows = [];
      try {
        var c = idb.transaction(store, "readonly").objectStore(store).openCursor();
        c.onsuccess = function () {
          var cur = c.result;
          if (cur) { rows.push([cur.key, cur.value]); cur.continue(); } else resolve(rows);
        };
        c.onerror = function () { resolve(rows); };
      } catch (e) { resolve(rows); }
    });
  }

  var colOf = function (path) { return path.split("/")[0]; };
  var idOf = function (path) { return path.slice(path.indexOf("/") + 1); };

  function docSnap(path) {
    var has = docs.has(path), v = has ? docs.get(path) : null;
    return { exists: has, id: idOf(path), data: function () { return has ? clone(v) : undefined; } };
  }
  function colSnap(name) {
    var rows = [];
    docs.forEach(function (v, p) { if (colOf(p) === name) rows.push([idOf(p), v]); });
    rows.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var list = rows.map(function (r) { return { id: r[0], exists: true, data: function () { return clone(r[1]); } }; });
    return { docs: list, size: list.length, empty: !list.length, forEach: function (f) { list.forEach(f); } };
  }
  function fire(path) {
    listeners.slice().forEach(function (l) {
      try {
        if (l.kind === "doc" && l.key === path) l.cb(docSnap(path));
        else if (l.kind === "col" && l.key === colOf(path)) l.cb(colSnap(l.key));
      } catch (e) { console.error(e); }
    });
  }
  function listen(kind, key, snap, cb, errCb) {
    var l = { kind: kind, key: key, cb: cb };
    listeners.push(l);
    tick(function () { try { cb(snap()); } catch (e) { if (errCb) errCb(e); else console.error(e); } });
    return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
  }

  var db = {
    doc: function (path) {
      return {
        set: function (data) {
          docs.set(path, clone(data));
          fire(path);
          return tx(DOCS, "readwrite", function (s) { return s.put(clone(data), path); });
        },
        delete: function () {
          docs.delete(path);
          fire(path);
          return tx(DOCS, "readwrite", function (s) { return s.delete(path); });
        },
        get: function () { return Promise.resolve(docSnap(path)); },
        onSnapshot: function (cb, errCb) { return listen("doc", path, function () { return docSnap(path); }, cb, errCb); }
      };
    },
    collection: function (name) {
      return {
        get: function () { return Promise.resolve(colSnap(name)); },
        onSnapshot: function (cb, errCb) { return listen("col", name, function () { return colSnap(name); }, cb, errCb); }
      };
    }
  };

  var assets = {
    upload: function (file) {
      var id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      urls.set(id, URL.createObjectURL(file));
      return tx(BLOBS, "readwrite", function (s) { return s.put(file, id); }).then(function () { return { id: id }; });
    },
    delete: function (id) {
      var u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); }
      return tx(BLOBS, "readwrite", function (s) { return s.delete(id); });
    }
  };
  window.__blobUrl = function (id) { return urls.get(id) || ""; };

  var ready = openIdb().then(function (d) {
    idb = d;
    return Promise.all([readAll(DOCS), readAll(BLOBS)]);
  }).then(function (r) {
    r[0].forEach(function (row) { docs.set(row[0], row[1]); });
    r[1].forEach(function (row) { urls.set(row[0], URL.createObjectURL(row[1])); });
    // Ask the OS to keep this data rather than clear it when storage is low.
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  });


  /* Backup and restore (used by the Backup button on the Progress tab). */
  function blobToDataUrl(b) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b); }); }
  function dataUrlToBlob(u) {
    var i = u.indexOf(","), head = u.slice(5, i).split(";"), bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
    return new Blob([a], { type: head[0] || "application/octet-stream" });
  }
  window.__exportAll = function () {
    return ready.then(function () { return readAll(BLOBS); }).then(function (rows) {
      return Promise.all(rows.map(function (r) { return blobToDataUrl(r[1]).then(function (u) { return [r[0], u]; }); }));
    }).then(function (blobs) {
      return { app: "gym-plan", version: 1, exported: new Date().toISOString(), docs: Array.from(docs.entries()), blobs: blobs };
    });
  };
  window.__importAll = function (data) {
    return ready.then(function () {
      if (!idb) throw new Error("Storage isn't available in this browser mode.");
      return new Promise(function (resolve, reject) {
        var t = idb.transaction([DOCS, BLOBS], "readwrite"), d = t.objectStore(DOCS), b = t.objectStore(BLOBS);
        d.clear(); b.clear();
        data.docs.forEach(function (r) { d.put(r[1], r[0]); });
        (data.blobs || []).forEach(function (r) { b.put(dataUrlToBlob(r[1]), r[0]); });
        t.oncomplete = function () { resolve(); };
        t.onerror = t.onabort = function () { reject(t.error || new Error("restore failed")); };
      });
    });
  };

  window.claude = {
    use: function (name) {
      if (name === "db") return ready.then(function () { return db; });
      if (name === "assets") return ready.then(function () { return assets; });
      return Promise.reject(Object.assign(new Error("Not available in the app"), { code: "unavailable" }));
    }
  };
})();
