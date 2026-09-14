/**
 * ============================================================================
 * WORKER MONITORING - ENTERPRISE CLIENT ENGINE (SCRIPT.JS)
 * VERSION: 5.4.0 (Defensive Armor Plating Update)
 * ============================================================================
 * This engine handles spatial kinematics, socket duplexing, and DOM updates.
 * It is heavily protected against Null Pointer Exceptions and Audio Blocking.
 */

(function () {
    "use strict";

    // ==========================================
    // 1. CORE UTILITIES & MATH ENGINE
    // ==========================================
    const Utils = {
        escapeHtml: (str) => {
            if (!str) return "";
            return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },
        // Calculates dynamic steps for the SVG Graph based on highest altitude
        niceStep: (maxVal) => { 
            const rough = maxVal / 4; 
            const mag = Math.pow(10, Math.floor(Math.log10(rough || 1))); 
            const norm = rough / mag; 
            return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag; 
        },
        // Haversine formula for exact Geofence distance calculation in meters
        calculateDistance: (lat1, lon1, lat2, lon2) => {
            const R = 6371e3; 
            const p1 = lat1 * Math.PI/180;
            const p2 = lat2 * Math.PI/180;
            const dp = (lat2-lat1) * Math.PI/180;
            const dl = (lon2-lon1) * Math.PI/180;
            const a = Math.sin(dp/2) * Math.sin(dp/2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl/2) * Math.sin(dl/2);
            return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
        }
    };

    // ==========================================
    // 2. TACTICAL AUDIO ENGINE (Bypasses Browser Blocks)
    // ==========================================
    const AudioEngine = {
        ctx: null,
        unlocked: false,
        init: function() {
            if (this.ctx) return;
            try {
                this.ctx = new (window.AudioContext || window.webkitAudioContext)();
                console.log("AudioEngine: Context Initialized");
            } catch (e) {
                console.error("AudioEngine: Not supported", e);
            }
        },
        unlock: function() {
            if (this.unlocked || !this.ctx) return;
            if (this.ctx.state === 'suspended') this.ctx.resume();
            
            // Play a silent tone to force browser unlock
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            gain.gain.value = 0;
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(0);
            osc.stop(0.1);
            this.unlocked = true;
            console.log("AudioEngine: Unlocked by user gesture");
        },
        triggerSiren: function(isManDown = false) {
            if (!this.ctx) this.init();
            if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
            if (navigator.vibrate) try { navigator.vibrate(isManDown ? [500, 200, 500, 200, 1000] : [200, 100, 200, 100, 400]); } catch (e) {}
            
            try {
                const pattern = isManDown 
                    ? [[440, 0.4], [0, 0.1], [880, 0.4], [0, 0.1], [440, 0.6]] // Man-down pattern (Two-tone)
                    : [[880, 0.15], [0, 0.05], [660, 0.15], [0, 0.05], [880, 0.28]]; // Fall pattern (Rapid)
                
                let t = this.ctx.currentTime;
                pattern.forEach(([freq, dur]) => {
                    if (freq > 0) {
                        const osc = this.ctx.createOscillator();
                        const gain = this.ctx.createGain();
                        osc.type = isManDown ? "sawtooth" : "square"; 
                        osc.frequency.value = freq;
                        gain.gain.setValueAtTime(0, t);
                        gain.gain.linearRampToValueAtTime(0.3, t + 0.02);
                        gain.gain.linearRampToValueAtTime(0, t + dur);
                        osc.connect(gain).connect(this.ctx.destination);
                        osc.start(t); osc.stop(t + dur + 0.05);
                    }
                    t += dur;
                });
            } catch (e) {
                console.error("AudioEngine: Siren playback failed", e);
            }
        }
    };

    // Unlock audio on first click anywhere on the document
    document.body.addEventListener('click', () => AudioEngine.unlock(), { once: true });

    // ==========================================
    // 3. SOCKET & STATE MANAGEMENT (Defensive)
    // ==========================================
    let socket;
    try {
        if (typeof io !== 'undefined') {
            socket = io();
        } else {
            throw new Error("Socket.io library not found.");
        }
    } catch (e) {
        console.error("CRITICAL: Cannot connect to server. Are you running node server.js?", e);
        // Create a mock socket to prevent the rest of the script from crashing
        socket = { on: () => {}, emit: () => {}, to: () => ({ emit: () => {} }) };
        setTimeout(() => showAlert("⚠️ OFFLINE MODE: Server connection failed."), 2000);
    }
    
    const STATE = {
        role: "worker", 
        groupCode: null,
        mySelfId: null,
        liveTrackingId: null,
        gpsWatchId: null,
        globalBaseline: 0,
        geofenceRadius: 500,
        group: [],
        logs: [],
        kinematicHistory: [],
        mapInstance: null,
        mapMarkers: {},
        geofenceCircle: null,
        hospitalLayer: null,
        pendingLocation: null,
        isManualMode: false,
        baroSensor: null,
        baroBaseline: null,
        
        // Man-Down Specific State
        lastMoveTime: Date.now(),
        lastMoveLat: null,
        lastMoveLon: null,
        mdCheckInterval: null,
        mdCountdownInterval: null,
        mdActive: false
    };

    const CONFIG = {
        STORAGE_KEY: "altiguard_v5_settings",
        DEFAULT_LIMIT: 2.0,
        DEFAULT_DROP: 1.5,
        DEFAULT_WINDOW: 4,
        DEFAULT_FLOOR: 3.5,
        DEFAULT_NTFY: "",
        DEFAULT_GEOFENCE: 500,
        DEFAULT_MANDOWN: 3 // minutes
    };

    // Load Local Settings Safely
    let savedSettings = {};
    try { savedSettings = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || {}; } catch(e){}
    let localSettings = { ...CONFIG, ...savedSettings };
    if (localSettings.ntfyTopic === "undefined") localSettings.ntfyTopic = "";

    // ==========================================
    // 4. DEFENSIVE DOM BINDING
    // ==========================================
    // This prevents the "fatal null pointer" crash if an HTML element is missing.
    const getDOM = (id) => document.getElementById(id);
    const bindEvent = (id, event, handler) => {
        const el = getDOM(id);
        if (el) el.addEventListener(event, handler);
        else console.warn(`UI Binding Warning: Element #${id} not found in HTML.`);
    };

    const DOM = {
        statRole: getDOM("statRole"),
        statActive: getDOM("statActive"),
        statStatus: getDOM("statStatus"),
        rosterList: getDOM("rosterList"),
        graphSvg: getDOM("graphSvg"),
        alertBanner: getDOM("alertBanner"),
        logList: getDOM("logList"),
        emptyHint: getDOM("emptyHint")
    };

    // ==========================================
    // 5. REST APIS & BAROMETER HARDWARE
    // ==========================================
    async function fetchWithTimeout(resource, options = {}) {
        const { timeout = 8000 } = options;
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(resource, { ...options, signal: controller.signal });
            clearTimeout(id);
            return response;
        } catch (err) {
            clearTimeout(id);
            throw err;
        }
    }

    async function initBarometer() {
        if (!("Barometer" in window)) {
            console.log("Hardware: Barometer API not supported by browser.");
            return;
        }
        try {
            if (navigator.permissions) {
                const status = await navigator.permissions.query({ name: "barometer" });
                if (status.state === "denied") return;
            }
            STATE.baroSensor = new Barometer({ frequency: 1 });
            STATE.baroSensor.addEventListener("reading", () => {
                if (STATE.baroBaseline === null) STATE.baroBaseline = STATE.baroSensor.pressure;
            });
            STATE.baroSensor.start();
            console.log("Hardware: Barometer Active");
        } catch (e) {
            console.warn("Hardware: Barometer initialization failed", e);
        }
    }

    // ==========================================
    // 6. SOCKET EVENT LISTENERS
    // ==========================================
    socket.on('roleAssigned', (data) => {
        STATE.role = data.role; STATE.groupCode = data.groupCode;
        if(DOM.statRole) DOM.statRole.textContent = STATE.role.toUpperCase();
        if(DOM.statStatus) DOM.statStatus.innerHTML = "🟢 CONNECTED";
        
        const isPrivileged = (STATE.role === 'admin' || STATE.role === 'creator');
        
        // Unlock inputs for admin
        const inputs = ['ntfyTopicInput', 'geofenceRadiusInput', 'referenceInput', 'limitInput', 'dropInput', 'windowInput', 'floorInput', 'manDownInput'];
        inputs.forEach(id => {
            const el = getDOM(id);
            if(el) el.disabled = !isPrivileged;
        });
        
        const refBtn = getDOM('setRefBtn');
        if(refBtn) refBtn.disabled = !isPrivileged;

        const topicInput = getDOM('ntfyTopicInput');
        if (isPrivileged && topicInput && topicInput.value) {
            socket.emit('updateNtfyTopic', topicInput.value.trim());
        }

        showAlert(`Uplink Established: ${STATE.groupCode} [${STATE.role.toUpperCase()}]`);
        renderUI();
    });

    socket.on('syncGroup', (members) => { STATE.group = members; renderUI(); });
    
    socket.on('syncBaseline', (baseline) => { 
        STATE.globalBaseline = baseline; 
        const refIn = getDOM('referenceInput');
        if(refIn) refIn.value = baseline; 
        renderUI(); 
    });
    
    socket.on('syncGeofence', (radius) => { 
        STATE.geofenceRadius = radius; 
        const geoIn = getDOM('geofenceRadiusInput');
        if(geoIn && parseFloat(geoIn.value) !== radius) geoIn.value = radius; 
        renderMap(); 
        if (STATE.geofenceCircle && STATE.mapInstance) {
            STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [20, 20] });
        }
    });

    socket.on('syncNtfyTopic', (topic) => { const el = getDOM('ntfyTopicInput'); if(el) el.value = topic; });
    
    socket.on('receiveAlert', (data) => { 
        showAlert(`⚠️ FALL DETECTED: ${data.name} (${data.drop}m)`); 
        logEvent(`⚠️ Fall: ${data.name} (${data.drop}m)`); 
        AudioEngine.triggerSiren(false); 
    });
    
    socket.on('receiveSOS', (payload) => { 
        const type = payload.isManDown ? "MAN-DOWN" : "SOS PANIC";
        showAlert(`🚨 ${type}: ${payload.name}`); 
        logEvent(`🚨 ${type}: ${payload.name}`); 
        AudioEngine.triggerSiren(payload.isManDown); 
    });

    // ==========================================
    // 7. NOTIFICATION ENGINE (Ntfy)
    // ==========================================
    function transmitNtfyAlert(title, message, tags, lat, lon) {
        try { if (window.Notification && Notification.permission === "granted") new Notification(title, { body: message }); } catch(e){}

        const topicInput = getDOM("ntfyTopicInput");
        const topic = (topicInput && topicInput.value.trim()) || localSettings.ntfyTopic;
        if (!topic) return; 
        
        const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
        let ntfyUrl = `https://ntfy.sh/${cleanTopic}?title=${encodeURIComponent(title)}&priority=urgent&tags=${encodeURIComponent(tags)}`;
        if (lat && lon) ntfyUrl += `&click=${encodeURIComponent(`https://www.google.com/maps?q=${lat},${lon}`)}`;

        fetch(ntfyUrl, { method: 'POST', body: message })
            .then(res => { if(res.ok) logEvent(`✅ Ntfy Push Sent: ${title}`); else logEvent(`❌ Ntfy Server Error: ${res.status}`); })
            .catch(err => logEvent(`❌ Ntfy Blocked by Browser. Server-side will handle it.`));
    }

    // ==========================================
    // 8. METEOROLOGY & WEATHER
    // ==========================================
    async function fetchWeatherAndAQI(lat, lon) {
        try {
            const weatherRes = await fetchWithTimeout(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,surface_pressure`);
            const weatherData = await weatherRes.json();
            const aqiRes = await fetchWithTimeout(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`);
            const aqiData = await aqiRes.json();

            const current = weatherData.current;
            const temp = current.temperature_2m;
            
            const setText = (id, txt) => { const el = getDOM(id); if(el) el.innerText = txt; };
            setText("wTemp", `${temp}°C`);
            setText("wFeels", `${current.apparent_temperature}°C`);
            setText("wHum", `${current.relative_humidity_2m}%`);
            setText("wWind", `${current.wind_speed_10m} km/h`);
            setText("wPress", `${Math.round(current.surface_pressure)} hPa`);
            
            const aqiEl = getDOM("wAqi");
            if(aqiEl) {
                const aqi = aqiData.current.european_aqi;
                aqiEl.innerText = aqi;
                aqiEl.className = "aqi-badge";
                if (aqi < 40) aqiEl.classList.add("aqi-good");
                else if (aqi < 80) aqiEl.classList.add("aqi-mod");
                else aqiEl.classList.add("aqi-poor");
            }

            const iconBox = getDOM("weatherIconBox");
            const conditionEl = getDOM("wCondition");
            const code = current.weather_code;
            
            if(conditionEl && iconBox) {
                let conditionText = "Unknown";
                let iconHtml = "";

                if (code === 0) { conditionText = "Clear Sky"; iconHtml = `<div class="anim-sun"></div>`; }
                else if (code === 1 || code === 2) { conditionText = "Partly Cloudy"; iconHtml = `<div class="anim-sun-cloud-wrapper"><div class="anim-sun"></div><div class="anim-cloud"></div></div>`; }
                else if (code >= 51 && code <= 67) { conditionText = "Rain"; iconHtml = `<div class="anim-cloud anim-rain"></div>`; }
                else if (code >= 71 && code <= 86) { conditionText = "Snow"; iconHtml = `<div class="anim-cloud anim-snow"></div>`; }
                else if (code >= 95) { conditionText = "Storm"; iconHtml = `<div class="anim-cloud anim-rain anim-lightning"></div>`; }
                else { conditionText = "Overcast"; iconHtml = `<div class="anim-cloud"></div>`; }

                conditionEl.innerText = conditionText;
                iconBox.innerHTML = iconHtml;
            }

            const mapHudTemp = getDOM("hudTemp");
            const mapHudWind = getDOM("hudWind");
            if(mapHudTemp) mapHudTemp.innerHTML = `${temp}&deg;C`;
            if(mapHudWind) mapHudWind.innerHTML = `${current.wind_speed_10m} km/h`;

        } catch (e) {
            console.warn("Weather fetch failed", e);
        }
    }

    async function fetchAddress(lat, lon) {
        try {
            const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
            const data = await res.json();
            if (data && data.address) { const addr = data.address; return `${addr.road || addr.suburb || ''}, ${addr.city || addr.town || addr.county || ''}`; }
            return "Coordinates locked.";
        } catch(e) { return "Coordinates locked."; }
    }

    // ==========================================
    // 9. UI EVENT BINDINGS (Defensive)
    // ==========================================
    
    bindEvent("createGroupBtn", "click", () => { 
        const input = getDOM("groupCodeInput"); 
        if(input && input.value) socket.emit('createGroup', input.value); 
        else showAlert("Enter a Site Code first.");
    });
    
    bindEvent("joinGroupActionBtn", "click", () => { 
        const input = getDOM("groupCodeInput"); 
        if(input && input.value) socket.emit('joinGroup', input.value); 
        else showAlert("Enter a Site Code first."); 
    });

    bindEvent("setRefBtn", "click", () => {
        if (STATE.role !== 'admin' && STATE.role !== 'creator') return showAlert("Access Denied.");
        const refIn = getDOM("referenceInput");
        const val = refIn ? (parseFloat(refIn.value) || 0) : 0;
        STATE.globalBaseline = val; 
        socket.emit('setBaseline', val); 
        renderUI(); 
        showAlert(`Datum Zero calibrated to ${val}m`);
    });

    bindEvent("manualToggle", "click", () => {
        STATE.isManualMode = !STATE.isManualMode;
        const manualF = getDOM("manualFields");
        const gpsR = getDOM("gpsReadout");
        const addB = getDOM("addBtn");
        
        if(manualF) manualF.hidden = !STATE.isManualMode;
        if(gpsR) gpsR.hidden = true;
        if(addB) addB.disabled = false;
    });

    bindEvent("captureBtn", "click", () => {
        AudioEngine.triggerSiren(false); 
        const gpsR = getDOM("gpsReadout");
        if(gpsR) { gpsR.hidden = false; gpsR.innerHTML = `<div class="spinner" style="width:15px;height:15px;display:inline-block;vertical-align:middle;margin-right:10px;"></div> Acquiring Lock...`; }
        
        navigator.geolocation.getCurrentPosition(async (pos) => {
            STATE.pendingLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude, height: pos.coords.altitude || 0 };
            const [address] = await Promise.all([ fetchAddress(pos.coords.latitude, pos.coords.longitude), fetchWeatherAndAQI(pos.coords.latitude, pos.coords.longitude) ]);
            if(gpsR) gpsR.innerHTML = `<strong style="color:var(--brand-primary);">📍 Lock Acquired</strong><br><span style="color:#ccc;">${address}</span>`;
            
            const addB = getDOM("addBtn");
            if(addB) addB.disabled = false; 
            
            STATE.isManualMode = false; 
            const manualF = getDOM("manualFields");
            if(manualF) manualF.hidden = true;
        }, (err) => { 
            if(gpsR) gpsR.innerHTML = `❌ GPS Error: ${err.message}`; 
            showAlert(`GPS Error: Please enable Location Services.`);
        }, { enableHighAccuracy: true });
    });

    bindEvent("addForm", "submit", (e) => {
        e.preventDefault();
        if (!STATE.groupCode) return showAlert("⚠️ Create or Join a group first!");

        const nameIn = getDOM("nameInput");
        const desIn = getDOM("designationInput");
        const name = nameIn ? nameIn.value.trim() : "Unknown";
        const designation = desIn ? desIn.value.trim() : "Operator";
        
        if (!name) return;
        if (!STATE.mySelfId) STATE.mySelfId = "OP-" + Math.random().toString(36).slice(2, 10).toUpperCase();
        
        let pLat = null, pLon = null, pHeight = 0;
        
        if (STATE.isManualMode) {
            const hIn = getDOM("manualHeight");
            const latIn = getDOM("manualLat");
            const lonIn = getDOM("manualLon");
            pHeight = hIn ? parseFloat(hIn.value) || 0 : 0;
            pLat = latIn ? parseFloat(latIn.value) || null : null;
            pLon = lonIn ? parseFloat(lonIn.value) || null : null;
            if (pLat !== null && pLon !== null) { 
                fetchWeatherAndAQI(pLat, pLon); 
                if(STATE.mapInstance) STATE.mapInstance.flyTo([pLat, pLon], 16); 
            }
        } else if (STATE.pendingLocation) {
            pLat = STATE.pendingLocation.lat; 
            pLon = STATE.pendingLocation.lon; 
            pHeight = STATE.pendingLocation.height;
            if (STATE.mapInstance) STATE.mapInstance.flyTo([pLat, pLon], 18);
        }

        const person = { id: STATE.mySelfId, name: name, designation: designation, role: STATE.role, height: pHeight, lat: pLat, lon: pLon, method: STATE.isManualMode ? "manual" : "auto" };

        const existingIndex = STATE.group.findIndex(p => p.id === STATE.mySelfId);
        if (existingIndex > -1) STATE.group[existingIndex] = person;
        else STATE.group.push(person);

        socket.emit('updateGroupData', STATE.group);
        if (!STATE.isManualMode) startTracking(STATE.mySelfId);
        
        if(nameIn) nameIn.value = ""; 
        if(desIn) desIn.value = "";
        renderUI(); 
        showAlert(`✅ ${name} injected into grid.`);
    });

    // --- BLOB LEDGER EXPORT ---
    bindEvent("downloadLogsBtn", "click", () => {
        if (STATE.logs.length === 0) return showAlert("⚠️ Ledger is currently empty.");
        
        const header = `====================================================\n` +
                       `WORKER MONITORING - COMMAND INCIDENT LEDGER\n` +
                       `====================================================\n` +
                       `SITE CODE: ${STATE.groupCode || 'OFFLINE'}\n` +
                       `GENERATED: ${new Date().toLocaleString()}\n` +
                       `TOTAL EVENTS: ${STATE.logs.length}\n` +
                       `====================================================\n\n`;
                       
        const blob = new Blob([header + STATE.logs.join("\n")], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Incident_Ledger_${STATE.groupCode || 'LOG'}_${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        logEvent("📥 Incident ledger exported locally.");
    });

    // --- SETTINGS AUTOSAVE ---
    const saveSettings = () => { 
        const v = (id, def) => { const el = getDOM(id); return el ? parseFloat(el.value) || def : def; };
        
        localSettings.limit = v("limitInput", CONFIG.DEFAULT_LIMIT);
        localSettings.dropThreshold = v("dropInput", CONFIG.DEFAULT_DROP);
        localSettings.dropWindow = v("windowInput", CONFIG.DEFAULT_WINDOW);
        localSettings.floorHeight = v("floorInput", CONFIG.DEFAULT_FLOOR);
        localSettings.manDownTimer = v("manDownInput", CONFIG.DEFAULT_MANDOWN);
        
        const geoIn = getDOM("geofenceRadiusInput");
        if(geoIn && (STATE.role === 'admin' || STATE.role === 'creator')) {
            const rad = parseFloat(geoIn.value) || CONFIG.DEFAULT_GEOFENCE;
            if (STATE.geofenceRadius !== rad) {
                localSettings.geofenceRadius = rad;
                STATE.geofenceRadius = rad; 
                socket.emit('updateGeofenceRadius', rad);
                
                const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
                if (adminNode && adminNode.lat !== null && STATE.mapInstance && STATE.geofenceCircle) {
                    STATE.geofenceCircle.setRadius(rad);
                    STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [20, 20] });
                }
            }
        }

        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(localSettings)); 
        
        const tIn = getDOM("ntfyTopicInput");
        if (tIn && (STATE.role === 'admin' || STATE.role === 'creator')) {
            localSettings.ntfyTopic = tIn.value.trim();
            socket.emit('updateNtfyTopic', localSettings.ntfyTopic);
        }
        renderUI(); 
    };
    
    ['limitInput', 'dropInput', 'windowInput', 'ntfyTopicInput', 'floorInput', 'geofenceRadiusInput', 'manDownInput'].forEach(id => { 
        bindEvent(id, "input", saveSettings); 
    });

    bindEvent("testAlertBtn", "click", () => {
        socket.emit('triggerFallAlert', { name: "System Diagnostic", drop: 1.5, id: "test" }); 
        showAlert(`⚠️ TEST SIREN INITIATED`); 
        logEvent("Test alert broadcasted."); 
        AudioEngine.triggerSiren(false);
        transmitNtfyAlert("⚠️ TEST SIREN", "A diagnostic test siren activated.", "loudspeaker");
    });

    bindEvent("sosTriggerBtn", "click", () => {
        if (!STATE.mySelfId) return showAlert("Matrix Error: Inject into the grid to use SOS.");
        const me = STATE.group.find(p => p.id === STATE.mySelfId);
        if(me) {
            socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height, isManDown: false });
            AudioEngine.triggerSiren(false);
            transmitNtfyAlert(`🚨 SOS: ${me.name}`, `${me.name} triggered SOS!`, "sos,rotating_light", me.lat, me.lon);
        }
    });

    // ==========================================
    // 10. MAN-DOWN LOGIC ENGINE
    // ==========================================
    function triggerManDownWarning() {
        if (STATE.mdActive) return;
        STATE.mdActive = true;
        const modal = getDOM('manDownModal');
        const countdownEl = getDOM('mdCountdown');
        
        if(modal) modal.hidden = false;
        AudioEngine.triggerSiren(true); // Wake them up
        
        let timeLeft = 30;
        if(countdownEl) countdownEl.innerText = timeLeft;
        
        STATE.mdCountdownInterval = setInterval(() => {
            timeLeft--;
            if(countdownEl) countdownEl.innerText = timeLeft;
            
            if (timeLeft <= 0) {
                clearInterval(STATE.mdCountdownInterval);
                if(modal) modal.hidden = true;
                
                // Trigger global SOS
                const me = STATE.group.find(p => p.id === STATE.mySelfId);
                if(me) {
                    socket.emit('triggerSOS', { name: me.name, lat: me.lat, lon: me.lon, height: me.height, isManDown: true });
                    transmitNtfyAlert(`🚨 MAN-DOWN: ${me.name}`, `${me.name} is incapacitated!`, "sos,warning", me.lat, me.lon);
                }
            }
        }, 1000);
    }

    bindEvent('mdOkayBtn', 'click', () => {
        clearInterval(STATE.mdCountdownInterval);
        const modal = getDOM('manDownModal');
        if(modal) modal.hidden = true;
        STATE.mdActive = false;
        STATE.lastMoveTime = Date.now(); // Reset
    });


    // ==========================================
    // 11. TRACKING & KINEMATICS
    // ==========================================
    window.toggleTrack = function(id) { if (STATE.liveTrackingId === id) stopTracking(); else startTracking(id); };
    window.removeNode = function(id) { if (STATE.liveTrackingId === id) stopTracking(); socket.emit('removePerson', id); };

    function startTracking(personId) {
        if (!navigator.geolocation) return showAlert("Geolocation completely disabled in this browser.");
        stopTracking(); 
        AudioEngine.triggerSiren(false); 
        STATE.liveTrackingId = personId; 
        renderUI(); 
        
        STATE.lastMoveTime = Date.now();

        STATE.gpsWatchId = navigator.geolocation.watchPosition((pos) => {
            const person = STATE.group.find(p => p.id === STATE.liveTrackingId);
            if (person) {
                
                // Man-Down Micro-Movement Check
                if (STATE.lastMoveLat !== null && STATE.lastMoveLon !== null) {
                    const distMoved = Utils.calculateDistance(STATE.lastMoveLat, STATE.lastMoveLon, pos.coords.latitude, pos.coords.longitude);
                    if (distMoved > 3) { // Moved > 3 meters
                        STATE.lastMoveTime = Date.now();
                        STATE.lastMoveLat = pos.coords.latitude;
                        STATE.lastMoveLon = pos.coords.longitude;
                    }
                } else {
                    STATE.lastMoveLat = pos.coords.latitude;
                    STATE.lastMoveLon = pos.coords.longitude;
                }

                person.lat = pos.coords.latitude; person.lon = pos.coords.longitude;
                if (pos.coords.altitude !== null) person.height = pos.coords.altitude;
                
                checkGeofenceBreach(person);
                checkKinematicDrop(person); 
                socket.emit('updateGroupData', STATE.group); 
                renderUI();
            }
        }, (err) => { 
            console.warn(`GPS Warning: ${err.message}`); 
        }, { enableHighAccuracy: true, maximumAge: 0 });

        // Man-Down Interval Checker
        STATE.mdCheckInterval = setInterval(() => {
            if (STATE.mdActive) return;
            const mdIn = getDOM("manDownInput");
            const limitMins = (mdIn ? parseFloat(mdIn.value) : CONFIG.DEFAULT_MANDOWN) || CONFIG.DEFAULT_MANDOWN;
            if (limitMins <= 0) return; 
            
            if (Date.now() - STATE.lastMoveTime > (limitMins * 60 * 1000)) {
                triggerManDownWarning();
            }
        }, 10000); // Check every 10s
    }

    function stopTracking() {
        if (STATE.gpsWatchId) navigator.geolocation.clearWatch(STATE.gpsWatchId);
        if (STATE.mdCheckInterval) clearInterval(STATE.mdCheckInterval);
        STATE.liveTrackingId = null; STATE.gpsWatchId = null; renderUI();
    }

    function checkGeofenceBreach(person) {
        if (STATE.group.length === 0 || person.lat === null || person.lon === null) return;
        const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
        
        if (adminNode && adminNode.lat && adminNode.lon && adminNode.id !== person.id) {
            const dist = Utils.calculateDistance(adminNode.lat, adminNode.lon, person.lat, person.lon);
            if (dist > STATE.geofenceRadius) {
                if (!person.lastGeoAlert || Date.now() - person.lastGeoAlert > 10000) {
                    showAlert(`🚨 BREACH: ${person.name} is ${Math.round(dist)}m away!`);
                    AudioEngine.triggerSiren(false);
                    transmitNtfyAlert(`🚨 BREACH: ${person.name}`, `${person.name} left safe zone!`, "warning,world_map", person.lat, person.lon);
                    person.lastGeoAlert = Date.now();
                }
            }
        }
    }

    function checkKinematicDrop(person) {
        const now = Date.now();
        const dIn = getDOM("dropInput"), wIn = getDOM("windowInput");
        const limit = dIn ? parseFloat(dIn.value) || CONFIG.DEFAULT_DROP : CONFIG.DEFAULT_DROP;
        const windowSec = wIn ? parseInt(wIn.value) || CONFIG.DEFAULT_WINDOW : CONFIG.DEFAULT_WINDOW;
        
        STATE.kinematicHistory.push({ time: now, h: person.height });
        STATE.kinematicHistory = STATE.kinematicHistory.filter(e => now - e.time <= windowSec * 1000);
        
        if (STATE.kinematicHistory.length >= 2) {
            const peak = Math.max(...STATE.kinematicHistory.map(e => e.h));
            if (peak - person.height >= limit) {
                const dropAmt = (peak - person.height).toFixed(2);
                socket.emit('triggerFallAlert', { name: person.name, drop: dropAmt, id: person.id, lat: person.lat, lon: person.lon });
                AudioEngine.triggerSiren(false); 
                transmitNtfyAlert(`🚨 FALL: ${person.name}`, `${person.name} dropped ${dropAmt}m!`, "rotating_light,skull", person.lat, person.lon);
                STATE.kinematicHistory = []; 
            }
        }
    }

    // ==========================================
    // 12. RENDER ENGINE
    // ==========================================
    function renderUI() {
        if(DOM.statActive) DOM.statActive.textContent = `${STATE.group.length} Tracked`;
        if (STATE.group.length === 0) { 
            if(DOM.emptyHint) DOM.emptyHint.style.display = "flex"; 
            if(DOM.rosterList) DOM.rosterList.innerHTML = ""; 
            if(DOM.graphSvg) DOM.graphSvg.innerHTML = ""; 
        } 
        else { 
            if(DOM.emptyHint) DOM.emptyHint.style.display = "none"; 
            renderRoster(); renderGraph(); 
        }
        renderMap();
    }

    function renderRoster() {
        if(!DOM.rosterList) return;
        DOM.rosterList.innerHTML = STATE.group.map(p => {
            const relHeight = p.height - STATE.globalBaseline;
            
            const tolerance = 0.1;
            let statusClass = "status-within"; 
            if (relHeight > tolerance) statusClass = "status-above"; 
            else if (relHeight < -tolerance) statusClass = "status-below"; 

            const isLive = p.id === STATE.liveTrackingId;
            const isMe = p.id === STATE.mySelfId;
            
            let actionBtns = "";
            if (STATE.role === "admin" || STATE.role === "creator" || isMe) {
                actionBtns += `<button class="mini-btn remove-btn" onclick="removeNode('${p.id}')">✕ Eject</button>`;
            }
            if (isMe) {
                actionBtns += `<button class="mini-btn track-btn ${isLive ? 'active' : ''}" onclick="toggleTrack('${p.id}')">${isLive ? "⏹ Halt" : "📍 Track"}</button>`;
            }

            return `
                <li class="roster-item ${isLive ? 'is-live' : ''}">
                    <div class="roster-info">
                        <strong>${(p.role === 'admin' || p.role === 'creator') ? '👑 ' : ''}${Utils.escapeHtml(p.name)}</strong>
                        <span class="roster-sub">${Utils.escapeHtml(p.designation)} <br> Raw Z: ${p.height.toFixed(2)}m</span>
                    </div>
                    <div class="roster-status ${statusClass}">${(relHeight >= 0 ? "+" : "")}${relHeight.toFixed(2)}m</div>
                    <div class="roster-actions">${actionBtns}</div>
                </li>
            `;
        }).join('');
    }

    function renderGraph() {
        if(!DOM.graphSvg) return;
        const W = DOM.graphSvg.clientWidth || 1000; const H = DOM.graphSvg.clientHeight || 600; 
        
        const paddingLeft = 60; const paddingRight = 40; const paddingTopBottom = 100; 
        
        const lIn = getDOM("limitInput"), fIn = getDOM("floorInput");
        const limit = lIn ? parseFloat(lIn.value) || CONFIG.DEFAULT_LIMIT : CONFIG.DEFAULT_LIMIT;
        const floorH = fIn ? parseFloat(fIn.value) || CONFIG.DEFAULT_FLOOR : CONFIG.DEFAULT_FLOOR;
        
        const rels = STATE.group.map(p => p.height - STATE.globalBaseline);
        const maxAbs = Math.max(limit * 1.5, ...rels.map(Math.abs), 1);
        const plotHeight = H - (paddingTopBottom * 2);
        const scaleY = (plotHeight / 2) / maxAbs; const midY = H / 2;

        let svgHtml = "";
        const usableWidth = W - paddingLeft - paddingRight;

        const startFloor = Math.floor(-maxAbs / floorH) - 1;
        const endFloor = Math.ceil(maxAbs / floorH) + 1;
        
        const floorSpacingPx = floorH * scaleY;

        if (floorSpacingPx > 15) {
            for (let f = startFloor; f <= endFloor; f++) {
                const yFloor = midY - (f * floorH) * scaleY;
                if (yFloor >= paddingTopBottom && yFloor <= H - paddingTopBottom) {
                    if (f !== 0) { 
                        svgHtml += `<line class="floor-line" x1="${paddingLeft}" y1="${yFloor}" x2="${W - paddingRight}" y2="${yFloor}"></line>`;
                        if (floorSpacingPx > 30) {
                            const labelStr = f > 0 ? `Lvl ${f}` : `Bsmnt ${Math.abs(f)}`;
                            svgHtml += `<text x="${W - paddingRight - 10}" y="${yFloor - 8}" class="floor-label" text-anchor="end">${labelStr}</text>`;
                        }
                    }
                }
            }
        }

        const step = Utils.niceStep(maxAbs);
        for (let v = step; v <= maxAbs; v += step) {
            [v, -v].forEach(val => {
                const y = midY - (val * scaleY);
                if (y >= paddingTopBottom && y <= H - paddingTopBottom) {
                    svgHtml += `<line class="grid-line" x1="${paddingLeft}" y1="${y}" x2="${W - paddingRight}" y2="${y}"></line>`;
                    svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${y + 4}" text-anchor="end" font-weight="bold">${(val > 0 ? '+' : '')}${val}m</text>`;
                }
            });
        }

        svgHtml += `<line class="baseline" x1="${paddingLeft}" y1="${midY}" x2="${W - paddingRight}" y2="${midY}"></line>`;
        svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${midY + 4}" fill="#00e5ff" font-weight="bold" text-anchor="end">0m</text>`;
        svgHtml += `<text class="axis-label" x="${W - paddingRight}" y="${midY - 10}" fill="#00e5ff" text-anchor="end">DATUM ZERO</text>`;

        STATE.group.forEach((p, i) => {
            const rel = p.height - STATE.globalBaseline;
            const x = paddingLeft + (usableWidth * (i + 0.5)) / STATE.group.length;
            const y = midY - (rel * scaleY);
            
            const tolerance = 0.1;
            let status = "within"; 
            if (rel > tolerance) status = "above"; 
            else if (rel < -tolerance) status = "below"; 

            svgHtml += `
                <g class="figure figure-${status}" style="transform: translate(${x}px, ${y}px)">
                    ${p.id === STATE.liveTrackingId ? '<circle class="live-halo" r="30" cy="-10"></circle>' : ''}
                    <text class="figure-readout" x="0" y="-55" text-anchor="middle">${(rel >= 0 ? "+" : "")}${rel.toFixed(2)}m</text>
                    <circle class="figure-head" cx="0" cy="-30" r="10"></circle>
                    <line class="figure-body" x1="0" y1="-20" x2="0" y2="10"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="-15" y2="-5"></line>
                    <line class="figure-arm" x1="0" y1="-15" x2="15" y2="-5"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="-12" y2="30"></line>
                    <line class="figure-leg" x1="0" y1="10" x2="12" y2="30"></line>
                    <text class="figure-label" x="0" y="55" text-anchor="middle">${Utils.escapeHtml(p.name)}</text>
                    <text class="figure-label-sub" x="0" y="70" text-anchor="middle">${Utils.escapeHtml(p.designation)}</text>
                </g>
            `;
        });
        DOM.graphSvg.innerHTML = svgHtml;
    }

    function renderMap() {
        if (!STATE.mapInstance && typeof L !== "undefined" && getDOM('map')) {
            STATE.mapInstance = L.map('map').setView([20.5937, 78.9629], 5);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(STATE.mapInstance);
            STATE.hospitalLayer = L.layerGroup().addTo(STATE.mapInstance);
            
            const weatherControl = L.control({position: 'topright'});
            weatherControl.onAdd = function () {
                const div = L.DomUtil.create('div', 'weather-hud');
                div.innerHTML = `SITE ATMOSPHERE<br><span id="hudTemp">--&deg;C</span> | <span id="hudWind">-- km/h</span>`;
                return div;
            };
            weatherControl.addTo(STATE.mapInstance);
        }
        if (!STATE.mapInstance) return;

        const adminNode = STATE.group.find(p => p.role === 'admin' || p.role === 'creator');
        if (adminNode && adminNode.lat !== null && adminNode.lon !== null) {
            const centerLatLng = [adminNode.lat, adminNode.lon];
            if (STATE.geofenceCircle) {
                STATE.geofenceCircle.setLatLng(centerLatLng);
                STATE.geofenceCircle.setRadius(STATE.geofenceRadius);
            } else {
                STATE.geofenceCircle = L.circle(centerLatLng, {
                    color: '#ff004c', fillColor: '#ff004c', fillOpacity: 0.1,
                    radius: STATE.geofenceRadius, weight: 2, dashArray: '5, 5'
                }).addTo(STATE.mapInstance);
            }
        } else if (STATE.geofenceCircle) {
            STATE.mapInstance.removeLayer(STATE.geofenceCircle);
            STATE.geofenceCircle = null;
        }

        const currentIds = STATE.group.map(p => p.id);
        for (let id in STATE.mapMarkers) {
            if (!currentIds.includes(id)) { STATE.mapInstance.removeLayer(STATE.mapMarkers[id]); delete STATE.mapMarkers[id]; }
        }

        STATE.group.forEach(p => {
            if (p.lat !== null && p.lon !== null) {
                if (STATE.mapMarkers[p.id]) { STATE.mapMarkers[p.id].setLatLng([p.lat, p.lon]); } 
                else {
                    const isAdmin = (p.role === 'admin' || p.role === 'creator');
                    const iconHtml = `<svg width="30" height="30" viewBox="0 0 24 24" fill="${isAdmin ? '#ff004c' : (p.id === STATE.liveTrackingId ? '#ffcc00' : '#00e5ff')}"><circle cx="12" cy="12" r="10" stroke="#fff" stroke-width="2"/></svg>`;
                    const divIcon = L.divIcon({ className: 'tactical-marker', html: iconHtml, iconSize: [30,30] });
                    STATE.mapMarkers[p.id] = L.marker([p.lat, p.lon], { icon: divIcon }).addTo(STATE.mapInstance).bindPopup(`<b>${isAdmin ? '👑 ' : ''}${Utils.escapeHtml(p.name)}</b><br>${Utils.escapeHtml(p.designation)}`);
                }
            }
        });
    }

    if (typeof L !== "undefined") setTimeout(renderMap, 500);

    // ==========================================
    // 13. BOOT SEQUENCE
    // ==========================================
    // Inject stored values on load safely
    const trySetVal = (id, val) => { const el = getDOM(id); if (el && val !== undefined) el.value = val; };
    trySetVal("limitInput", localSettings.limit);
    trySetVal("dropInput", localSettings.dropThreshold);
    trySetVal("windowInput", localSettings.dropWindow);
    trySetVal("floorInput", localSettings.floorHeight);
    trySetVal("ntfyTopicInput", localSettings.ntfyTopic);
    trySetVal("geofenceRadiusInput", localSettings.geofenceRadius || CONFIG.DEFAULT_GEOFENCE);
    trySetVal("manDownInput", localSettings.manDownTimer || CONFIG.DEFAULT_MANDOWN);

    function showAlert(msg) { 
        if(!DOM.alertBanner) return; 
        DOM.alertBanner.textContent = msg; 
        DOM.alertBanner.classList.add("show"); 
        DOM.alertBanner.hidden = false; 
        setTimeout(() => DOM.alertBanner.classList.remove("show"), 5000); 
    }
    
    function logEvent(msg) { 
        STATE.logs.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`); 
        if(STATE.logs.length > 30) STATE.logs.pop(); 
        if(DOM.logList) DOM.logList.innerHTML = STATE.logs.map(l => `<li class="log-item">${l}</li>`).join(""); 
    }

    initBarometer();

})();
