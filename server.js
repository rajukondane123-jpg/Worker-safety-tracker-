const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const https = require('https');

app.use(express.static(__dirname));
app.use(express.json());

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

  socket.on('createGroup', (groupCode) => {
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
  });

  socket.on('joinGroup', (groupCode) => {
    const code = (groupCode || "").toUpperCase().trim();
    if (!groups[code]) return socket.emit('groupError', 'Group code does not exist.');
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
    }
  });

  socket.on('triggerSOS', (payload) => { 
    if (currentGroup) {
      io.to(currentGroup).emit('receiveSOS', payload);
      sendNtfyServerSide(groupNtfyTopics[currentGroup], `🚨 SOS: ${payload.name}`, `${payload.name} triggered SOS panic protocol!`, "sos,rotating_light", payload.lat ? `https://www.google.com/maps?q=${payload.lat},${payload.lon}` : null);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`🚀 Worker Monitoring Tactical Core online on port ${PORT}`));
