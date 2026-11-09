/* TV receiver for the original tv- pairing protocol. It never sends vehicle data back. */
(function () {
  'use strict';
  var random = new Uint8Array(6);
  var randomSource = window.crypto || window.msCrypto;
  if (!randomSource || !randomSource.getRandomValues) {
    document.getElementById('tv-badge').innerHTML = 'Браузер ТВ не поддерживает необходимую криптографию.';
    return;
  }
  randomSource.getRandomValues(random);
  var suffix = '';
  for (var i = 0; i < random.length; i++) suffix += ('0' + random[i].toString(16)).slice(-2);
  var identifier = 'tv-' + suffix;
  var badge = document.getElementById('tv-badge');
  var current = null;
  var pendingView = null;
  function showCode(message) {
    badge.innerHTML = (message ? message + '<br>' : '') + 'Код ТВ: <b id="peer-id-display">' + identifier + '</b>';
    badge.style.display = 'block';
    badge.style.opacity = '1';
  }
  function isNumber(value) { return typeof value === 'number' && isFinite(value); }
  function owns(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function validView(view) {
    return view && Array.isArray(view.center) && view.center.length === 2 &&
      view.center.every(isNumber) && Math.abs(view.center[0]) <= 90 && Math.abs(view.center[1]) <= 180 &&
      isNumber(view.zoom) && view.zoom >= 1 && view.zoom <= 21;
  }
  function applyView(view) {
    if (!validView(view)) return;
    pendingView = view;
    if (yMap) { yMap.setCenter(view.center, view.zoom); pendingView = null; }
  }
  window.onFleetTvMapReady = function () { if (pendingView) applyView(pendingView); };
  function normalizeState(input) {
    if (!input || typeof input !== 'object' || !input.cars || typeof input.cars !== 'object' || Array.isArray(input.cars)) throw new Error('Invalid data');
    var ids = Object.keys(input.cars);
    if (ids.length > 5000) throw new Error('Too many records');
    var cars = Object.create(null);
    ids.forEach(function (id) {
      var original = input.cars[id];
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].indexOf(id) !== -1) throw new Error('Invalid id');
      if (!original || typeof original !== 'object' || !Array.isArray(original.coords) || original.coords.length !== 2 ||
          !original.coords.every(isNumber) || Math.abs(original.coords[0]) > 90 || Math.abs(original.coords[1]) > 180) throw new Error('Invalid coordinates');
      var car = JSON.parse(JSON.stringify(original)); car.id = id;
      cars[id] = sanitizeCarData(car);
    });
    return { updatedAt: isNumber(input.updatedAt) ? input.updatedAt : 1,
      tvScreenMode: input.tvScreenMode === 'dashboard' ? 'dashboard' : 'map', cars: cars };
  }
  showCode('Соединение с сервисом связи…');
  if (typeof Peer !== 'function') { showCode('Не загрузилась библиотека связи. Обновите страницу.'); return; }
  var receiver = new Peer(identifier);
  receiver.on('open', function () { showCode(''); });
  receiver.on('error', function () { showCode('Ошибка связи. Обновите страницу.'); });
  receiver.on('disconnected', function () { showCode('Связь прервана. Обновите страницу.'); });
  receiver.on('connection', function (connection) {
    if (current && current.open) { connection.close(); return; }
    current = connection;
    connection.on('open', function () { showCode('Подключено к диспетчеру'); });
    connection.on('data', function (message) {
      if (!message || typeof message !== 'object') return;
      try {
        if (message.type === 'HANDSHAKE' || message.type === 'DATA_UPDATE') {
          var next = normalizeState(message.data);
          appData = next;
          selectedCarId = typeof message.selectedCarId === 'string' && owns(next.cars, message.selectedCarId) ? message.selectedCarId : null;
          renderAll(); applyLocalScreenMode(next.tvScreenMode);
          if (message.mapView) applyView(message.mapView);
        } else if (message.type === 'FORCE_SCREEN_MODE') {
          var mode = message.mode === 'dashboard' ? 'dashboard' : 'map';
          appData.tvScreenMode = mode; applyLocalScreenMode(mode);
        } else if (message.type === 'MAP_VIEW') applyView(message);
        else if (message.type === 'SELECT_CAR') {
          selectedCarId = typeof message.selectedCarId === 'string' && owns(appData.cars, message.selectedCarId) ? message.selectedCarId : null;
          renderAll();
        }
      } catch (error) { showCode('Не удалось отобразить полученные данные.'); }
    });
    connection.on('close', function () {
      if (current === connection) { current = null; showCode('Связь с диспетчером прервана'); }
    });
    connection.on('error', function () { showCode('Ошибка связи с диспетчером'); });
  });
  // Map loading cannot block the visible pairing code or the dashboard.
  if (typeof initYandexMap === 'function') {
    var mapScript = document.createElement('script');
    mapScript.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU';
    mapScript.async = true;
    mapScript.onload = function () {
      if (window.ymaps) window.ymaps.ready(function () { if (!yMap) initYandexMap(); });
      else showCode('Карта недоступна. Связка по коду доступна.');
    };
    mapScript.onerror = function () { showCode('Карта не загрузилась. Связка по коду доступна.'); };
    document.head.appendChild(mapScript);
  }
})();
