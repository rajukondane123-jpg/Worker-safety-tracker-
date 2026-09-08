/**
 * =========================================================
 * WORKER MONITORING - ENTERPRISE BACKEND SERVER
 * =========================================================
 */
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { 
    cors: { origin: "*" },
    maxHttpBufferSize: 1e8 // Allow large audio blobs (100MB max)
});
const https = require('https');
const mongoose = require('mongoose');

app.use(express.static(__dirname));
app.use(express.json());

// --- DATABASE INTEGRATION (MONGODB) ---
const MONGO_URI = process.env.MONGO_URI; 
let dbActive = false;

// Create a schema for long-term incident logging
const incidentSchema = new mongoose.Schema({
    groupCode: String,
    timestamp: { type: Date, default: Date.now },
    eventType: String,
    operatorName: String,
    message: String,
    lat: Number,
    lon: Number
});
const Incident = mongoose.model('Incident', incidentSchema);

if (MONGO_URI) {
    mongoose.connect(MONGO_URI)
        .then(() => { console.log('🟢 MongoDB Enterprise Uplink Active'); dbActive = true; })
        .catch(err => console.error('🔴 MongoDB Connection Failed:', err.message));
} else {
    console.log('⚠️ No MONGO_URI found. Running in volatile memory mode (Data lost on restart).');
}

async function logIncidentToDB(groupCode, type, name, message, lat, lon) {
    if (dbActive) {
        try {
            await new Incident({ groupCode, eventType: type, operatorName: name, message, lat, lon }).save();
        } catch(e) { console.error("DB Save Error:", e); }
    }
}

// --- VOLATILE MEMORY STATE ---
const groups = {}; 
const groupBaselines = {}; 
const groupNtfyTopics = {};
const groupGeofenceRadius = {};

function sendNtfyServerSide(topic, title, message, tags, clickUrl) {
  if (!topic) return;
  const cleanTopic = topic.replace(/[^a-zA-Z0-9-_]/g, "");
  let path = `/${cleanTopic}?title=${encodeURIComponent(title)}&priority=urgent&tags=${encodeURIComponent(tags)}`;
  if (clickUrl) path += `&click=${encodeURIComponent(clickUrl)}`;

  const req = https.request({ hostname: 'ntfy.sh', path: path, method: 'POST' }, (res) => {});
  req.on('error', () => {});
  req.write(message); req.end();
}

io.on('connection', (socket) => {
  let currentGroup = null;

  socket.on('createGroup', async (groupCode) => {
    const code = (groupCode || "TEAM123").toUpperCase().trim();
    if (currentGroup) socket.leave(currentGroup);
    
    currentGroup = code; socket.join(code);

    if (!groups[code]) groups[code] = { adminId: socket.id, members: [] };
    else if (groups[code].members.length === 0) groups[code].adminId = socket.id;
    
    if (groupBaselines[code] === undefined) groupBaselines[code] = 0;
    if (groupGeofenceRadius[code] === undefined) groupGeofenceRadius[code] = 500;

    socket.emit('roleAssigned', { role: 'admin', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code]);
    socket.emit('syncGeofence', groupGeofenceRadius[code]);
    socket.emit('syncNtfyTopic', groupNtfyTopics[code] || "");

    // Send historical logs from DB to Admin
    if (dbActive) {
        try {
            const history = await Incident.find({ groupCode: code }).sort({ timestamp: -1 }).limit(50);
            socket.emit('loadHistoricalLogs', history);
        } catch(e) {}
    }
  });

  socket.on('joinGroup', (groupCode) => {
    const code = (groupCode || "").toUpperCase().trim();
    if (!groups[code]) return socket.emit('groupError', 'Group code does not exist. Admin must create it first.');

    if (currentGroup) socket.leave(currentGroup);
    currentGroup = code; socket.join(code);

    const isAdmin = groups[code].adminId === socket.id;
    socket.emit('roleAssigned', { role: isAdmin ? 'admin' : 'worker', groupCode: code });
    socket.emit('syncGroup', groups[code].members);
    socket.emit('syncBaseline', groupBaselines[code] || 0);
    socket.emit('syncGeofence', groupGeofenceRadius[code] || 500);
  });

  socket.on('updateGroupData', (updatedMembersArray) => {
    if (currentGroup && groups[currentGroup]) {
      groups[currentGroup].members = updatedMembersArray;
      socket.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  socket.on('removePerson', (personId) => {
    if (currentGroup && groups[currentGroup]) {
      groups[currentGroup].members = groups[currentGroup].members.filter(p => p.id !== personId);
      io.to(currentGroup).emit('syncGroup', groups[currentGroup].members);
    }
  });

  socket.on('setBaseline', (val) => {
    if (currentGroup && groups[currentGroup].adminId === socket.id) {
        groupBaselines[currentGroup] = val; io.to(currentGroup).emit('syncBaseline', val);
    }
  });

  socket.on('updateGeofenceRadius', (radius) => {
    if (currentGroup && groups[currentGroup].adminId === socket.id) {
        groupGeofenceRadius[currentGroup] = radius; io.to(currentGroup).emit('syncGeofence', radius);
    }
  });

  socket.on('updateNtfyTopic', (topic) => {
    if (currentGroup && groups[currentGroup].adminId === socket.id) {
        groupNtfyTopics[currentGroup] = topic; io.to(currentGroup).emit('syncNtfyTopic', topic);
    }
  });

  socket.on('triggerFallAlert', (data) => { 
    if (currentGroup) {
      socket.to(currentGroup).emit('receiveAlert', data);
      sendNtfyServerSide(groupNtfyTopics[currentGroup], `🚨 FALL ALERT: ${data.name}`, `${data.name} dropped ${data.drop}m!`, "rotating_light,skull", data.lat ? `https://www.google.com/maps?q=${data.lat},${data.lon}` : null);
      logIncidentToDB(currentGroup, 'FALL', data.name, `Dropped ${data.drop}m`, data.lat, data.lon);
    }
  });

  socket.on('triggerSOS', (payload) => { 
    if (currentGroup) {
      io.to(currentGroup).emit('receiveSOS', payload);
      sendNtfyServerSide(groupNtfyTopics[currentGroup], `🚨 SOS: ${payload.name}`, `${payload.name} triggered SOS panic protocol!`, "sos,rotating_light", payload.lat ? `https://www.google.com/maps?q=${payload.lat},${payload.lon}` : null);
      logIncidentToDB(currentGroup, 'SOS', payload.name, 'Panic button activated', payload.lat, payload.lon);
    }
  });

  // --- NEW: TACTICAL COMMS ENGINE ---
  socket.on('broadcastCommand', (payload) => {
      if (currentGroup && groups[currentGroup].adminId === socket.id) {
          socket.to(currentGroup).emit('receiveCommand', payload);
          logIncidentToDB(currentGroup, 'COMMAND', 'ADMIN', payload.message, null, null);
      }
  });

  socket.on('commandAcknowledged', (payload) => {
      if (currentGroup) {
          socket.to(currentGroup).emit('workerAcknowledged', payload);
      }
  });

  // --- NEW: WEBRTC PUSH-TO-TALK ---
  socket.on('pttAudioStream', (audioBlob) => {
      if (currentGroup && groups[currentGroup].adminId === socket.id) {
          socket.to(currentGroup).emit('receivePttAudio', audioBlob);
      }
  });

});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Worker Monitoring Tactical Core online on port ${PORT}`));
