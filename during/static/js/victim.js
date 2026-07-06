'use strict';

// ── State ─────────────────────────────────────────────────────
let userLocation = null, locationWatchId = null;
let currentSOSId = null, statusCheckInterval = null;
let lastKnownState = {status:'', hospital:'', reason:''};
let locationSendTimer = null;
let syncPollInterval = null;
let etaTimer = null; // Fix for reference error in updateStatusUI

// ── Map state ─────────────────────────────────────────────────
let victimMap = null, mapInitialized = false;
let victimMarker = null, hospitalMarker = null, ambulanceMarker = null;
let routePolyline = null;
let routeDrawn = false;
let routePolylineHash = 0;
let activeBlockKeys = new Set();
let blockLayers = [];

// ── Tag pills toggle ──────────────────────────────────────────
document.querySelectorAll('.tag-pill').forEach(pill => {
  pill.addEventListener('change', () => {
    pill.classList.toggle('selected', pill.querySelector('input').checked);
  });
});

// ── Nav risk badge ────────────────────────────────────────────
async function loadNavRisk() {
  try {
    const d = await fetch('/api/predict').then(r => r.json());
    const dot = document.getElementById('navDot');
    const txt = document.getElementById('navRiskText');
    if (dot && txt) { dot.style.background = d.color; txt.textContent = d.risk_level; txt.style.color = d.color; }
    showRiskWarning(d.risk_level);
  } catch(e) {}
}

function showRiskWarning(level) {
  const w = document.getElementById('riskWarn');
  if (!w) return;
  if (level === 'CRITICAL') {
    w.className = 'risk-warn critical';
    w.innerHTML = '🚨 <b>CRITICAL FLOOD ALERT ACTIVE</b> — Rescue teams on high alert. Submit SOS immediately if in danger.';
    w.style.display = 'block';
  } else if (level === 'HIGH RISK') {
    w.className = 'risk-warn high';
    w.innerHTML = '⚠️ <b>HIGH RISK CONDITIONS</b> — Heavy rainfall predicted. Stay alert and prepare to evacuate.';
    w.style.display = 'block';
  } else {
    w.style.display = 'none';
  }
}

// ── Location tracking ─────────────────────────────────────────
function startLocationTracking() {
  if (!navigator.geolocation) { setLocBar('❌ Geolocation not supported', false); return; }
  locationWatchId = navigator.geolocation.watchPosition(
    pos => {
      userLocation = {latitude: pos.coords.latitude, longitude: pos.coords.longitude};
      const bar = document.getElementById('locationStatus');
      if (bar) {
        bar.innerHTML = `<span style="color:#22c55e;font-size:1rem">✓</span> Live GPS: ${userLocation.latitude.toFixed(5)}, ${userLocation.longitude.toFixed(5)}`;
        bar.classList.add('active');
      }
      // Update victim pin on map if active
      if (victimMarker && mapInitialized) {
        victimMarker.setLatLng([userLocation.latitude, userLocation.longitude]);
      }
      if (currentSOSId) debouncedLocationSend();
    },
    err => { setLocBar('⚠️ Enable GPS for emergency services', false); },
    {enableHighAccuracy: true, maximumAge: 0, timeout: 8000}
  );
}

function setLocBar(msg, active) {
  const bar = document.getElementById('locationStatus');
  if (!bar) return;
  bar.innerHTML = msg;
  if (active) bar.classList.add('active'); else bar.classList.remove('active');
}

function debouncedLocationSend() {
  if (locationSendTimer) return;
  locationSendTimer = setTimeout(() => {
    sendLocationToServer();
    locationSendTimer = null;
  }, 10000);
}

function sendLocationToServer() {
  if (!userLocation || !currentSOSId) return;
  fetch('/api/user/location', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(userLocation)
  }).catch(() => {});
}

// ── LIVE MAP ──────────────────────────────────────────────────
function initVictimMap(victimLat, victimLng) {
  if (mapInitialized) return;
  mapInitialized = true;

  victimMap = L.map('victimMap', {
    zoomControl: true,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true
  }).setView([victimLat, victimLng], 14);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(victimMap);

  // Victim marker — pulsing red pin
  victimMarker = L.marker([victimLat, victimLng], {
    icon: L.divIcon({
      html: `<div style="position:relative">
        <div style="width:18px;height:18px;background:#ef4444;border-radius:50%;
          border:3px solid white;box-shadow:0 0 0 4px rgba(239,68,68,0.3);
          animation:vpin-pulse 2s infinite"></div>
        <div style="position:absolute;top:-22px;left:50%;transform:translateX(-50%);
          background:#ef4444;color:white;font-size:0.6rem;font-weight:700;
          padding:2px 6px;border-radius:10px;white-space:nowrap">YOU</div>
      </div>
      <style>@keyframes vpin-pulse{0%,100%{box-shadow:0 0 0 4px rgba(239,68,68,0.3)}
        50%{box-shadow:0 0 0 10px rgba(239,68,68,0.1)}}</style>`,
      className: '', iconSize: [24, 24], iconAnchor: [9, 9]
    })
  }).addTo(victimMap).bindPopup('<b>📍 Your Location</b>');
}

function showHospitalOnMap(hospLat, hospLng, hospName) {
  if (!mapInitialized || !victimMap) return;
  if (hospitalMarker) victimMap.removeLayer(hospitalMarker);
  hospitalMarker = L.marker([hospLat, hospLng], {
    icon: L.divIcon({
      html: `<div style="background:white;border-radius:50%;width:30px;height:30px;
        display:flex;align-items:center;justify-content:center;font-size:15px;
        border:2px solid #22c55e;box-shadow:0 2px 8px rgba(0,0,0,0.3)">🏥</div>`,
      className: '', iconSize: [30, 30], iconAnchor: [15, 15]
    })
  }).addTo(victimMap).bindPopup(`<b>🏥 ${hospName}</b><br>Your ambulance is coming from here`).openPopup();
}

// No independent OSRM call — position comes from server so both maps stay in sync

function startSyncPolling(sosId) {
  if (syncPollInterval) clearInterval(syncPollInterval);
  syncPollInterval = setInterval(() => {
    pollAmbulancePosition(sosId);
    loadRoadBlocks();
  }, 2000);
  pollAmbulancePosition(sosId); // immediate first call
  loadRoadBlocks();
}

async function pollAmbulancePosition(sosId) {
  try {
    const d = await fetch(`/api/sos/${sosId}/ambulance-position`).then(r => r.json());

    if (!d.ready) {
      // Not dispatched yet — just make sure hospital shows
      if (d.hospital_lat && !routeDrawn) {
        showHospitalOnMap(d.hospital_lat, d.hospital_lon, d.hospital_name);
        document.getElementById('vmapSub').textContent = 'Awaiting dispatch...';
      }
      return;
    }

    // First time we get route coords — draw the route line
    const currentRouteHash = d.route_coords ? JSON.stringify(d.route_coords) : '';
    const isReroute = routeDrawn && routePolylineHash && routePolylineHash !== currentRouteHash;
    if ((!routeDrawn || routePolylineHash !== currentRouteHash) && d.route_coords && d.route_coords.length) {
      routeDrawn = true;
      routePolylineHash = currentRouteHash;

      // Remove old route polyline
      if (routePolyline) victimMap.removeLayer(routePolyline);

      // If this is a reroute (not first draw), show yellow detour line briefly then green
      const routeColor = isReroute ? '#f59e0b' : '#22c55e';
      routePolyline = L.polyline(d.route_coords, {color: routeColor, weight:5, opacity:0.85})
        .addTo(victimMap);

      // After 2s switch to green so victim knows route is confirmed
      if (isReroute) {
        setTimeout(() => {
          if (routePolyline) routePolyline.setStyle({color:'#22c55e'});
        }, 2000);

        // Remove old ambulance marker so it re-appears at correct new position
        if (ambulanceMarker) { victimMap.removeLayer(ambulanceMarker); ambulanceMarker = null; }

        // Notify victim of reroute
        showBlockAlert('🚧 Road block detected — your ambulance has been rerouted to a clear path.');
      }

      // Extend bounds to include the victim's current live position
      const bounds = routePolyline.getBounds();
      if (victimMarker) bounds.extend(victimMarker.getLatLng());
      victimMap.fitBounds(bounds, {padding:[40,40]});

      // Show ETA bar
      const etaBar = document.getElementById('etaBar');
      if (etaBar) etaBar.style.display = 'flex';
    }

    // Move ambulance to server-computed position
    if (!ambulanceMarker) {
      ambulanceMarker = L.marker([d.amb_lat, d.amb_lng], {
        icon: L.divIcon({
          html: `<div style="background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:white;
            border-radius:50%;width:32px;height:32px;display:flex;align-items:center;
            justify-content:center;font-size:15px;border:3px solid white;
            box-shadow:0 0 0 4px rgba(59,130,246,0.3);animation:ambpulse 1s infinite">🚑</div>
            <style>@keyframes ambpulse{0%,100%{box-shadow:0 0 0 4px rgba(59,130,246,0.3)}
              50%{box-shadow:0 0 0 10px rgba(59,130,246,0.1)}}</style>`,
          className:'', iconSize:[32,32], iconAnchor:[16,16]
        })
      }).addTo(victimMap).bindPopup('<b>🚑 Ambulance</b><br>En route to you');
    } else {
      ambulanceMarker.setLatLng([d.amb_lat, d.amb_lng]);
    }

    // Update ETA display
    updateEtaDisplay(d.eta_seconds);
    const pct = Math.round(d.progress * 100);
    const bar = document.getElementById('etaProgress');
    if (bar) bar.style.width = pct + '%';
    const sub = document.getElementById('vmapSub');
    if (sub) sub.textContent = `${d.hospital_name} · ${Math.ceil(d.eta_seconds/60)} min ETA`;

    // NOTE: "Arrived" state is ONLY triggered by admin clicking Rescued,
    // detected via statusCheckInterval → updateStatusUI(). 
    // Animation completes visually but does NOT show the rescue card here.
    // We just park the ambulance at the last known position when progress ≥ 1.
    if (d.progress >= 1.0) {
      stopAmbulanceAnim();
      // Keep ambulance marker at destination — no "arrived" card yet
      // That fires only when admin marks Rescued
    }

  } catch(e) {}
}

function showBlockAlert(msg) {
  const existing = document.getElementById('victimBlockAlert');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'victimBlockAlert';
  el.style.cssText = `
    position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:9999;
    background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.5);
    border-radius:10px;padding:10px 18px;color:#fde68a;font-size:0.82rem;
    font-weight:600;max-width:340px;text-align:center;
    box-shadow:0 4px 20px rgba(0,0,0,0.5);backdrop-filter:blur(12px);
    animation:slideDown 0.3s ease;
  `;
  el.innerHTML = msg;
  const style = document.createElement('style');
  style.textContent = '@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
  document.head.appendChild(style);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function updateEtaDisplay(seconds) {
  const el = document.getElementById('etaNum');
  if (!el) return;
  if (seconds <= 0) { el.textContent = 'Arrived!'; return; }
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  el.textContent = m > 0 ? `~${m} min` : `${s}s`;
}

function stopAmbulanceAnim() {
  if (syncPollInterval) { clearInterval(syncPollInterval); syncPollInterval = null; }
}

function showVictimMap() {
  const wrap = document.getElementById('victimMapWrap');
  if (wrap) wrap.style.display = 'block';
  // Force Leaflet to recalculate size after display:block
  setTimeout(() => { if (victimMap) victimMap.invalidateSize(); }, 100);
}

async function loadRoadBlocks() {
  try {
    const data = await fetch('/api/admin/roadblocks').then(r => r.json());
    const serverBlocks = data.road_blocks || [];

    // Build set of keys currently on server
    const serverKeys = new Set(serverBlocks.map(rb => `${rb.lat.toFixed(6)},${rb.lng.toFixed(6)}`));

    // If admin cleared all blocks — remove every block marker from victim map
    if (serverBlocks.length === 0 && activeBlockKeys.size > 0) {
      blockLayers.forEach(l => { if (victimMap) victimMap.removeLayer(l); });
      blockLayers = [];
      activeBlockKeys.clear();
    }

    // Add any new blocks not yet on victim map
    serverBlocks.forEach(rb => {
      const key = `${rb.lat.toFixed(6)},${rb.lng.toFixed(6)}`;
      if (!activeBlockKeys.has(key)) {
        addBlockToMap(rb.lat, rb.lng, rb.reason, rb.image);
        activeBlockKeys.add(key);
      }
    });

    // Remove individual blocks that were removed from server
    if (serverBlocks.length > 0 && activeBlockKeys.size > serverKeys.size) {
      activeBlockKeys.forEach(key => {
        if (!serverKeys.has(key)) activeBlockKeys.delete(key);
      });
    }
  } catch(e) { console.error('Failed to load roadblocks:', e); }
}

function addBlockToMap(lat, lng, reason, image) {
  if (!mapInitialized || !victimMap) return;
  const content = `
    <div style="font-family:'DM Sans',sans-serif;width:150px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:16px">🚧</span>
        <b style="color:#ef4444;font-size:0.8rem;line-height:1.2">${reason || 'Obstacle Detected'}</b>
      </div>
      ${image ? `<img src="/static/images/${image}" style="width:100%;border-radius:6px;border:1px solid #334155;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:block" alt="${reason}">` : 
                '<div style="background:#1e293b;padding:8px;border-radius:6px;color:#94a3b8;font-size:0.7rem;text-align:center">No visual data.</div>'}
    </div>
  `;

  const m = L.marker([lat, lng], {icon: L.divIcon({
    html: '<div style="font-size:26px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));cursor:pointer">🚧</div>',
    className:'', iconSize:[32,32], iconAnchor:[16,16]
  })}).addTo(victimMap).bindPopup(content, {maxWidth: 220});
  
  const c = L.circle([lat, lng], {radius:250, color:'#ef4444', weight:2, fillColor:'#ef4444', fillOpacity:0.2}).addTo(victimMap);
  
  blockLayers.push(m, c);
}

// ── Status polling ────────────────────────────────────────────
function startStatusTracking(sosId) {
  currentSOSId = sosId;
  lastKnownState = {status:'', hospital:'', reason:''};
  if (statusCheckInterval) clearInterval(statusCheckInterval);
  statusCheckInterval = setInterval(async () => { // polls every 2s for real-time sync
    try {
      const d = await fetch('/api/victim/my-sos').then(r => r.json());
      if (d.found && d.sos && d.sos.id >= currentSOSId) updateStatusUI(d.sos);
    } catch(e) {}
  }, 2000);  // 2s polling matches ambulance position sync
}

function stopStatusTracking() {
  if (statusCheckInterval) { clearInterval(statusCheckInterval); statusCheckInterval = null; }
}

function updateStatusUI(sos) {
  const cur = {
    status: sos.status,
    hospital: sos.hospital_name || '',
    reason: sos.reassigned_reason || '',
    image: sos.block_image || '',
    hospLat: sos.hospital_lat || '',
    hospLon: sos.hospital_lon || ''
  };
  if (JSON.stringify(cur) === JSON.stringify(lastKnownState)) return;

  const hospitalChanged = lastKnownState.hospital && lastKnownState.hospital !== (sos.hospital_name || '');
  const statusChanged   = lastKnownState.status !== sos.status;
  lastKnownState = cur;

  const pri = sos.priority_level || sos.priority;

  if (sos.status === 'Rescued') {
    stopAmbulanceAnim();
    if (etaTimer) { clearInterval(etaTimer); etaTimer = null; }

    // Show arrived marker on map
    if (mapInitialized && victimMap) {
      if (ambulanceMarker) victimMap.removeLayer(ambulanceMarker);
      const arrLat = sos.latitude, arrLng = sos.longitude;
      ambulanceMarker = L.marker([arrLat, arrLng], {
        icon: L.divIcon({
          html: `<div style="background:#22c55e;color:white;border-radius:50%;width:40px;height:40px;
            display:flex;align-items:center;justify-content:center;font-size:20px;
            border:3px solid white;box-shadow:0 4px 20px rgba(34,197,94,0.6)">✅</div>`,
          className:'', iconSize:[40,40], iconAnchor:[20,20]
        })
      }).addTo(victimMap).bindPopup('<b>✅ Rescue Team Arrived!</b>').openPopup();
    }

    showResult(`
      <div class="result-card rescued" style="border-color:rgba(34,197,94,0.4);background:rgba(34,197,94,0.04)">
        <div class="rc-header">
          <div class="rc-icon green" style="background:rgba(34,197,94,0.2);border:1px solid rgba(34,197,94,0.4);font-size:1.6rem;width:52px;height:52px">✅</div>
          <div>
            <div class="rc-title" style="color:#86efac;font-size:1.1rem">Rescue Team Has Arrived</div>
            <div class="rc-sub">SOS #${sos.id} · You are now safe</div>
          </div>
        </div>
        <div class="rc-rows" style="margin-bottom:14px">
          <div class="rc-row"><span class="rc-key">Hospital</span><span class="rc-val">${sos.hospital_name || 'N/A'}</span></div>
          ${sos.reassigned_reason ? `<div class="rc-row"><span class="rc-key">Route Note</span><span class="rc-val" style="color:#93c5fd;font-size:0.78rem">${sos.reassigned_reason}</span></div>` : ''}
        </div>

        <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:10px;padding:14px;margin-bottom:14px">
          <div style="font-size:0.72rem;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#86efac;margin-bottom:10px">⛑️ Safety Instructions</div>
          <div style="display:flex;flex-direction:column;gap:7px">
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">1.</span>
              <span>Stay calm and <b>do not move</b> until the rescue team gives you the all-clear.</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">2.</span>
              <span>Follow all instructions from the rescue team. They know the safe exit route.</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">3.</span>
              <span>Carry only essentials — <b>medicines, ID documents, phone</b>. Leave behind heavy luggage.</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">4.</span>
              <span>Do <b>not</b> walk through flooded roads or waterlogged areas even if they appear shallow.</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">5.</span>
              <span>You will be taken to <b>${sos.hospital_name || 'the nearest hospital'}</b> for medical assessment.</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">6.</span>
              <span>Inform the rescue team of any injuries, medical conditions, or other trapped persons nearby.</span>
            </div>
            <div style="display:flex;gap:8px;align-items:flex-start;font-size:0.8rem;color:#e2e8f0">
              <span style="color:#86efac;font-weight:700;flex-shrink:0">7.</span>
              <span>Turn off <b>gas and electricity</b> at the main switch before leaving your premises if safe to do so.</span>
            </div>
          </div>
        </div>

        <div style="background:rgba(59,130,246,0.08);border:1px solid rgba(59,130,246,0.2);border-radius:8px;padding:10px 14px;font-size:0.76rem;color:#93c5fd;text-align:center">
          📞 Tamil Nadu Disaster Helpline: <b style="color:#bfdbfe">1916</b> &nbsp;|&nbsp; Emergency: <b style="color:#bfdbfe">112</b>
        </div>
      </div>`);

    stopStatusTracking();
    // Update map sub-text
    const mapSubEl = document.getElementById('vmapSub');
    if (mapSubEl) mapSubEl.textContent = '✅ Rescue team has arrived — you are safe';
    const etaBarEl = document.getElementById('etaBar');
    if (etaBarEl) etaBarEl.style.display = 'none';
    const etaNumEl = document.getElementById('etaNum');
    if (etaNumEl) etaNumEl.textContent = 'Arrived!';

  } else if (sos.status === 'Assigned') {
    // If we just got assigned (status transition), immediately start ambulance tracking
    if (statusChanged && !syncPollInterval) {
      startSyncPolling(sos.id);
    }
    const isSwitched = hospitalChanged || sos.reassigned_reason;
    showResult(`
      <div class="result-card ${isSwitched ? 'switched' : 'assigned'}">
        <div class="rc-header">
          <div class="rc-icon ${isSwitched ? 'orange' : 'green'}">${isSwitched ? '⚠️' : '🚑'}</div>
          <div>
            <div class="rc-title">${isSwitched ? 'Dispatch Updated' : 'Ambulance En Route'}</div>
            <div class="rc-sub">SOS #${sos.id} · ${isSwitched ? 'Route changed — road block detected' : (sos.reassigned_reason ? 'AI Rerouting optimized' : 'Help is on the way')}</div>
          </div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Hospital</span><span class="rc-val">${sos.hospital_name || 'Locating...'}</span></div>
          <div class="rc-row"><span class="rc-key">Priority</span>
            <span class="rc-val"><span class="priority-badge p-${pri}">${pri}</span></span>
          </div>
          ${sos.medical_condition ? `<div class="rc-row"><span class="rc-key">Condition</span><span class="rc-val">${sos.medical_condition}</span></div>` : ''}
        </div>
        
        ${sos.reassigned_reason ? `
        <div class="intel-box">
          <div class="intel-head">
            <span class="intel-shield">🛡️</span>
            <b>Route Intelligence:</b>
          </div>
          <div class="intel-msg">${sos.reassigned_reason}</div>
          ${sos.block_image ? `
          <div class="intel-img-wrap">
            <img src="/static/images/${sos.block_image}" class="intel-img" alt="Road block" onerror="this.parentElement.style.display='none'">
          </div>` : ''}
        </div>` : ''}

        <div class="live-track" style="margin-top:20px">
          <div class="live-dot"></div> See live map below — ambulance is moving toward you
        </div>
        <button onclick="cancelSOS()" class="btn-cancel">Cancel SOS (false alarm)</button>
      </div>`);

    // Show map and draw/redraw route if hospital changed
    if (sos.hospital_lat && sos.hospital_lon) {
      showVictimMap();
      showHospitalOnMap(sos.hospital_lat, sos.hospital_lon, sos.hospital_name);
      if (hospitalChanged) {
        // Hospital changed — reset route so it redraws
        routeDrawn = false;
        if (routePolyline) { victimMap.removeLayer(routePolyline); routePolyline = null; }
        if (ambulanceMarker) { victimMap.removeLayer(ambulanceMarker); ambulanceMarker = null; }
      }
      // Start/continue polling server for synced ambulance position
      startSyncPolling(sos.id);
    }

  } else if (sos.status === 'NEW') {
    showResult(`
      <div class="result-card sent">
        <div class="rc-header">
          <div class="rc-icon blue">📡</div>
          <div><div class="rc-title">SOS Received</div>
          <div class="rc-sub">SOS #${sos.id} · Awaiting dispatch</div></div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Hospital</span>
            <span class="rc-val">${sos.hospital_name || 'Locating nearest...'}</span>
          </div>
          <div class="rc-row"><span class="rc-key">Priority</span>
            <span class="rc-val"><span class="priority-badge p-${pri}">${pri}</span></span>
          </div>
        </div>
        ${sos.reassigned_reason ? `
        <div class="intel-box" style="margin-top:10px">
          <div class="intel-head"><span class="intel-shield">🚧</span><b>Route Alert:</b></div>
          <div class="intel-msg">${sos.reassigned_reason}</div>
          ${sos.block_image ? `<div class="intel-img-wrap"><img src="/static/images/${sos.block_image}" class="intel-img" alt="Road block" onerror="this.parentElement.style.display='none'"></div>` : ''}
        </div>` : ''}
        <div class="live-track" style="margin-top:12px"><div class="live-dot"></div> Rescue team notified — do not move</div>
        <button onclick="cancelSOS()" class="btn-cancel">Cancel SOS (false alarm)</button>
      </div>`);
    // Show map with just victim pin while waiting
    showVictimMap();
    if (sos.hospital_lat && sos.hospital_lon) {
      showHospitalOnMap(sos.hospital_lat, sos.hospital_lon, sos.hospital_name);
    }
  }
}

// ── Show result card ──────────────────────────────────────────
function showResult(html) {
  const ws = document.getElementById('waitingState');
  const sr = document.getElementById('sosResult');
  if (ws) ws.style.display = 'none';
  if (sr) { sr.style.display = 'block'; sr.innerHTML = html; }
}

// ── Cancel SOS ────────────────────────────────────────────────
async function cancelSOS() {
  if (!currentSOSId || !confirm('Are you sure you want to cancel your SOS?')) return;
  try { await fetch(`/api/victim/sos/${currentSOSId}/cancel`, {method:'POST'}); } catch(e) {}
  stopStatusTracking();
  stopAmbulanceAnim(); // also clears syncPollInterval
  routeDrawn = false;
  routePolylineHash = 0;
  currentSOSId = null;
  // Reset UI
  document.getElementById('waitingState').style.display = 'block';
  const sr = document.getElementById('sosResult');
  sr.style.display = 'none'; sr.innerHTML = '';
  document.getElementById('victimMapWrap').style.display = 'none';
  document.getElementById('sosButton').disabled = false;
  const label = document.getElementById('sosLabel');
  if (label) label.style.opacity = '1';
}

// ── SOS submission ────────────────────────────────────────────
async function submitSOS(isQuick) {
  if (!userLocation) { alert('⚠️ Location not ready — please wait a moment'); return; }

  const btn     = document.getElementById('sosButton');
  const label   = document.getElementById('sosLabel');
  const spinner = document.getElementById('sosSpinner');
  btn.disabled = true;
  if (label)   label.style.opacity   = '0';
  if (spinner) spinner.style.display = 'block';

  try {
    const fd = new FormData();
    fd.append('latitude',  userLocation.latitude);
    fd.append('longitude', userLocation.longitude);
    const medical = document.getElementById('medical').value;
    if (medical) fd.append('medical_condition', medical);
    const tags = Array.from(document.querySelectorAll('input[name="vulnerability"]:checked'))
      .map(c => c.value).join(', ');
    if (tags) fd.append('vulnerability_tags', tags);
    const photo = document.getElementById('photoInput').files[0];
    if (photo) fd.append('photo', photo);
    fd.append('is_quick', isQuick ? 'true' : 'false');

    const d = await fetch('/api/victim/sos', {method:'POST', body:fd}).then(r => r.json());
    if (!d.success) throw new Error(d.error || 'Failed to send SOS');
    currentSOSId = d.sos_id;

    // Show initial sent card
    showResult(`
      <div class="result-card sent">
        <div class="rc-header">
          <div class="rc-icon blue">✅</div>
          <div><div class="rc-title">SOS Sent Successfully</div>
          <div class="rc-sub">Request #${d.sos_id} — rescue team notified</div></div>
        </div>
        <div class="rc-rows">
          <div class="rc-row"><span class="rc-key">Name</span><span class="rc-val">${d.name}</span></div>
          <div class="rc-row"><span class="rc-key">Phone</span><span class="rc-val">${d.phone}</span></div>
          <div class="rc-row"><span class="rc-key">Priority</span>
            <span class="rc-val"><span class="priority-badge p-${d.priority}">${d.priority}</span></span>
          </div>
          <div class="rc-row"><span class="rc-key">Hospital</span>
            <span class="rc-val">${d.hospital?.name || 'Locating...'} ${d.hospital?.distance ? '(' + d.hospital.distance.toFixed(1) + ' km)' : ''}</span>
          </div>
          ${d.current_risk_level ? `<div class="rc-row"><span class="rc-key">Alert Level</span><span class="rc-val">${d.current_risk_level}</span></div>` : ''}
        </div>
        <div class="live-track"><div class="live-dot"></div> Live tracking active — stay where you are</div>
      </div>`);

    // Show map immediately with victim pin
    showVictimMap();
    initVictimMap(userLocation.latitude, userLocation.longitude);

    // Show hospital on map if returned
    if (d.hospital?.lat && d.hospital?.lng) {
      showHospitalOnMap(d.hospital.lat, d.hospital.lng, d.hospital.name);
      document.getElementById('vmapSub').textContent = `Awaiting dispatch — ${d.hospital.name}`;
    }

    startStatusTracking(d.sos_id);
    debouncedLocationSend();

    if (!isQuick) {
      document.getElementById('sosForm').reset();
      document.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('selected'));
      document.getElementById('photoPreview').style.display = 'none';
    }

  } catch(err) {
    showResult(`
      <div class="result-card" style="border-color:rgba(239,68,68,0.3)">
        <div class="rc-header">
          <div class="rc-icon" style="background:rgba(239,68,68,0.15)">❌</div>
          <div><div class="rc-title">Submission Failed</div><div class="rc-sub">${err.message}</div></div>
        </div>
        <p style="font-size:0.85rem;color:var(--muted);margin-top:12px">
          Please try again or call <b style="color:#f87171">1916</b> — Tamil Nadu Disaster Helpline
        </p>
      </div>`);
    btn.disabled = false;
  } finally {
    if (label)   label.style.opacity   = '1';
    if (spinner) spinner.style.display = 'none';
    if (!currentSOSId) btn.disabled = false;
  }
}

function quickSOS() { submitSOS(true); }

async function submitDetailedSOS(e) {
  e.preventDefault();
  const btn  = e.target.querySelector('button[type="submit"]');
  const orig = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '⏳ Sending...';
  await submitSOS(false);
  btn.disabled = false; btn.innerHTML = orig;
}

function previewPhoto(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    const p = document.getElementById('photoPreview');
    p.src = ev.target.result; p.style.display = 'block';
    document.querySelector('.photo-text').textContent = 'Photo attached ✓';
  };
  r.readAsDataURL(f);
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  startLocationTracking();
  loadNavRisk();
  setInterval(loadNavRisk, 120000);
  if ('Notification' in window && Notification.permission === 'default')
    Notification.requestPermission();

  // ── Resume if SOS already active from a previous session / reload ──
  try {
    const d = await fetch('/api/victim/my-sos').then(r => r.json());
    if (d.found && d.sos && !['Rescued','Cancelled'].includes(d.sos.status)) {
      console.log(`▶ Resuming SOS #${d.sos.id} status=${d.sos.status}`);
      currentSOSId = d.sos.id;
      // Show the map immediately using stored location from SOS
      const lat = d.sos.latitude, lng = d.sos.longitude;
      showVictimMap();
      initVictimMap(lat, lng);
      if (d.sos.hospital_lat) showHospitalOnMap(d.sos.hospital_lat, d.sos.hospital_lon, d.sos.hospital_name);
      // Force updateStatusUI to run by clearing lastKnownState
      lastKnownState = {status:'', hospital:'', reason:''};
      updateStatusUI(d.sos);
      startStatusTracking(d.sos.id);
      // Start sync polling immediately if already dispatched
      if (d.sos.status === 'Assigned') startSyncPolling(d.sos.id);
    }
  } catch(e) {}
});

window.addEventListener('beforeunload', () => {
  if (locationWatchId) navigator.geolocation.clearWatch(locationWatchId);
  stopStatusTracking();
  stopAmbulanceAnim();
  if (locationSendTimer) clearTimeout(locationSendTimer);
});