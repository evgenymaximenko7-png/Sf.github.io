/* Original tv- protocol; the TV only sends acknowledgements back. */
(function () {
  'use strict';
  var badge = document.getElementById('tv-badge');
  var identifier = '', receiver = null, ready = false, current = null, pendingView = null;
  var screenMode = 'map', hasData = false, connectionTimer = null, hideTimer = null, retryTimer = null;
  var retries = 0, stopped = false;
  function newCode() {
    var random = new Uint32Array(1), cryptoSource = window.crypto || window.msCrypto;
    if (cryptoSource && cryptoSource.getRandomValues) cryptoSource.getRandomValues(random);
    else random[0] = Math.floor(Math.random() * 4294967296);
    return 'tv-' + (100000 + random[0] % 900000);
  }
  function showCode(message) {
    clearTimeout(hideTimer);
    badge.innerHTML = (message ? message + (ready ? '<br>' : '') : '') +
      (ready ? 'Код ТВ: <b id="peer-id-display">' + identifier + '</b>' : '');
    badge.style.display = 'block'; badge.style.opacity = '1';
  }
  function showConnected() {
    showCode('Связка активна ✓');
    hideTimer = setTimeout(function () { badge.style.display = 'none'; }, 4000);
  }
  function setScreen(mode) {
    screenMode = mode === 'dashboard' ? 'dashboard' : 'map';
    appData.tvScreenMode = screenMode;
    document.getElementById('panel').style.display = 'flex';
    applyLocalScreenMode(screenMode); updateTvModeButtonUI();
  }
  document.getElementById('panel').style.display = 'flex';
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
  window.onFleetTvMapReady = function () {
    if (pendingView) applyView(pendingView);
    document.getElementById('panel').style.display = 'flex';
  };
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
      var car = JSON.parse(JSON.stringify(original)); car.id = id; cars[id] = sanitizeCarData(car);
    });
    return { updatedAt: isNumber(input.updatedAt) ? input.updatedAt : 1, tvScreenMode: screenMode, cars: cars };
  }
  function scheduleReconnect(owner) {
    if (retryTimer || stopped || owner !== receiver || retries >= 5) return;
    retries++;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (stopped || owner !== receiver) return;
      if (!owner.destroyed && owner.disconnected) owner.reconnect();
      else if (owner.destroyed) startPeer();
    }, Math.min(retries * 1500, 6000));
  }
  function startPeer() {
    ready = false; identifier = newCode();
    var old = receiver;
    receiver = new Peer(identifier, { secure: true });
    var owner = receiver;
    if (old && !old.destroyed) old.destroy();
    showCode('Соединение с сервисом связи…');
    owner.on('open', function () { if (owner !== receiver) return; ready = true; retries = 0; showCode(''); });
    owner.on('error', function (error) {
      if (owner !== receiver || stopped) return;
      ready = !!owner.open && !owner.destroyed && !owner.disconnected;
      if (error && error.type === 'unavailable-id' && retries < 5) {
        retries++; retryTimer = setTimeout(function () { retryTimer = null; startPeer(); }, 200);
      } else {
        if (!current || !current.open) showCode(error && error.type === 'browser-incompatible' ?
          'Браузер ТВ не поддерживает связь. Откройте страницу в другом браузере.' : 'Сервис связи недоступен. Проверьте интернет.');
        if (error && ['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(error.type) !== -1) scheduleReconnect(owner);
      }
    });
    owner.on('disconnected', function () {
      if (owner !== receiver) return;
      ready = false;
      if (!current || !current.open) showCode('Восстанавливаем связь с сервисом…');
      scheduleReconnect(owner);
    });
    owner.on('connection', function (connection) {
      if (owner !== receiver || (current && current.open)) { connection.close(); return; }
      var previous = current;
      current = connection; hasData = false;
      if (previous) previous.close();
      clearTimeout(connectionTimer);
      connectionTimer = setTimeout(function () {
        if (current === connection && !hasData) { current = null; connection.close(); showCode('Данные не получены. Повторите связку на компьютере.'); }
      }, 20000);
      connection.on('open', function () { if (current === connection) showCode('Получаем данные диспетчера…'); });
      connection.on('data', function (message) {
        if (current !== connection || !message || typeof message !== 'object') return;
        try {
          if (message.type === 'HANDSHAKE' || message.type === 'DATA_UPDATE') {
            var next = normalizeState(message.data), first = !hasData;
            appData = next;
            selectedCarId = typeof message.selectedCarId === 'string' && owns(next.cars, message.selectedCarId) ? message.selectedCarId : null;
            renderAll(); setScreen(first ? 'dashboard' : screenMode);
            if (message.mapView) applyView(message.mapView);
            hasData = true; clearTimeout(connectionTimer);
            connection.send({ type: 'TV_READY', mode: screenMode });
            if (first) showConnected();
          } else if (message.type === 'FORCE_SCREEN_MODE') setScreen(message.mode);
          else if (message.type === 'MAP_VIEW') applyView(message);
          else if (message.type === 'SELECT_CAR') {
            selectedCarId = typeof message.selectedCarId === 'string' && owns(appData.cars, message.selectedCarId) ? message.selectedCarId : null; renderAll();
          }
        } catch (error) { showCode('Не удалось отобразить полученные данные. Повторите связку.'); }
      });
      connection.on('close', function () {
        if (current === connection) { current = null; clearTimeout(connectionTimer); showCode('Связь с диспетчером прервана'); }
      });
      connection.on('error', function () {
        if (current !== connection) return;
        current = null; clearTimeout(connectionTimer); connection.close(); showCode('Ошибка связи с диспетчером. Повторите связку.');
      });
    });
  }
  showCode('Соединение с сервисом связи…');
  if (typeof Peer !== 'function') { showCode('Не загрузилась библиотека связи. Обновите страницу.'); return; }
  startPeer();
  window.addEventListener('beforeunload', function () {
    stopped = true; clearTimeout(retryTimer); clearTimeout(connectionTimer); clearTimeout(hideTimer);
    if (receiver && !receiver.destroyed) receiver.destroy();
  });
  // Map loading cannot block the pairing code, sidebar or dashboard.
  if (typeof initYandexMap === 'function') {
    var mapScript = document.createElement('script');
    mapScript.src = 'https://api-maps.yandex.ru/2.1/?lang=ru_RU'; mapScript.async = true;
    mapScript.onload = function () {
      if (window.ymaps) window.ymaps.ready(function () { if (!yMap) initYandexMap(); });
      else if (!hasData) showCode('Карта недоступна. Связка по коду доступна.');
    };
    mapScript.onerror = function () { if (!hasData) showCode('Карта не загрузилась. Связка по коду доступна.'); };
    document.head.appendChild(mapScript);
  }
})();
