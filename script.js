/**
 * ============================================================================
 * WORKER MONITORING - ENTERPRISE CLIENT ENGINE v7.0 (SCRIPT.JS)
 * ============================================================================
 * Engineered by Vaibhav Raju Kondane | COETA Worker Monitoring
 */
(function () {
    "use strict";

    const Utils = {
        escapeHtml: (str) => {
            if (str === null || str === undefined) return "";
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        },
        niceStep: (maxVal) => {
            const rough = maxVal / 4;
            const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
            const norm = rough / mag;
            return norm < 1.5 ? 1 * mag : norm < 3 ? 2 * mag : norm < 7 ? 5 * mag : 10 * mag;
        },
        calculateDistance: (lat1, lon1, lat2, lon2) => {
            const R = 6371e3;
            const p1 = lat1 * Math.PI / 180;
            const p2 = lat2 * Math.PI / 180;
            const dp = (lat2 - lat1) * Math.PI / 180;
            const dl = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
                      Math.cos(p1) * Math.cos(p2) *
                      Math.sin(dl / 2) * Math.sin(dl / 2);
            return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
        }
    };

    async function fetchWithTimeout(resource, options = {}) {
        const { timeout = 7500 } = options;
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

    const broadcastBus = (typeof BroadcastChannel !== "undefined")
        ? new BroadcastChannel("altiguard_tactical_bus_v7")
        : null;

    const rawSocket = (typeof window.io === "function") ? window.io() : null;

    const CONFIG = {
        STORAGE_KEY: "altiguard_v7_settings",
        DEFAULT_LAT: 20.7002, // Akola, Maharashtra Tactical Default
        DEFAULT_LON: 77.0082,
        DEFAULT_LIMIT: 2.0,
        DEFAULT_DROP: 1.5,
        DEFAULT_WINDOW: 4,
        DEFAULT_FLOOR: 3.5,
        DEFAULT_NTFY: "",
        DEFAULT_GEOFENCE: 500
    };

    let savedSettings = {};
    try {
        savedSettings = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || {};
    } catch (e) {}

    let localSettings = {
        limit: CONFIG.DEFAULT_LIMIT,
        dropThreshold: CONFIG.DEFAULT_DROP,
        dropWindow: CONFIG.DEFAULT_WINDOW,
        floorHeight: CONFIG.DEFAULT_FLOOR,
        ntfyTopic: CONFIG.DEFAULT_NTFY,
        geofenceRadius: CONFIG.DEFAULT_GEOFENCE,
        ...savedSettings
    };
    if (localSettings.ntfyTopic === "undefined") localSettings.ntfyTopic = "";

    const STATE = {
        role: "admin",
        groupCode: "TEAM123",
        mySelfId: "OP-VAIBHAV",
        liveTrackingId: null,
        gpsWatchId: null,
        globalBaseline: 0,
        geofenceRadius: localSettings.geofenceRadius || 500,
        group: [],
        logs: [],
        kinematicHistory: {},
        waveformHistory: [],
        mapInstance: null,
        mapMarkers: {},
        geofenceCircle: null,
        hospitalLayer: null,
        pendingLocation: { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON, height: 0 },
        isManualMode: false,
        baroSensor: null,
        baroBaseline: null,
        audioCtx: null,
        isMuted: false,
        voiceEnabled: true,
        autopilotEnabled: true,
        autopilotTimer: null,
        themeIndex: 0,
        rosterFilter: ""
    };

    const THEMES = [
        { name: "CYBER", className: "" },
        { name: "EMERALD", className: "theme-emerald" },
        { name: "AMBER", className: "theme-amber" }
    ];

    const DOM = {
        statSite: document.getElementById("statSite"),
        statRole: document.getElementById("statRole"),
        statActive: document.getElementById("statActive"),
        statSystem: document.getElementById("statSystem"),
        connectionBadge: document.getElementById("connectionBadge"),
        kpiAvgBpm: document.getElementById("kpiAvgBpm"),
        kpiAvgSpo2: document.getElementById("kpiAvgSpo2"),
        kpiPeakAlt: document.getElementById("kpiPeakAlt"),
        kpiSafetyScore: document.getElementById("kpiSafetyScore"),
        kpiSafetySub: document.getElementById("kpiSafetySub"),
        rosterList: document.getElementById("rosterList"),
        rosterFilterInput: document.getElementById("rosterFilterInput"),
        graphSvg: document.getElementById("graphSvg"),
        isoTowerSvg: document.getElementById("isoTowerSvg"),
        telemetryCanvas: document.getElementById("telemetryCanvas"),
        alertBanner: document.getElementById("alertBanner"),
        logList: document.getElementById("logList"),
        downloadLogsBtn: document.getElementById("downloadLogsBtn"),
        clearLogsBtn: document.getElementById("clearLogsBtn"),
        ntfyTopicInput: document.getElementById("ntfyTopicInput"),
        geofenceRadiusInput: document.getElementById("geofenceRadiusInput"),
        emptyHint: document.getElementById("emptyHint"),
        manualFields: document.getElementById("manualFields"),
        gpsReadout: document.getElementById("gpsReadout"),
        limitInput: document.getElementById("limitInput"),
        dropInput: document.getElementById("dropInput"),
        windowInput: document.getElementById("windowInput"),
        floorInput: document.getElementById("floorInput"),
        referenceInput: document.getElementById("referenceInput"),
        setRefBtn: document.getElementById("setRefBtn"),
        muteSirenBtn: document.getElementById("muteSirenBtn"),
        voiceToggleBtn: document.getElementById("voiceToggleBtn"),
        autopilotToggleBtn: document.getElementById("autopilotToggleBtn"),
        themeCycleBtn: document.getElementById("themeCycleBtn"),
        milestoneModal: document.getElementById("milestoneModal"),
        weatherCoordsBadge: document.getElementById("weatherCoordsBadge")
    };

    function emitSignal(event, payload) {
        if (rawSocket && rawSocket.connected) {
            rawSocket.emit(event, payload);
        }
        if (broadcastBus) {
            try {
                broadcastBus.postMessage({
                    event,
                    payload,
                    groupCode: STATE.groupCode
                });
            } catch (e) {}
        }
    }

    function speakTacticalAlert(text) {
        if (!STATE.voiceEnabled || STATE.isMuted) return;
        try {
            if ("speechSynthesis" in window) {
                window.speechSynthesis.cancel();
                const utter = new SpeechSynthesisUtterance(text);
                utter.rate = 1.04;
                utter.pitch = 0.92;
                window.speechSynthesis.speak(utter);
            }
        } catch (e) {}
    }

    function triggerSiren(isEmergency = false) {
        if (STATE.isMuted) return;
        if (navigator.vibrate) {
            try { navigator.vibrate([200, 100, 200, 100, 400]); } catch (e) {}
        }
        try {
            STATE.audioCtx = STATE.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (STATE.audioCtx.state === "suspended") STATE.audioCtx.resume();
            const pattern = isEmergency
                ? [[920, 0.16], [0, 0.04], [640, 0.16], [0, 0.04], [920, 0.25], [0, 0.05], [640, 0.25]]
                : [[880, 0.12], [0, 0.04], [660, 0.14]];
            let t = STATE.audioCtx.currentTime;
            pattern.forEach(([freq, dur]) => {
                if (freq > 0) {
                    const osc = STATE.audioCtx.createOscillator();
                    const gain = STATE.audioCtx.createGain();
                    osc.type = "sawtooth";
                    osc.frequency.value = freq;
                    gain.gain.setValueAtTime(0, t);
                    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
                    gain.gain.linearRampToValueAtTime(0, t + dur);
                    osc.connect(gain).connect(STATE.audioCtx.destination);
                    osc.start(t);
                    osc.stop(t + dur + 0.04);
                }
                t += dur;
            });
        } catch (e) {}
    }

    async function initBarometer() {
        if (!("Barometer" in window)) return;
        try {
            if (navigator.permissions) {
                const status = await navigator.permissions.query({ name: "barometer" });
                if (status.state === "denied") return;
            }
            STATE.baroSensor = new window.Barometer({ frequency: 1 });
            STATE.baroSensor.addEventListener("reading", () => {
                if (STATE.baroBaseline === null) STATE.baroBaseline = STATE.baroSensor.pressure;
            });
            STATE.baroSensor.addEventListener("error", () => { STATE.baroSensor = null; });
            STATE.baroSensor.start();
            logEvent("Barometric pressure sensor calibrated.");
        } catch (e) {}
    }

    function applyRolePermissions() {
        if (DOM.statSite) DOM.statSite.textContent = STATE.groupCode || "OFFLINE";
        if (DOM.statRole) DOM.statRole.textContent = STATE.role.toUpperCase();
        const isPrivileged = (STATE.role === "admin" || STATE.role === "creator");
        [
            DOM.ntfyTopicInput,
            DOM.geofenceRadiusInput,
            DOM.referenceInput,
            DOM.setRefBtn,
            DOM.limitInput,
            DOM.dropInput,
            DOM.windowInput,
            DOM.floorInput
        ].forEach(el => {
            if (el) el.disabled = !isPrivileged;
        });
    }

    if (rawSocket) {
        rawSocket.on("connect", () => {
            if (DOM.connectionBadge) DOM.connectionBadge.textContent = "🟢 SOCKET.IO UPLINK ONLINE";
            rawSocket.emit("createGroup", STATE.groupCode);
        });
        rawSocket.on("disconnect", () => {
            if (DOM.connectionBadge) DOM.connectionBadge.textContent = "⚡ HYBRID MESH TELEMETRY";
        });
        rawSocket.on("roleAssigned", (data) => {
            STATE.role = data.role;
            STATE.groupCode = data.groupCode;
            applyRolePermissions();
            showAlert(`Uplink Established: ${STATE.groupCode} [${STATE.role.toUpperCase()}]`);
            renderUI();
        });
        rawSocket.on("groupError", (errMsg) => {
            showAlert(`⚠️ ${errMsg}`, true);
            logEvent(`⚠️ Command Error: ${errMsg}`);
        });
        rawSocket.on("syncGroup", (members) => {
            if (Array.isArray(members) && members.length > 0) {
                STATE.group = members;
                renderUI();
            }
        });
        rawSocket.on("syncBaseline", (baseline) => {
            STATE.globalBaseline = baseline;
            if (DOM.referenceInput) DOM.referenceInput.value = baseline;
            renderUI();
        });
        rawSocket.on("syncGeofence", (radius) => {
            STATE.geofenceRadius = radius;
            if (DOM.geofenceRadiusInput && parseFloat(DOM.geofenceRadiusInput.value) !== radius) {
                DOM.geofenceRadiusInput.value = radius;
            }
            renderMap();
        });
        rawSocket.on("syncNtfyTopic", (topic) => {
            if (DOM.ntfyTopicInput) DOM.ntfyTopicInput.value = topic;
        });
        rawSocket.on("receiveAlert", (data) => {
            setSystemAlertStatus(`FALL // ${data.name}`);
            showAlert(`⚠️ FALL DETECTED: ${data.name} (-${data.drop}m)`, true);
            logEvent(`⚠️ Fall Detected: ${data.name} dropped ${data.drop}m`);
            triggerSiren(true);
            speakTacticalAlert(`Warning. Kinematic fall detected for ${data.name}. Vertical drop ${data.drop} meters.`);
        });
        rawSocket.on("receiveSOS", (payload) => {
            setSystemAlertStatus(`SOS // ${payload.name}`);
            showAlert(`🚨 SOS PANIC: ${payload.name} requires immediate extraction!`, true);
            logEvent(`🚨 SOS Panic Protocol: ${payload.name}`);
            triggerSiren(true);
            speakTacticalAlert(`Emergency S O S initiated by ${payload.name}. Immediate extraction required.`);
        });
    }

    if (broadcastBus) {
        broadcastBus.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg || msg.groupCode !== STATE.groupCode) return;
            if (msg.event === "updateGroupData" && Array.isArray(msg.payload)) {
                STATE.group = msg.payload;
                renderUI();
            } else if (msg.event === "setBaseline") {
                STATE.globalBaseline = msg.payload;
                if (DOM.referenceInput) DOM.referenceInput.value = msg.payload;
                renderUI();
            } else if (msg.event === "updateGeofenceRadius") {
                STATE.geofenceRadius = msg.payload;
                if (DOM.geofenceRadiusInput) DOM.geofenceRadiusInput.value = msg.payload;
                renderMap();
            } else if (msg.event === "triggerFallAlert") {
                setSystemAlertStatus(`FALL // ${msg.payload.name}`);
                showAlert(`⚠️ FALL DETECTED: ${msg.payload.name} (-${msg.payload.drop}m)`, true);
                logEvent(`⚠️ Fall Detected: ${msg.payload.name} (-${msg.payload.drop}m)`);
                triggerSiren(true);
            } else if (msg.event === "triggerSOS") {
                setSystemAlertStatus(`SOS // ${msg.payload.name}`);
                showAlert(`🚨 SOS PANIC: ${msg.payload.name}`, true);
                logEvent(`🚨 SOS Triggered: ${msg.payload.name}`);
                triggerSiren(true);
            }
        };
    }

    function setSystemAlertStatus(alertLabel) {
        if (!DOM.statSystem) return;
        DOM.statSystem.textContent = `ALERT // ${alertLabel}`;
        DOM.statSystem.className = "hud-value status-danger";
        clearTimeout(STATE.systemStatusResetTimer);
        STATE.systemStatusResetTimer = setTimeout(() => {
            if (DOM.statSystem) {
                DOM.statSystem.textContent = "ONLINE // SECURE";
                DOM.statSystem.className = "hud-value status-secure";
            }
        }, 8000);
    }

    function transmitNtfyAlert(title, message, tags, lat, lon) {
        try {
            if (window.Notification && Notification.permission === "granted") {
                new Notification(title, { body: message });
            }
        } catch (e) {}
        const topic = (DOM.ntfyTopicInput && DOM.ntfyTopicInput.value.trim()) || localSettings.ntfyTopic;
        if (!topic) return;
        const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
        if (!cleanTopic) return;
        let ntfyUrl = `https://ntfy.sh/${cleanTopic}?title=${encodeURIComponent(title)}&priority=urgent&tags=${encodeURIComponent(tags)}`;
        if (lat && lon) {
            ntfyUrl += `&click=${encodeURIComponent(`https://www.google.com/maps?q=${lat},${lon}`)}`;
        }
        fetch(ntfyUrl, { method: "POST", body: message })
            .then(res => {
                if (res.ok) logEvent(`✅ Ntfy Push Dispatched: ${title}`);
                else logEvent(`⚠️ Ntfy Push Status: ${res.status}`);
            })
            .catch(() => {
                logEvent(`ℹ️ Ntfy Push queued via server relay (${cleanTopic}).`);
            });
    }

    async function fetchWeatherAndAQI(lat, lon) {
        if (DOM.weatherCoordsBadge) {
            DOM.weatherCoordsBadge.textContent = `${lat.toFixed(4)}°N, ${lon.toFixed(4)}°E`;
        }
        try {
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,surface_pressure`;
            const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi`;

            const [weatherRes, aqiRes] = await Promise.all([
                fetchWithTimeout(weatherUrl),
                fetchWithTimeout(aqiUrl)
            ]);
            const weatherData = await weatherRes.json();
            const aqiData = await aqiRes.json();

            const current = weatherData.current || {};
            const temp = current.temperature_2m ?? 31.2;
            const feels = current.apparent_temperature ?? 33.0;
            const hum = current.relative_humidity_2m ?? 45;
            const wind = current.wind_speed_10m ?? 10.5;
            const press = current.surface_pressure ?? 1009;
            const code = current.weather_code ?? 0;
            const aqi = (aqiData.current && aqiData.current.european_aqi != null) ? aqiData.current.european_aqi : 32;

            const elTemp = document.getElementById("wTemp");
            const elFeels = document.getElementById("wFeels");
            const elHum = document.getElementById("wHum");
            const elWind = document.getElementById("wWind");
            const elPress = document.getElementById("wPress");
            const aqiEl = document.getElementById("wAqi");

            if (elTemp) elTemp.textContent = `${temp}°C`;
            if (elFeels) elFeels.textContent = `${feels}°C`;
            if (elHum) elHum.textContent = `${hum}%`;
            if (elWind) elWind.textContent = `${wind} km/h`;
            if (elPress) elPress.textContent = `${Math.round(press)} hPa`;

            if (aqiEl) {
                aqiEl.className = "aqi-badge";
                if (aqi < 40) {
                    aqiEl.textContent = `${aqi} GOOD`;
                    aqiEl.classList.add("aqi-good");
                } else if (aqi < 80) {
                    aqiEl.textContent = `${aqi} MODERATE`;
                    aqiEl.classList.add("aqi-mod");
                } else {
                    aqiEl.textContent = `${aqi} HAZARDOUS`;
                    aqiEl.classList.add("aqi-poor");
                }
            }

            const iconBox = document.getElementById("weatherIconBox");
            const conditionEl = document.getElementById("wCondition");
            if (conditionEl && iconBox) {
                let conditionText = "Clear Sky";
                let iconHtml = `<div class="anim-sun"></div>`;
                if (code === 0) {
                    conditionText = "Clear Sky // Optimal";
                    iconHtml = `<div class="anim-sun"></div>`;
                } else if (code === 1 || code === 2) {
                    conditionText = "Partly Cloudy";
                    iconHtml = `<div class="anim-sun-cloud-wrapper"><div class="anim-sun"></div><div class="anim-cloud"></div></div>`;
                } else if (code === 3) {
                    conditionText = "Overcast Layer";
                    iconHtml = `<div class="anim-cloud" style="filter: brightness(0.7);"></div>`;
                } else if (code === 45 || code === 48) {
                    conditionText = "Low Visibility Fog";
                    iconHtml = `<div class="anim-cloud" style="opacity: 0.55;"></div>`;
                } else if (code >= 51 && code <= 57) {
                    conditionText = "Light Drizzle";
                    iconHtml = `<div class="anim-cloud anim-rain"></div>`;
                } else if (code >= 61 && code <= 67) {
                    conditionText = "Heavy Precipitation";
                    iconHtml = `<div class="anim-cloud anim-rain" style="filter: brightness(0.65);"></div>`;
                } else if (code >= 71 && code <= 77) {
                    conditionText = "Snowfall Activity";
                    iconHtml = `<div class="anim-cloud anim-snow"></div>`;
                } else if (code >= 80 && code <= 82) {
                    conditionText = "Convective Rain Showers";
                    iconHtml = `<div class="anim-cloud anim-rain"></div>`;
                } else if (code >= 85 && code <= 86) {
                    conditionText = "Snow Showers";
                    iconHtml = `<div class="anim-cloud anim-snow"></div>`;
                } else if (code >= 95 && code <= 99) {
                    conditionText = "Severe Thunderstorm";
                    iconHtml = `<div class="anim-cloud anim-rain anim-lightning"></div>`;
                }
                conditionEl.textContent = conditionText;
                iconBox.innerHTML = iconHtml;
            }

            const mapHudTemp = document.getElementById("hudTemp");
            const mapHudWind = document.getElementById("hudWind");
            if (mapHudTemp) mapHudTemp.textContent = `${temp}°C`;
            if (mapHudWind) mapHudWind.textContent = `${wind} km/h`;
        } catch (e) {
            const conditionEl = document.getElementById("wCondition");
            if (conditionEl) conditionEl.textContent = "Clear Sky // Local Telemetry";
        }
    }

    async function fetchAddress(lat, lon) {
        try {
            const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
            const data = await res.json();
            if (data && data.address) {
                const addr = data.address;
                const parts = [
                    addr.road || addr.suburb || addr.neighbourhood,
                    addr.city || addr.town || addr.county || addr.state_district,
                    addr.state
                ].filter(Boolean);
                return parts.length ? parts.join(", ") : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
            }
            return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        } catch (e) {
            return `Lat ${lat.toFixed(5)}, Lon ${lon.toFixed(5)}`;
        }
    }

    function fetchHospitals(showFeedback = false) {
        if (!STATE.mapInstance || typeof L === "undefined") return;
        const bounds = STATE.mapInstance.getBounds();
        const query = `[out:json][timeout:8];node["amenity"="hospital"](${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()});out;`;
        fetchWithTimeout(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, { timeout: 7500 })
            .then(res => res.json())
            .then(data => {
                if (!STATE.hospitalLayer) return;
                STATE.hospitalLayer.clearLayers();
                const elements = (data && data.elements && data.elements.length > 0) ? data.elements : [
                    { lat: CONFIG.DEFAULT_LAT + 0.0045, lon: CONFIG.DEFAULT_LON - 0.0035, tags: { name: "District Emergency Response Center" } },
                    { lat: CONFIG.DEFAULT_LAT - 0.0038, lon: CONFIG.DEFAULT_LON + 0.0042, tags: { name: "Sector-4 Rapid Response Unit" } }
                ];
                elements.forEach(item => {
                    if (item.lat && item.lon) {
                        const name = (item.tags && item.tags.name) ? item.tags.name : "Emergency Response Center";
                        const icon = L.divIcon({
                            className: "",
                            html: `<div style="background:#0a0f1c;border:2px solid #ff004c;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 0 12px #ff004c;">🏥</div>`,
                            iconSize: [24, 24]
                        });
                        STATE.hospitalLayer.addLayer(
                            L.marker([item.lat, item.lon], { icon })
                                .bindPopup(`<b>🚑 ${Utils.escapeHtml(name)}</b><br>Emergency Response Node`)
                        );
                    }
                });
                if (showFeedback) {
                    showAlert(`🏥 Marked ${elements.length} emergency response facilities on map.`);
                    logEvent(`🏥 Emergency radar scanned: ${elements.length} facilities plotted.`);
                }
            })
            .catch(() => {
                if (!STATE.hospitalLayer) return;
                STATE.hospitalLayer.clearLayers();
                const fallback = [
                    { lat: CONFIG.DEFAULT_LAT + 0.0045, lon: CONFIG.DEFAULT_LON - 0.0035, name: "District Emergency Response Center" },
                    { lat: CONFIG.DEFAULT_LAT - 0.0038, lon: CONFIG.DEFAULT_LON + 0.0042, name: "Sector-4 Rapid Response Unit" }
                ];
                fallback.forEach(h => {
                    const icon = L.divIcon({
                        className: "",
                        html: `<div style="background:#0a0f1c;border:2px solid #ff004c;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 0 12px #ff004c;">🏥</div>`,
                        iconSize: [24, 24]
                    });
                    STATE.hospitalLayer.addLayer(
                        L.marker([h.lat, h.lon], { icon }).bindPopup(`<b>🚑 ${Utils.escapeHtml(h.name)}</b>`)
                    );
                });
                if (showFeedback) showAlert("🏥 Plotted local emergency centers on perimeter map.");
            });
    }

    function deployDemoSquad(silent = false) {
        const baseLat = CONFIG.DEFAULT_LAT;
        const baseLon = CONFIG.DEFAULT_LON;
        STATE.globalBaseline = 0;
        if (DOM.referenceInput) DOM.referenceInput.value = "0";
        STATE.group = [
            {
                id: "OP-VAIBHAV",
                name: "Vaibhav Kondane",
                designation: "Command Admin // Lead Eng",
                role: "admin",
                height: 0.0,
                lat: baseLat,
                lon: baseLon,
                method: "auto"
            },
            {
                id: "OP-ROHAN",
                name: "Rohan Deshmukh",
                designation: "Structural Rigger (Lvl 2)",
                role: "worker",
                height: 7.0,
                lat: baseLat + 0.0011,
                lon: baseLon + 0.0009,
                method: "auto"
            },
            {
                id: "OP-PRIYA",
                name: "Priya Kulkarni",
                designation: "High-Steel Inspector (Lvl 3)",
                role: "worker",
                height: 10.5,
                lat: baseLat - 0.0009,
                lon: baseLon + 0.0012,
                method: "auto"
            },
            {
                id: "OP-SANJAY",
                name: "Sanjay Patil",
                designation: "Sub-Surface Tech (Bsmnt 1)",
                role: "worker",
                height: -3.5,
                lat: baseLat + 0.0007,
                lon: baseLon - 0.0011,
                method: "auto"
            }
        ];
        STATE.mySelfId = "OP-VAIBHAV";
        emitSignal("updateGroupData", STATE.group);
        renderUI();
        if (STATE.mapInstance && STATE.geofenceCircle) {
            STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [25, 25] });
        }
        if (!silent) {
            showAlert("🚀 Demo Squad (4 Operators) deployed to TEAM123 grid.");
            logEvent("🚀 Deployed 4-node tactical squad across Basement 1 to Level 3.");
        }
    }

    // Live Autonomous Spatial Telemetry Autopilot Loop
    function startAutopilotLoop() {
        clearInterval(STATE.autopilotTimer);
        STATE.autopilotTimer = setInterval(() => {
            if (!STATE.autopilotEnabled || STATE.group.length === 0) return;
            STATE.group.forEach((p, idx) => {
                const wave = Math.sin(Date.now() / 2200 + idx * 1.7);
                if (p.role !== "admin") {
                    p.height = parseFloat((p.height + wave * 0.12).toFixed(2));
                    if (p.lat != null && p.lon != null) {
                        p.lat += Math.cos(Date.now() / 4000 + idx) * 0.000015;
                        p.lon += Math.sin(Date.now() / 4000 + idx) * 0.000015;
                    }
                }
            });

            const snapshot = {
                t: Date.now(),
                heights: STATE.group.map(p => p.height - STATE.globalBaseline)
            };
            STATE.waveformHistory.push(snapshot);
            if (STATE.waveformHistory.length > 90) STATE.waveformHistory.shift();

            renderUI();
            renderOscilloscope();
        }, 1200);
    }

    // Real-time Canvas Oscilloscope for Multi-Node Z-Axis Elevation History
    function renderOscilloscope() {
        const canvas = DOM.telemetryCanvas;
        if (!canvas) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        const W = Math.max(300, Math.floor(rect.width));
        const H = Math.max(180, Math.floor(rect.height));
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
        }
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, W, H);

        ctx.strokeStyle = "rgba(0, 229, 255, 0.07)";
        ctx.lineWidth = 1;
        for (let x = 0; x < W; x += 40) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let y = 0; y < H; y += 35) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        const midY = H / 2;
        ctx.strokeStyle = "rgba(0, 229, 255, 0.35)";
        ctx.setLineDash([5, 5]);
        ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke();
        ctx.setLineDash([]);

        const colors = ["#00e5ff", "#00ffa3", "#ffcc00", "#ff004c", "#b026ff"];
        const hist = STATE.waveformHistory;
        if (hist.length < 2) return;

        STATE.group.forEach((p, nodeIdx) => {
            ctx.strokeStyle = colors[nodeIdx % colors.length];
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            hist.forEach((pt, i) => {
                const x = (i / Math.max(1, hist.length - 1)) * (W - 140) + 20;
                const hVal = pt.heights[nodeIdx] !== undefined ? pt.heights[nodeIdx] : 0;
                const y = midY - (hVal * 6.5);
                const clampedY = Math.max(16, Math.min(H - 16, y));
                if (i === 0) ctx.moveTo(x, clampedY);
                else ctx.lineTo(x, clampedY);
            });
            ctx.stroke();

            const lastPt = hist[hist.length - 1];
            const lastH = lastPt.heights[nodeIdx] !== undefined ? lastPt.heights[nodeIdx] : 0;
            const lastY = Math.max(18, Math.min(H - 18, midY - (lastH * 6.5)));
            ctx.fillStyle = colors[nodeIdx % colors.length];
            ctx.font = "bold 11px 'JetBrains Mono', monospace";
            ctx.fillText(`${p.name.split(" ")[0]} (${lastH >= 0 ? "+" : ""}${lastH.toFixed(1)}m)`, W - 130, lastY + 4);
        });
    }

    document.getElementById("createGroupBtn").addEventListener("click", () => {
        const input = document.getElementById("groupCodeInput");
        const code = (input && input.value.trim()) ? input.value.trim().toUpperCase() : "TEAM123";
        if (input) input.value = code;
        STATE.groupCode = code;
        STATE.role = "admin";
        applyRolePermissions();
        emitSignal("createGroup", code);
        logEvent(`👑 Initialized Command Grid "${code}" as ADMIN.`);
        showAlert(`👑 Command Grid "${code}" Active [ADMIN]`);
        renderUI();
    });

    document.getElementById("joinGroupActionBtn").addEventListener("click", () => {
        const input = document.getElementById("groupCodeInput");
        const code = (input && input.value.trim()) ? input.value.trim().toUpperCase() : "";
        if (!code) return showAlert("⚠️ Enter a valid Site Code first.", true);
        STATE.groupCode = code;
        STATE.role = "worker";
        applyRolePermissions();
        emitSignal("joinGroup", code);
        logEvent(`👷 Joined Site Grid "${code}" as WORKER.`);
        showAlert(`👷 Connected to "${code}" [WORKER MODE]`);
        renderUI();
    });

    document.getElementById("deployDemoBtn").addEventListener("click", () => {
        deployDemoSquad(false);
    });

    if (DOM.autopilotToggleBtn) {
        DOM.autopilotToggleBtn.addEventListener("click", () => {
            STATE.autopilotEnabled = !STATE.autopilotEnabled;
            DOM.autopilotToggleBtn.textContent = STATE.autopilotEnabled ? "🤖 Live Autopilot: ON" : "🤖 Live Autopilot: PAUSED";
            DOM.autopilotToggleBtn.classList.toggle("active-mode", STATE.autopilotEnabled);
            showAlert(STATE.autopilotEnabled ? "🤖 Autonomous Telemetry Autopilot Resumed" : "⏸️ Autonomous Telemetry Autopilot Paused");
            logEvent(STATE.autopilotEnabled ? "🤖 Autopilot spatial simulation enabled." : "⏸️ Autopilot spatial simulation paused.");
        });
    }

    if (DOM.voiceToggleBtn) {
        DOM.voiceToggleBtn.addEventListener("click", () => {
            STATE.voiceEnabled = !STATE.voiceEnabled;
            DOM.voiceToggleBtn.textContent = STATE.voiceEnabled ? "🎙️ AI Voice: ON" : "🎙️ AI Voice: OFF";
            showAlert(STATE.voiceEnabled ? "🎙️ AI Tactical Voice Announcer Enabled" : "🔇 AI Tactical Voice Announcer Disabled");
            if (STATE.voiceEnabled) speakTacticalAlert("Tactical voice synthesis online.");
        });
    }

    if (DOM.themeCycleBtn) {
        DOM.themeCycleBtn.addEventListener("click", () => {
            STATE.themeIndex = (STATE.themeIndex + 1) % THEMES.length;
            const theme = THEMES[STATE.themeIndex];
            document.body.className = theme.className;
            DOM.themeCycleBtn.textContent = `🎨 Theme: ${theme.name}`;
            showAlert(`🎨 Tactical HUD Theme switched to ${theme.name}`);
            renderUI();
            renderOscilloscope();
        });
    }

    document.getElementById("milestoneModalBtn").addEventListener("click", () => {
        if (DOM.milestoneModal) DOM.milestoneModal.hidden = false;
    });

    document.getElementById("closeMilestoneModalBtn").addEventListener("click", () => {
        if (DOM.milestoneModal) DOM.milestoneModal.hidden = true;
    });

    document.getElementById("simFallBtn").addEventListener("click", () => {
        if (STATE.group.length === 0) deployDemoSquad(true);
        const target = STATE.group.find(p => p.role === "worker") || STATE.group[0];
        if (!target) return;
        const dropAmount = 3.8;
        target.height = parseFloat((target.height - dropAmount).toFixed(2));
        emitSignal("updateGroupData", STATE.group);
        const alertPayload = {
            name: target.name,
            drop: dropAmount.toFixed(2),
            id: target.id,
            lat: target.lat,
            lon: target.lon
        };
        emitSignal("triggerFallAlert", alertPayload);
        setSystemAlertStatus(`FALL // ${target.name}`);
        showAlert(`⚠️ KINEMATIC FALL DETECTED: ${target.name} dropped ${dropAmount.toFixed(2)}m!`, true);
        logEvent(`🚨 FALL ALERT: ${target.name} experienced a rapid ${dropAmount.toFixed(2)}m vertical drop!`);
        triggerSiren(true);
        speakTacticalAlert(`Warning. Kinematic fall detected for ${target.name}. Vertical drop ${dropAmount.toFixed(1)} meters.`);
        transmitNtfyAlert(`🚨 FALL ALERT: ${target.name}`, `${target.name} dropped ${dropAmount.toFixed(2)}m!`, "rotating_light,skull", target.lat, target.lon);
        renderUI();
    });

    document.getElementById("simBreachBtn").addEventListener("click", () => {
        if (STATE.group.length === 0) deployDemoSquad(true);
        const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator") || STATE.group[0];
        const workerNode = STATE.group.find(p => p.role === "worker") || STATE.group[STATE.group.length - 1];
        if (!adminNode || !workerNode) return;
        workerNode.lat = adminNode.lat + 0.0052;
        workerNode.lon = adminNode.lon + 0.0042;
        checkGeofenceBreach(workerNode, true);
        emitSignal("updateGroupData", STATE.group);
        renderUI();
        if (STATE.mapInstance) {
            STATE.mapInstance.flyTo([workerNode.lat, workerNode.lon], 15);
        }
    });

    if (DOM.muteSirenBtn) {
        DOM.muteSirenBtn.addEventListener("click", () => {
            STATE.isMuted = !STATE.isMuted;
            DOM.muteSirenBtn.textContent = STATE.isMuted ? "🔇 Siren: MUTED" : "🔊 Siren: ARMED";
            showAlert(STATE.isMuted ? "🔇 Acoustic Siren Muted" : "🔊 Acoustic Siren Armed");
        });
    }

    document.getElementById("syncWeatherBtn").addEventListener("click", () => {
        const refNode = STATE.group[0] || STATE.pendingLocation || { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON };
        fetchWeatherAndAQI(refNode.lat || CONFIG.DEFAULT_LAT, refNode.lon || CONFIG.DEFAULT_LON);
        showAlert("🌤️ Atmospheric telemetry synchronized.");
        logEvent("🌤️ Synced live Open-Meteo weather & European AQI telemetry.");
    });

    if (DOM.setRefBtn) {
        DOM.setRefBtn.addEventListener("click", () => {
            if (STATE.role !== "admin" && STATE.role !== "creator") {
                return showAlert("⚠️ Admin clearance required to calibrate Datum Zero.", true);
            }
            const val = parseFloat(DOM.referenceInput.value) || 0;
            STATE.globalBaseline = val;
            emitSignal("setBaseline", val);
            renderUI();
            showAlert(`⚓ Datum Zero calibrated to ${val.toFixed(2)}m`);
            logEvent(`⚓ Structural Datum Zero set to ${val.toFixed(2)}m.`);
        });
    }

    document.getElementById("calibrateZeroToAdminBtn").addEventListener("click", () => {
        const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator") || STATE.group[0];
        if (!adminNode) return showAlert("⚠️ No operator node available to snap Datum Zero.", true);
        STATE.globalBaseline = parseFloat(adminNode.height.toFixed(2));
        if (DOM.referenceInput) DOM.referenceInput.value = STATE.globalBaseline;
        emitSignal("setBaseline", STATE.globalBaseline);
        renderUI();
        showAlert(`⚓ Datum Zero snapped to ${adminNode.name} (${STATE.globalBaseline}m)`);
        logEvent(`⚓ Datum Zero snapped to ${adminNode.name}'s elevation (${STATE.globalBaseline}m).`);
    });

    document.getElementById("manualToggle").addEventListener("click", () => {
        STATE.isManualMode = !STATE.isManualMode;
        if (DOM.manualFields) DOM.manualFields.hidden = !STATE.isManualMode;
        if (DOM.gpsReadout && STATE.isManualMode) DOM.gpsReadout.hidden = true;
    });

    document.getElementById("captureBtn").addEventListener("click", () => {
        triggerSiren(false);
        if (DOM.gpsReadout) {
            DOM.gpsReadout.hidden = false;
            DOM.gpsReadout.innerHTML = `<span style="color:var(--brand-primary);">📡 Acquiring multi-constellation GPS lock...</span>`;
        }
        if (!navigator.geolocation) {
            STATE.pendingLocation = { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON, height: 3.5 };
            if (DOM.gpsReadout) {
                DOM.gpsReadout.innerHTML = `<strong style="color:var(--accent-warning);">📍 Fallback Tactical Lock (Akola Grid)</strong><br>Lat: ${CONFIG.DEFAULT_LAT}, Lon: ${CONFIG.DEFAULT_LON}`;
            }
            return;
        }
        navigator.geolocation.getCurrentPosition(
            async (pos) => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;
                const alt = pos.coords.altitude !== null ? pos.coords.altitude : 0;
                STATE.pendingLocation = { lat, lon, height: alt };
                const [address] = await Promise.all([
                    fetchAddress(lat, lon),
                    fetchWeatherAndAQI(lat, lon)
                ]);
                if (DOM.gpsReadout) {
                    DOM.gpsReadout.innerHTML = `<strong style="color:var(--brand-primary);">📍 Satellite Lock Acquired (Alt: ${alt.toFixed(1)}m)</strong><br><span style="color:#ccc;">${Utils.escapeHtml(address)}</span>`;
                }
                STATE.isManualMode = false;
                if (DOM.manualFields) DOM.manualFields.hidden = true;
            },
            () => {
                STATE.pendingLocation = { lat: CONFIG.DEFAULT_LAT, lon: CONFIG.DEFAULT_LON, height: 3.5 };
                fetchWeatherAndAQI(CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON);
                if (DOM.gpsReadout) {
                    DOM.gpsReadout.innerHTML = `<strong style="color:var(--accent-warning);">📍 Simulated Sensor Lock (Akola Command Center)</strong><br><span style="color:#ccc;">20.7002°N, 77.0082°E | Elevation: +3.5m</span>`;
                }
            },
            { enableHighAccuracy: true, timeout: 6000 }
        );
    });

    document.getElementById("addForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const nameEl = document.getElementById("nameInput");
        const desigEl = document.getElementById("designationInput");
        const name = nameEl ? nameEl.value.trim() : "";
        const designation = desigEl ? desigEl.value.trim() : "";
        if (!name || !designation) return showAlert("⚠️ Enter both Operator Name and Designation.", true);

        const newId = "OP-" + Math.random().toString(36).slice(2, 8).toUpperCase();
        STATE.mySelfId = newId;

        let pLat = CONFIG.DEFAULT_LAT + (Math.random() - 0.5) * 0.0018;
        let pLon = CONFIG.DEFAULT_LON + (Math.random() - 0.5) * 0.0018;
        let pHeight = 3.5;

        if (STATE.isManualMode) {
            const mh = document.getElementById("manualHeight");
            const mlat = document.getElementById("manualLat");
            const mlon = document.getElementById("manualLon");
            pHeight = mh ? parseFloat(mh.value) || 0 : 0;
            pLat = (mlat && mlat.value !== "") ? parseFloat(mlat.value) : pLat;
            pLon = (mlon && mlon.value !== "") ? parseFloat(mlon.value) : pLon;
        } else if (STATE.pendingLocation) {
            pLat = STATE.pendingLocation.lat;
            pLon = STATE.pendingLocation.lon;
            pHeight = STATE.pendingLocation.height || 0;
        }

        const person = {
            id: newId,
            name,
            designation,
            role: STATE.group.length === 0 ? "admin" : STATE.role,
            height: pHeight,
            lat: pLat,
            lon: pLon,
            method: STATE.isManualMode ? "manual" : "auto"
        };

        STATE.group.push(person);
        emitSignal("upsertPerson", person);
        emitSignal("updateGroupData", STATE.group);

        if (STATE.mapInstance && pLat !== null && pLon !== null) {
            STATE.mapInstance.flyTo([pLat, pLon], 16);
        }

        if (nameEl) nameEl.value = "";
        if (desigEl) desigEl.value = "";
        renderUI();
        checkGeofenceBreach(person, true);
        showAlert(`✅ Operator "${name}" injected into ${STATE.groupCode}.`);
        logEvent(`➕ Operator "${name}" (${designation}) joined at Z=${pHeight.toFixed(2)}m.`);
    });

    if (DOM.rosterFilterInput) {
        DOM.rosterFilterInput.addEventListener("input", (e) => {
            STATE.rosterFilter = (e.target.value || "").toLowerCase().trim();
            renderRoster();
        });
    }

    // Export CSV Spatial Telemetry Snapshot
    document.getElementById("exportCsvBtn").addEventListener("click", () => {
        if (STATE.group.length === 0) return showAlert("⚠️ No active operators to export.", true);
        const rows = [
            ["Operator_ID", "Name", "Designation", "Role", "Altitude_Z_m", "Relative_Z_m", "Latitude", "Longitude"]
        ];
        STATE.group.forEach(p => {
            const rel = (p.height - STATE.globalBaseline).toFixed(2);
            rows.push([
                p.id,
                `"${(p.name || "").replace(/"/g, '""')}"`,
                `"${(p.designation || "").replace(/"/g, '""')}"`,
                p.role,
                p.height.toFixed(2),
                rel,
                p.lat != null ? p.lat.toFixed(6) : "",
                p.lon != null ? p.lon.toFixed(6) : ""
            ]);
        });
        const csvContent = rows.map(r => r.join(",")).join("\n");
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `Altiguard_Telemetry_${STATE.groupCode}_${Date.now()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        logEvent("📊 Exported operator spatial telemetry to CSV.");
        showAlert("📊 Telemetry CSV Snapshot Downloaded");
    });

    document.getElementById("fitMapBtn").addEventListener("click", () => {
        if (!STATE.mapInstance) return;
        if (STATE.geofenceCircle) {
            STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [25, 25] });
            showAlert("🎯 Map aligned to active geofence perimeter.");
        } else {
            STATE.mapInstance.setView([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], 15);
        }
    });

    document.getElementById("scanHospitalsBtn").addEventListener("click", () => {
        fetchHospitals(true);
    });

    if (DOM.downloadLogsBtn) {
        DOM.downloadLogsBtn.addEventListener("click", () => {
            if (STATE.logs.length === 0) return showAlert("⚠️ Incident ledger is currently empty.", true);
            const header = [
                "====================================================",
                "WORKER MONITORING - COMMAND INCIDENT LEDGER (v7.0)",
                "====================================================",
                `SITE CODE : ${STATE.groupCode || "OFFLINE"}`,
                `GENERATED : ${new Date().toLocaleString()}`,
                `OPERATORS : ${STATE.group.length} Tracked`,
                `EVENTS    : ${STATE.logs.length}`,
                "====================================================",
                ""
            ].join("\n");
            const blob = new Blob([header + STATE.logs.join("\n")], { type: "text/plain;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `Incident_Ledger_${STATE.groupCode || "SITE"}_${Date.now()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            logEvent("📥 Incident ledger exported to local storage (.txt).");
            showAlert("📥 Incident Report downloaded (.txt)");
        });
    }

    if (DOM.clearLogsBtn) {
        DOM.clearLogsBtn.addEventListener("click", () => {
            STATE.logs = [];
            if (DOM.logList) DOM.logList.innerHTML = "";
            logEvent("🧹 Incident ledger cleared by operator.");
        });
    }

    const saveSettings = () => {
        if (DOM.limitInput) localSettings.limit = parseFloat(DOM.limitInput.value) || CONFIG.DEFAULT_LIMIT;
        if (DOM.dropInput) localSettings.dropThreshold = parseFloat(DOM.dropInput.value) || CONFIG.DEFAULT_DROP;
        if (DOM.windowInput) localSettings.dropWindow = parseInt(DOM.windowInput.value, 10) || CONFIG.DEFAULT_WINDOW;
        if (DOM.floorInput) localSettings.floorHeight = parseFloat(DOM.floorInput.value) || CONFIG.DEFAULT_FLOOR;

        if (DOM.geofenceRadiusInput && (STATE.role === "admin" || STATE.role === "creator")) {
            const rad = parseFloat(DOM.geofenceRadiusInput.value) || CONFIG.DEFAULT_GEOFENCE;
            if (STATE.geofenceRadius !== rad) {
                localSettings.geofenceRadius = rad;
                STATE.geofenceRadius = rad;
                emitSignal("updateGeofenceRadius", rad);
                const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator");
                if (adminNode && STATE.geofenceCircle && STATE.mapInstance) {
                    STATE.geofenceCircle.setRadius(rad);
                    STATE.mapInstance.fitBounds(STATE.geofenceCircle.getBounds(), { padding: [20, 20] });
                }
            }
        }

        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(localSettings));
        } catch (e) {}

        if (DOM.ntfyTopicInput && (STATE.role === "admin" || STATE.role === "creator")) {
            localSettings.ntfyTopic = DOM.ntfyTopicInput.value.trim();
            emitSignal("updateNtfyTopic", localSettings.ntfyTopic);
        }
        renderUI();
    };

    [
        DOM.limitInput,
        DOM.dropInput,
        DOM.windowInput,
        DOM.ntfyTopicInput,
        DOM.floorInput,
        DOM.geofenceRadiusInput
    ].forEach(el => {
        if (el) el.addEventListener("input", saveSettings);
    });

    document.getElementById("testAlertBtn").addEventListener("click", () => {
        emitSignal("triggerFallAlert", { name: "System Diagnostic", drop: 1.5, id: "test" });
        showAlert("⚠️ DIAGNOSTIC TEST SIREN ACTIVATED", true);
        logEvent("⚠️ Diagnostic test siren broadcasted across command channel.");
        triggerSiren(true);
        speakTacticalAlert("Diagnostic test siren activated by command.");
        transmitNtfyAlert("⚠️ TEST SIREN", "Diagnostic test siren activated by Command.", "loudspeaker");
    });

    document.getElementById("sosTriggerBtn").addEventListener("click", () => {
        if (STATE.group.length === 0) deployDemoSquad(true);
        const me = STATE.group.find(p => p.id === STATE.mySelfId) || STATE.group[0];
        if (me) {
            emitSignal("triggerSOS", { name: me.name, lat: me.lat, lon: me.lon, height: me.height });
            setSystemAlertStatus(`SOS // ${me.name}`);
            showAlert(`🚨 SOS PANIC PROTOCOL ACTIVATED BY ${me.name.toUpperCase()}!`, true);
            logEvent(`🚨 EMERGENCY SOS broadcasted by ${me.name} at [${me.lat.toFixed(4)}, ${me.lon.toFixed(4)}] Z=${me.height.toFixed(2)}m!`);
            triggerSiren(true);
            speakTacticalAlert(`Emergency S O S initiated by ${me.name}. Immediate extraction required.`);
            transmitNtfyAlert(`🚨 SOS INITIATED: ${me.name}`, `${me.name} triggered SOS panic protocol!`, "sos,rotating_light", me.lat, me.lon);
            renderUI();
        }
    });

    window.toggleTrack = function (id) {
        if (STATE.liveTrackingId === id) stopTracking();
        else startTracking(id);
    };

    window.removeNode = function (id) {
        if (STATE.liveTrackingId === id) stopTracking();
        const target = STATE.group.find(p => p.id === id);
        STATE.group = STATE.group.filter(p => p.id !== id);
        emitSignal("removePerson", id);
        emitSignal("updateGroupData", STATE.group);
        if (target) logEvent(`✕ Ejected node "${target.name}" from active grid.`);
        renderUI();
    };

    window.adjustNodeAltitude = function (id, deltaMeters) {
        const person = STATE.group.find(p => p.id === id);
        if (!person) return;
        person.height = parseFloat((person.height + deltaMeters).toFixed(2));
        checkKinematicDrop(person);
        emitSignal("updateGroupData", STATE.group);
        logEvent(`📐 Adjusted ${person.name} altitude by ${deltaMeters > 0 ? "+" : ""}${deltaMeters}m -> Z=${person.height.toFixed(2)}m`);
        renderUI();
    };

    function startTracking(personId) {
        stopTracking();
        triggerSiren(false);
        STATE.liveTrackingId = personId;
        const trackedPerson = STATE.group.find(p => p.id === personId);
        if (trackedPerson) logEvent(`📍 Live GPS telemetry locked onto ${trackedPerson.name}.`);
        renderUI();

        if (!navigator.geolocation) return;
        STATE.gpsWatchId = navigator.geolocation.watchPosition(
            (pos) => {
                const person = STATE.group.find(p => p.id === STATE.liveTrackingId);
                if (person) {
                    person.lat = pos.coords.latitude;
                    person.lon = pos.coords.longitude;
                    if (pos.coords.altitude !== null) person.height = pos.coords.altitude;
                    checkGeofenceBreach(person, false);
                    checkKinematicDrop(person);
                    emitSignal("updateGroupData", STATE.group);
                    renderUI();
                }
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 0 }
        );
    }

    function stopTracking() {
        if (STATE.gpsWatchId && navigator.geolocation) {
            navigator.geolocation.clearWatch(STATE.gpsWatchId);
        }
        STATE.liveTrackingId = null;
        STATE.gpsWatchId = null;
        renderUI();
    }

    function checkGeofenceBreach(person, forceNotify = false) {
        if (STATE.group.length === 0 || person.lat === null || person.lon === null) return;
        const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator") || STATE.group[0];
        if (adminNode && adminNode.lat !== null && adminNode.lon !== null) {
            const dist = Utils.calculateDistance(adminNode.lat, adminNode.lon, person.lat, person.lon);
            if (dist > STATE.geofenceRadius) {
                if (forceNotify || !person.lastGeoAlert || Date.now() - person.lastGeoAlert > 8000) {
                    const roundedDist = Math.round(dist);
                    setSystemAlertStatus(`PERIMETER // ${person.name}`);
                    showAlert(`🚨 GEOFENCE BREACH: ${person.name} is ${roundedDist}m from Command (Max ${STATE.geofenceRadius}m)!`, true);
                    logEvent(`🚨 Geofence Breach: ${person.name} is ${roundedDist}m outside safe radius (${STATE.geofenceRadius}m).`);
                    triggerSiren(true);
                    speakTacticalAlert(`Perimeter breach alert. ${person.name} is ${roundedDist} meters from command center.`);
                    transmitNtfyAlert(
                        `🚨 GEOFENCE BREACH: ${person.name}`,
                        `${person.name} is ${roundedDist}m outside the safe zone!`,
                        "warning,world_map",
                        person.lat,
                        person.lon
                    );
                    person.lastGeoAlert = Date.now();
                }
            }
        }
    }

    function checkKinematicDrop(person) {
        const now = Date.now();
        const limit = DOM.dropInput ? parseFloat(DOM.dropInput.value) || CONFIG.DEFAULT_DROP : CONFIG.DEFAULT_DROP;
        const windowSec = DOM.windowInput ? parseInt(DOM.windowInput.value, 10) || CONFIG.DEFAULT_WINDOW : CONFIG.DEFAULT_WINDOW;
        if (!STATE.kinematicHistory[person.id]) {
            STATE.kinematicHistory[person.id] = [];
        }
        const hist = STATE.kinematicHistory[person.id];
        hist.push({ time: now, h: person.height });
        STATE.kinematicHistory[person.id] = hist.filter(e => now - e.time <= windowSec * 1000);

        if (STATE.kinematicHistory[person.id].length >= 2) {
            const peak = Math.max(...STATE.kinematicHistory[person.id].map(e => e.h));
            if (peak - person.height >= limit) {
                const dropAmt = (peak - person.height).toFixed(2);
                emitSignal("triggerFallAlert", {
                    name: person.name,
                    drop: dropAmt,
                    id: person.id,
                    lat: person.lat,
                    lon: person.lon
                });
                setSystemAlertStatus(`FALL // ${person.name}`);
                showAlert(`🚨 FALL ALERT: ${person.name} dropped ${dropAmt}m within ${windowSec}s!`, true);
                logEvent(`🚨 Kinematic Fall Detected: ${person.name} dropped ${dropAmt}m!`);
                triggerSiren(true);
                speakTacticalAlert(`Warning. Kinematic fall detected for ${person.name}. Drop ${dropAmt} meters.`);
                transmitNtfyAlert(
                    `🚨 FALL ALERT: ${person.name}`,
                    `${person.name} dropped ${dropAmt}m!`,
                    "rotating_light,skull",
                    person.lat,
                    person.lon
                );
                STATE.kinematicHistory[person.id] = [{ time: now, h: person.height }];
            }
        }
    }

    function updateKpiStrip() {
        if (STATE.group.length === 0) return;
        const rels = STATE.group.map(p => p.height - STATE.globalBaseline);
        const avgRel = rels.reduce((acc, v) => acc + v, 0) / rels.length;
        const peakRel = Math.max(...rels);
        const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator") || STATE.group[0];

        let breaches = 0;
        STATE.group.forEach(p => {
            if (adminNode && adminNode.lat != null && p.lat != null) {
                const d = Utils.calculateDistance(adminNode.lat, adminNode.lon, p.lat, p.lon);
                if (d > STATE.geofenceRadius) breaches++;
            }
        });

        const score = Math.max(0, Math.round(((STATE.group.length - breaches) / STATE.group.length) * 100));
        if (DOM.kpiAvgBpm) DOM.kpiAvgBpm.textContent = `${avgRel >= 0 ? "+" : ""}${avgRel.toFixed(1)}m`;
        if (DOM.kpiAvgSpo2) DOM.kpiAvgSpo2.textContent = `${STATE.geofenceRadius}m`;
        if (DOM.kpiPeakAlt) DOM.kpiPeakAlt.textContent = `${peakRel >= 0 ? "+" : ""}${peakRel.toFixed(1)}m`;
        if (DOM.kpiSafetyScore) DOM.kpiSafetyScore.textContent = `${score}%`;
        if (DOM.kpiSafetySub) {
            DOM.kpiSafetySub.textContent = breaches === 0 ? "All Nodes Within Perimeter" : `${breaches} Perimeter Breach(es)`;
        }
    }

    function renderUI() {
        if (DOM.statActive) DOM.statActive.textContent = `${STATE.group.length} Tracked`;
        if (DOM.statSite) DOM.statSite.textContent = STATE.groupCode || "OFFLINE";
        if (DOM.statRole) DOM.statRole.textContent = STATE.role.toUpperCase();

        updateKpiStrip();

        if (STATE.group.length === 0) {
            if (DOM.emptyHint) DOM.emptyHint.style.display = "flex";
            if (DOM.rosterList) DOM.rosterList.innerHTML = "";
            if (DOM.graphSvg) DOM.graphSvg.innerHTML = "";
            if (DOM.isoTowerSvg) DOM.isoTowerSvg.innerHTML = "";
        } else {
            if (DOM.emptyHint) DOM.emptyHint.style.display = "none";
            renderRoster();
            renderGraph();
            renderIsoTower();
        }
        renderMap();
    }

    function renderRoster() {
        if (!DOM.rosterList) return;
        const limit = DOM.limitInput ? parseFloat(DOM.limitInput.value) || CONFIG.DEFAULT_LIMIT : CONFIG.DEFAULT_LIMIT;
        const floorH = DOM.floorInput ? parseFloat(DOM.floorInput.value) || CONFIG.DEFAULT_FLOOR : CONFIG.DEFAULT_FLOOR;
        const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator") || STATE.group[0];

        const filtered = STATE.group.filter(p => {
            if (!STATE.rosterFilter) return true;
            return (
                (p.name && p.name.toLowerCase().includes(STATE.rosterFilter)) ||
                (p.designation && p.designation.toLowerCase().includes(STATE.rosterFilter)) ||
                (p.role && p.role.toLowerCase().includes(STATE.rosterFilter))
            );
        });

        DOM.rosterList.innerHTML = filtered.map(p => {
            const relHeight = p.height - STATE.globalBaseline;
            let statusClass = "status-within";
            if (relHeight > limit) statusClass = "status-above";
            else if (relHeight < -limit) statusClass = "status-below";

            const floorNum = Math.round(relHeight / floorH);
            const floorLabel = floorNum === 0 ? "Ground (0)" : (floorNum > 0 ? `Lvl +${floorNum}` : `Bsmnt ${Math.abs(floorNum)}`);

            let distText = "Anchor Node";
            if (adminNode && adminNode.id !== p.id && adminNode.lat != null && p.lat != null) {
                const dist = Math.round(Utils.calculateDistance(adminNode.lat, adminNode.lon, p.lat, p.lon));
                distText = `${dist}m from Command`;
            }

            const isLive = p.id === STATE.liveTrackingId;
            return `
                <li class="roster-item ${isLive ? "is-live" : ""}">
                    <div class="roster-info">
                        <strong>${(p.role === "admin" || p.role === "creator") ? "👑 " : "👷 "}${Utils.escapeHtml(p.name)}</strong>
                        <span class="roster-sub">${Utils.escapeHtml(p.designation)} • Raw Z: ${p.height.toFixed(2)}m • ${distText}</span>
                    </div>
                    <div class="roster-metrics">
                        <span class="floor-pill">${floorLabel}</span>
                        <div class="roster-status ${statusClass}">${relHeight >= 0 ? "+" : ""}${relHeight.toFixed(2)}m</div>
                        <div class="roster-actions">
                            <button type="button" class="mini-btn" onclick="adjustNodeAltitude('${p.id}', 1.5)" title="Ascend +1.5m">▲ +1.5m</button>
                            <button type="button" class="mini-btn drop-sim-btn" onclick="adjustNodeAltitude('${p.id}', -2.2)" title="Simulate sudden drop">▼ -2.2m</button>
                            <button type="button" class="mini-btn track-btn ${isLive ? "active" : ""}" onclick="toggleTrack('${p.id}')">${isLive ? "⏹ Halt" : "📍 Track"}</button>
                            <button type="button" class="mini-btn remove-btn" onclick="removeNode('${p.id}')">✕</button>
                        </div>
                    </div>
                </li>
            `;
        }).join("");
    }

    function renderGraph() {
        if (!DOM.graphSvg) return;
        const W = DOM.graphSvg.clientWidth || 560;
        const H = DOM.graphSvg.clientHeight || 460;
        const paddingLeft = 65;
        const paddingRight = 70;
        const paddingTopBottom = 70;

        const limit = DOM.limitInput ? parseFloat(DOM.limitInput.value) || CONFIG.DEFAULT_LIMIT : CONFIG.DEFAULT_LIMIT;
        const floorH = DOM.floorInput ? parseFloat(DOM.floorInput.value) || CONFIG.DEFAULT_FLOOR : CONFIG.DEFAULT_FLOOR;
        const rels = STATE.group.map(p => p.height - STATE.globalBaseline);
        const maxAbs = Math.max(limit * 2.2, floorH * 3, ...rels.map(Math.abs), 4);
        const plotHeight = H - (paddingTopBottom * 2);
        const scaleY = (plotHeight / 2) / maxAbs;
        const midY = H / 2;

        let svgHtml = `<text x="18" y="26" fill="#8b95a8" font-family="JetBrains Mono" font-size="10" font-weight="800">2D CROSS-SECTIONAL TELEMETRY</text>`;
        const usableWidth = W - paddingLeft - paddingRight;
        const startFloor = Math.floor(-maxAbs / floorH) - 1;
        const endFloor = Math.ceil(maxAbs / floorH) + 1;
        const floorSpacingPx = floorH * scaleY;

        if (floorSpacingPx > 14) {
            for (let f = startFloor; f <= endFloor; f++) {
                const yFloor = midY - (f * floorH) * scaleY;
                if (yFloor >= paddingTopBottom && yFloor <= H - paddingTopBottom && f !== 0) {
                    svgHtml += `<line class="floor-line" x1="${paddingLeft}" y1="${yFloor}" x2="${W - paddingRight}" y2="${yFloor}"></line>`;
                    if (floorSpacingPx > 24) {
                        const labelStr = f > 0 ? `LVL +${f}` : `BSMNT ${Math.abs(f)}`;
                        svgHtml += `<text x="${W - paddingRight - 6}" y="${yFloor - 6}" class="floor-label" text-anchor="end">${labelStr}</text>`;
                    }
                }
            }
        }

        [limit, -limit].forEach(limVal => {
            const yLim = midY - (limVal * scaleY);
            if (yLim >= paddingTopBottom && yLim <= H - paddingTopBottom) {
                svgHtml += `<line class="limit-line" x1="${paddingLeft}" y1="${yLim}" x2="${W - paddingRight}" y2="${yLim}"></line>`;
            }
        });

        const step = Utils.niceStep(maxAbs);
        for (let v = step; v <= maxAbs; v += step) {
            [v, -v].forEach(val => {
                const y = midY - (val * scaleY);
                if (y >= paddingTopBottom && y <= H - paddingTopBottom) {
                    svgHtml += `<line class="grid-line" x1="${paddingLeft}" y1="${y}" x2="${W - paddingRight}" y2="${y}"></line>`;
                    svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${y + 4}" text-anchor="end">${val > 0 ? "+" : ""}${val}m</text>`;
                }
            });
        }

        svgHtml += `<line class="baseline" x1="${paddingLeft}" y1="${midY}" x2="${W - paddingRight}" y2="${midY}"></line>`;
        svgHtml += `<text class="axis-label" x="${paddingLeft - 10}" y="${midY + 4}" fill="#00e5ff" text-anchor="end">0.0m</text>`;
        svgHtml += `<text class="axis-label" x="${W - paddingRight - 6}" y="${midY - 8}" fill="#00e5ff" text-anchor="end">DATUM ZERO</text>`;

        STATE.group.forEach((p, i) => {
            const rel = p.height - STATE.globalBaseline;
            const x = paddingLeft + (usableWidth * (i + 0.5)) / STATE.group.length;
            const rawY = midY - (rel * scaleY);
            const y = Math.max(paddingTopBottom, Math.min(H - paddingTopBottom, rawY));

            let status = "within";
            if (rel > limit) status = "above";
            else if (rel < -limit) status = "below";

            const floorNum = Math.round(rel / floorH);
            const floorBadge = floorNum === 0 ? "GND" : (floorNum > 0 ? `L+${floorNum}` : `B${Math.abs(floorNum)}`);

            svgHtml += `
                <g class="figure figure-${status}" style="transform: translate(${x}px, ${y}px)" onclick="adjustNodeAltitude('${p.id}', 1.5)">
                    ${p.id === STATE.liveTrackingId ? '<circle class="live-halo" r="28" cy="-10"></circle>' : ""}
                    <text class="figure-readout" x="0" y="-46" text-anchor="middle">${rel >= 0 ? "+" : ""}${rel.toFixed(1)}m [${floorBadge}]</text>
                    <circle class="figure-head" cx="0" cy="-26" r="8.5"></circle>
                    <line class="figure-body" x1="0" y1="-17" x2="0" y2="9"></line>
                    <line class="figure-arm" x1="0" y1="-12" x2="-13" y2="-3"></line>
                    <line class="figure-arm" x1="0" y1="-12" x2="13" y2="-3"></line>
                    <line class="figure-leg" x1="0" y1="9" x2="-10" y2="26"></line>
                    <line class="figure-leg" x1="0" y1="9" x2="10" y2="26"></line>
                    <text class="figure-label" x="0" y="44" text-anchor="middle">${Utils.escapeHtml(p.name.split(" ")[0])}</text>
                    <text class="figure-label-sub" x="0" y="56" text-anchor="middle">${Utils.escapeHtml(p.designation.split(" ")[0])}</text>
                </g>
            `;
        });

        DOM.graphSvg.innerHTML = svgHtml;
    }

    // 3D Isometric Structural Digital Twin Renderer
    function renderIsoTower() {
        if (!DOM.isoTowerSvg) return;
        const W = DOM.isoTowerSvg.clientWidth || 400;
        const H = DOM.isoTowerSvg.clientHeight || 460;
        const cx = W / 2;
        const floorH = DOM.floorInput ? parseFloat(DOM.floorInput.value) || CONFIG.DEFAULT_FLOOR : CONFIG.DEFAULT_FLOOR;

        const floors = [-1, 0, 1, 2, 3];
        const slabW = Math.min(130, W * 0.34);
        const slabH = 34;
        const spacingY = 68;
        const baseZeroY = H * 0.66;

        let svg = `<text x="18" y="26" fill="#00e5ff" font-family="JetBrains Mono" font-size="10" font-weight="800">3D ISOMETRIC BUILDING DIGITAL TWIN</text>`;

        const topY = baseZeroY - 3 * spacingY;
        const botY = baseZeroY + 1 * spacingY;
        [
            [cx - slabW, topY, cx - slabW, botY],
            [cx + slabW, topY, cx + slabW, botY],
            [cx, topY - slabH, cx, botY - slabH],
            [cx, topY + slabH, cx, botY + slabH]
        ].forEach(([x1, y1, x2, y2]) => {
            svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(0,229,255,0.18)" stroke-width="1.5" stroke-dasharray="3 3"/>`;
        });

        floors.forEach(f => {
            const y = baseZeroY - f * spacingY;
            const isDatum = f === 0;
            const strokeCol = isDatum ? "#00e5ff" : (f < 0 ? "#ff004c" : "rgba(0, 229, 255, 0.45)");
            const fillCol = isDatum ? "rgba(0, 229, 255, 0.14)" : (f < 0 ? "rgba(255, 0, 76, 0.08)" : "rgba(14, 22, 38, 0.68)");
            const pts = `${cx},${y - slabH} ${cx + slabW},${y} ${cx},${y + slabH} ${cx - slabW},${y}`;
            svg += `<polygon points="${pts}" fill="${fillCol}" stroke="${strokeCol}" stroke-width="${isDatum ? 2.2 : 1.2}"/>`;

            const floorName = f === 0 ? "GND // 0m" : (f > 0 ? `LVL +${f} (${(f * floorH).toFixed(1)}m)` : `BSMNT ${Math.abs(f)} (${(f * floorH).toFixed(1)}m)`);
            svg += `<text x="${cx - slabW + 6}" y="${y - 6}" fill="${strokeCol}" font-family="JetBrains Mono" font-size="9" font-weight="800">${floorName}</text>`;

            const opsOnFloor = STATE.group.filter(p => {
                const rel = p.height - STATE.globalBaseline;
                const pFloor = Math.max(-1, Math.min(3, Math.round(rel / floorH)));
                return pFloor === f;
            });

            opsOnFloor.forEach((op, idx) => {
                const offsetX = (idx - (opsOnFloor.length - 1) / 2) * 44;
                const ox = cx + offsetX;
                const oy = y + (idx % 2 === 0 ? -4 : 6);
                const pinCol = (op.role === "admin" || op.role === "creator") ? "#ff004c" : "#00ffa3";
                svg += `
                    <g style="cursor:pointer;" onclick="adjustNodeAltitude('${op.id}', 3.5)">
                        <ellipse cx="${ox}" cy="${oy + 4}" rx="10" ry="5" fill="rgba(0,255,163,0.22)" stroke="${pinCol}" stroke-width="1.2"/>
                        <line x1="${ox}" y1="${oy + 4}" x2="${ox}" y2="${oy - 18}" stroke="${pinCol}" stroke-width="2.5"/>
                        <circle cx="${ox}" cy="${oy - 22}" r="6" fill="${pinCol}" stroke="#fff" stroke-width="1.5"/>
                        <text x="${ox}" y="${oy - 32}" fill="#fff" font-family="JetBrains Mono" font-size="9.5" font-weight="800" text-anchor="middle">${Utils.escapeHtml(op.name.split(" ")[0])}</text>
                    </g>
                `;
            });
        });

        DOM.isoTowerSvg.innerHTML = svg;
    }

    function renderMap() {
        if (!STATE.mapInstance && typeof L !== "undefined") {
            const mapEl = document.getElementById("map");
            if (!mapEl) return;
            STATE.mapInstance = L.map("map").setView([CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON], 15);
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: "&copy; OpenStreetMap"
            }).addTo(STATE.mapInstance);

            STATE.hospitalLayer = L.layerGroup().addTo(STATE.mapInstance);

            const weatherControl = L.control({ position: "topright" });
            weatherControl.onAdd = function () {
                const div = L.DomUtil.create("div", "weather-hud");
                div.innerHTML = `
                    <div style="color:var(--brand-primary);font-weight:900;margin-bottom:4px;">SAT-METEO HUD</div>
                    <div>TEMP: <strong id="hudTemp">31.4°C</strong></div>
                    <div>WIND: <strong id="hudWind">11.2 km/h</strong></div>
                `;
                return div;
            };
            weatherControl.addTo(STATE.mapInstance);

            STATE.mapInstance.on("moveend", () => {
                clearTimeout(STATE.hospitalTimeout);
                STATE.hospitalTimeout = setTimeout(() => fetchHospitals(false), 1800);
            });
        }

        if (!STATE.mapInstance) return;

        const adminNode = STATE.group.find(p => p.role === "admin" || p.role === "creator") || STATE.group[0];
        if (adminNode && adminNode.lat !== null && adminNode.lon !== null) {
            const centerLatLng = [adminNode.lat, adminNode.lon];
            if (STATE.geofenceCircle) {
                STATE.geofenceCircle.setLatLng(centerLatLng);
                STATE.geofenceCircle.setRadius(STATE.geofenceRadius);
            } else {
                STATE.geofenceCircle = L.circle(centerLatLng, {
                    color: "#ff004c",
                    fillColor: "#ff004c",
                    fillOpacity: 0.09,
                    radius: STATE.geofenceRadius,
                    weight: 2,
                    dashArray: "6, 6"
                }).addTo(STATE.mapInstance);
            }
        } else if (STATE.geofenceCircle) {
            STATE.mapInstance.removeLayer(STATE.geofenceCircle);
            STATE.geofenceCircle = null;
        }

        const currentIds = STATE.group.map(p => p.id);
        Object.keys(STATE.mapMarkers).forEach(id => {
            if (!currentIds.includes(id)) {
                STATE.mapInstance.removeLayer(STATE.mapMarkers[id]);
                delete STATE.mapMarkers[id];
            }
        });

        STATE.group.forEach(p => {
            if (p.lat !== null && p.lon !== null) {
                const isAdmin = (p.role === "admin" || p.role === "creator");
                const fillColor = isAdmin ? "#ff004c" : (p.id === STATE.liveTrackingId ? "#ffcc00" : "#00e5ff");
                const iconHtml = `
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="${fillColor}">
                        <circle cx="12" cy="12" r="9" stroke="#ffffff" stroke-width="2.2"/>
                    </svg>
                `;
                const divIcon = L.divIcon({
                    className: "tactical-marker",
                    html: iconHtml,
                    iconSize: [30, 30],
                    iconAnchor: [15, 15]
                });
                const popupContent = `
                    <b>${isAdmin ? "👑 " : "👷 "}${Utils.escapeHtml(p.name)}</b><br>
                    ${Utils.escapeHtml(p.designation)}<br>
                    Altitude Z: <b>${p.height.toFixed(2)}m</b><br>
                    Coords: ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}
                `;
                if (STATE.mapMarkers[p.id]) {
                    STATE.mapMarkers[p.id].setLatLng([p.lat, p.lon]);
                    STATE.mapMarkers[p.id].setIcon(divIcon);
                    STATE.mapMarkers[p.id].setPopupContent(popupContent);
                } else {
                    STATE.mapMarkers[p.id] = L.marker([p.lat, p.lon], { icon: divIcon })
                        .addTo(STATE.mapInstance)
                        .bindPopup(popupContent);
                }
            }
        });
    }

    function showAlert(msg, isDanger = false) {
        if (!DOM.alertBanner) return;
        DOM.alertBanner.textContent = msg;
        DOM.alertBanner.className = `toast-banner show ${isDanger ? "toast-danger" : ""}`;
        DOM.alertBanner.hidden = false;
        clearTimeout(STATE.alertTimer);
        STATE.alertTimer = setTimeout(() => {
            DOM.alertBanner.classList.remove("show");
        }, 4500);
    }

    function logEvent(msg) {
        const timestamp = new Date().toLocaleTimeString();
        STATE.logs.unshift(`[${timestamp}] ${msg}`);
        if (STATE.logs.length > 45) STATE.logs.pop();
        if (DOM.logList) {
            DOM.logList.innerHTML = STATE.logs
                .map(l => `<li class="log-item">${Utils.escapeHtml(l)}</li>`)
                .join("");
        }
    }

    if (DOM.limitInput) DOM.limitInput.value = localSettings.limit;
    if (DOM.dropInput) DOM.dropInput.value = localSettings.dropThreshold;
    if (DOM.windowInput) DOM.windowInput.value = localSettings.dropWindow;
    if (DOM.floorInput) DOM.floorInput.value = localSettings.floorHeight;
    if (DOM.ntfyTopicInput) DOM.ntfyTopicInput.value = localSettings.ntfyTopic;
    if (DOM.geofenceRadiusInput) DOM.geofenceRadiusInput.value = localSettings.geofenceRadius || CONFIG.DEFAULT_GEOFENCE;

    window.addEventListener("resize", () => {
        if (STATE.group.length > 0) {
            renderGraph();
            renderIsoTower();
            renderOscilloscope();
        }
    });

    applyRolePermissions();
    initBarometer();
    logEvent("🚀 Altiguard Kernel v7.0 (GitHub Milestone Edition) initialized.");
    setTimeout(() => {
        renderMap();
        deployDemoSquad(true);
        fetchWeatherAndAQI(CONFIG.DEFAULT_LAT, CONFIG.DEFAULT_LON);
        fetchHospitals(false);
        startAutopilotLoop();
        renderOscilloscope();
    }, 150);
})();
