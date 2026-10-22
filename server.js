/**
 * ============================================================================
 * ALTIGUARD KERNEL - FULL-STACK TELEMETRY & REST SERVER (SERVER.JS)
 * ============================================================================
 * Engineered by Vaibhav Raju Kondane | COETA Worker Monitoring
 */
const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const https = require('https');

app.use(express.static(__dirname));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const groups = {};
const groupBaselines = {};
const groupNtfyTopics = {};
const groupGeofenceRadius = {};
const incidentHistory = [];

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ONLINE',
    kernel: 'Altiguard v7.0',
    engineer: 'Vaibhav Raju Kondane (COETA)',
    uptimeSeconds: Math.round(process.uptime()),
    activeSites: Object.keys(groups).length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/telemetry/:groupCode', (req, res) => {
  const code = (req.params.groupCode || 'TEAM123').toUpperCase().trim();
  const group = groups[code];
  if (!group) {
    return res.status(404).json({ error: `Site ${code} not found` });
  }
  res.json({
    siteCode: code,
    datumBaseline: groupBaselines[code] || 0,
    geofenceRadius: groupGeofenceRadius[code] || 500,
    activeOperators: group.members.length,
    members: group.members
  });
});

app.get('/api/incidents', (req, res) => {
  res.json({
    totalIncidents: incidentHistory.length,
    incidents: incidentHistory.slice(0, 100)
  });
});

// Server-Side Ntfy Push Dispatch (Bypasses Browser CORS / Adblockers)
function sendNtfyServerSide(topic, title, message, tags, clickUrl) {
  if (!topic) return;
  const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
  if (!cleanTopic) return;
  let reqPath = `/${cleanTopic}?title=${encodeURIComponent(title)}&priority=urgent&tags=${encodeURIComponent(tags)}`;
  if (clickUrl) reqPath += `&click=${encodeURIComponent(clickUrl)}`;
  const req = https.request({ hostname: 'ntfy.sh', path: reqPath, method: 'POST' }, (res) => {
    console.log(`[NTFY DISPATCH] Sent to ${cleanTopic} | Status: ${res.statusCode}`);
  });
  req.on('error', (e) => console.error(`[NTFY ERR] ${e.message}`));
  req.write(message);
  req.end();
}

function recordIncident(siteCode, type, details) {
  incidentHistory.unshift({
    id: 'INC-' + Date.now(),
    siteCode,
    type,
    details,
    timestamp: new Date().toISOString()
  });
  if (incidentHistory.length > 200) incidentHistory.pop();
}

io.on('connection', (socket) => {
  let currentGroup = null;

  function syncRoomState(code) {
    if (!groups[code]) return;
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code] || 0);
    socket.emit('syncGeofence', groupGeofenceRadius[code] || 500);
    socket.emit('syncNtfyTopic', groupNtfyTopics[code] || "");
  }

  socket.on('createGroup', (groupCode) => {
    const code = (groupCode || "TEAM123").toUpperCase().trim();
    if (currentGroup) socket.leave(currentGroup);
    currentGroup = code;
    socket.join(code);

    if (!groups[code]) {
      groups[code] = { adminId: socket.id, members: [] };
    } else {
      groups[code].adminId = socket.id;
    }
    if (groupBaselines[code] === undefined) groupBaselines[code] = 0;
    if (groupGeofenceRadius[code] === undefined) groupGeofenceRadius[code] = 500;

    socket.emit('roleAssigned', { role: 'admin', groupCode: code });
    syncRoomState(code);
  });

  socket.on('joinGroup', (groupCode) => {
    const code = (groupCode || "").toUpperCase().trim();
    if (!code) {
      return socket.emit('groupError', 'Please enter a valid Site Code.');
    }
    if (!groups[code]) {
      return socket.emit('groupError', `Site "${code}" is not active yet. Create it as Admin first.`);
    }
    if (currentGroup) socket.leave(currentGroup);
    currentGroup = code;
    socket.join(code);

    const isAdmin = groups[code].adminId === socket.id;
    socket.emit('roleAssigned', { role: isAdmin ? 'admin' : 'worker', groupCode: code });
    syncRoomState(code);
  });

  socket.on('upsertPerson', (person) => {
    if (!currentGroup || !groups[currentGroup] || !person || !person.id) return;
    const list = groups[currentGroup].members;
    const idx = list.findIndex(p => p.id === person.id);
    if (idx > -1) list[idx] = { ...list[idx], ...person, socketId: socket.id };
    else list.push({ ...person, socketId: socket.id });
    io.to(currentGroup).emit('syncGroup', list);
  });

  socket.on('updateGroupData', (updatedMembersArray) => {
    if (currentGroup && groups[currentGroup] && Array.isArray(updatedMembersArray)) {
      groups[currentGroup].members = updatedMembersArray;
      io.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  socket.on('removePerson', (personId) => {
    if (currentGroup && groups[currentGroup]) {
      groups[currentGroup].members = groups[currentGroup].members.filter(p => p.id !== personId);
      io.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  socket.on('setBaseline', (newZeroPoint) => {
    if (currentGroup && typeof newZeroPoint === 'number' && groups[currentGroup]) {
      groupBaselines[currentGroup] = newZeroPoint;
      io.to(currentGroup).emit('syncBaseline', newZeroPoint);
    }
  });

  socket.on('updateGeofenceRadius', (radius) => {
    if (currentGroup && typeof radius === 'number' && groups[currentGroup]) {
      groupGeofenceRadius[currentGroup] = radius;
      io.to(currentGroup).emit('syncGeofence', radius);
    }
  });

  socket.on('updateNtfyTopic', (topic) => {
    if (currentGroup && typeof topic === 'string' && groups[currentGroup]) {
      groupNtfyTopics[currentGroup] = topic;
      io.to(currentGroup).emit('syncNtfyTopic', topic);
    }
  });

  socket.on('triggerFallAlert', (alertData) => {
    if (currentGroup && alertData) {
      recordIncident(currentGroup, 'FALL_DETECTED', alertData);
      socket.to(currentGroup).emit('receiveAlert', alertData);
      const mapUrl = (alertData.lat && alertData.lon) ? `https://www.google.com/maps?q=${alertData.lat},${alertData.lon}` : null;
      sendNtfyServerSide(
        groupNtfyTopics[currentGroup],
        `FALL ALERT: ${alertData.name}`,
        `${alertData.name} dropped ${alertData.drop}m!`,
        "rotating_light,skull",
        mapUrl
      );
    }
  });

  socket.on('triggerSOS', (payload) => {
    if (currentGroup && payload) {
      recordIncident(currentGroup, 'SOS_PANIC', payload);
      io.to(currentGroup).emit('receiveSOS', payload);
      const mapUrl = (payload.lat && payload.lon) ? `https://www.google.com/maps?q=${payload.lat},${payload.lon}` : null;
      sendNtfyServerSide(
        groupNtfyTopics[currentGroup],
        `SOS PANIC: ${payload.name}`,
        `${payload.name} triggered SOS panic protocol!`,
        "sos,rotating_light",
        mapUrl
      );
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Altiguard Tactical Core online on http://localhost:${PORT}`));
