import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import PDFDocument from 'pdfkit';
import { pointInPolygon, pointToGeoJSON } from './src-geo.js';

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = Number(process.env.PORT || 3000);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static('public'));

const demoMode = !process.env.DATABASE_URL;

const SERVER_VERSION = '0.2.0-enterprise';
const startedAt = Date.now();
const eventDedupe = new Map();
const baselines = new Map();
const zoneState = new Map();
const rateBuckets = new Map();
const CONFIG = {
  telemetryIntervalMs: Number(process.env.TELEMETRY_INTERVAL_MS || 2500),
  staleAfterMs: Number(process.env.STALE_AFTER_MS || 15000),
  altitudeDropM: Number(process.env.ALTITUDE_DROP_M || 5),
  altitudeJumpM: Number(process.env.ALTITUDE_JUMP_M || 5),
  geofenceCooldownMs: Number(process.env.GEOFENCE_COOLDOWN_MS || 30000),
  maxTelemetryBatch: 100,
  heatmapHours: 12,
};
function nowIso() { return new Date().toISOString(); }
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
function finite(n) { return typeof n === 'number' && Number.isFinite(n); }
function safeString(v, fallback='') { return typeof v === 'string' ? v.trim() : fallback; }
function makeId(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,10)}`; }
function normalizeTelemetry(input) {
  return {
    workerId: safeString(input.workerId), lat: Number(input.lat), lng: Number(input.lng),
    altitudeM: finite(Number(input.altitudeM)) ? Number(input.altitudeM) : null,
    accuracyM: finite(Number(input.accuracyM)) ? Number(input.accuracyM) : null,
    speedMps: finite(Number(input.speedMps)) ? Number(input.speedMps) : null,
    headingDeg: finite(Number(input.headingDeg)) ? Number(input.headingDeg) : null,
    heartRate: finite(Number(input.heartRate)) ? Math.round(Number(input.heartRate)) : null,
    spo2: finite(Number(input.spo2)) ? Number(input.spo2) : null,
    temperatureC: finite(Number(input.temperatureC)) ? Number(input.temperatureC) : null,
    humidityPct: finite(Number(input.humidityPct)) ? clamp(Number(input.humidityPct),0,100) : null,
    batteryPct: finite(Number(input.batteryPct)) ? clamp(Number(input.batteryPct),0,100) : null,
    source: safeString(input.source,'PHONE').toUpperCase().slice(0,30),
  };
}
function validateTelemetry(t) {
  if (!t.workerId || !finite(t.lat) || !finite(t.lng)) return 'workerId, lat and lng are required';
  if (t.lat < -90 || t.lat > 90 || t.lng < -180 || t.lng > 180) return 'invalid coordinates';
  if (t.accuracyM !== null && t.accuracyM < 0) return 'accuracyM cannot be negative';
  if (t.spo2 !== null && (t.spo2 < 50 || t.spo2 > 100)) return 'spo2 out of accepted telemetry range';
  return null;
}
function bucketRate(key, limit=120, windowMs=60000) {
  const now=Date.now(); const arr=rateBuckets.get(key)||[]; const live=arr.filter(x=>now-x<windowMs);
  live.push(now); rateBuckets.set(key,live); return live.length<=limit;
}
function dedupe(key, ttl=CONFIG.geofenceCooldownMs) {
  const t=Date.now(); const last=eventDedupe.get(key)||0; if(t-last<ttl) return false; eventDedupe.set(key,t); return true;
}
function getBaseline(workerId, altitude) {
  if (!baselines.has(workerId) && finite(altitude)) baselines.set(workerId, altitude);
  return baselines.get(workerId);
}
function altitudeRisk(workerId, altitude) {
  const base=getBaseline(workerId,altitude); if(!finite(base)||!finite(altitude)) return null;
  const delta=altitude-base;
  if (delta <= -CONFIG.altitudeDropM) return { type:'ALTITUDE_DROP', severity:'CRITICAL', delta };
  if (delta >= CONFIG.altitudeJumpM) return { type:'ALTITUDE_JUMP', severity:'WARNING', delta };
  return null;
}
function vitalsRisk(t) {
  const risks=[];
  if (t.heartRate !== null && (t.heartRate >= 150 || t.heartRate <= 45)) risks.push({type:'HEART_RATE_ANOMALY',severity:'WARNING'});
  if (t.spo2 !== null && t.spo2 < 92) risks.push({type:'LOW_SPO2',severity:'CRITICAL'});
  if (t.batteryPct !== null && t.batteryPct < 15) risks.push({type:'LOW_BATTERY',severity:'WARNING'});
  return risks;
}
function serialize(v) { return JSON.parse(JSON.stringify(v, (_,x)=>x instanceof Date?x.toISOString():x)); }
async function audit(action, entity, entityId, payload={}, req=null) {
  const row={actor:'ADMIN',action,entity,entityId,payload,ip:req?.ip||null,createdAt:nowIso()};
  if (!demoMode) { try { await prisma.auditLog.create({data:{actor:row.actor,action,entity,entityId,payload,ip:row.ip}}); } catch {} }
  io.emit('audit:new',row); return row;
}
async function listAudit(limit=100) {
  if (demoMode) return [];
  return prisma.auditLog.findMany({orderBy:{createdAt:'desc'},take:Math.min(Number(limit)||100,500)});
}
async function getDashboardStats() {
  const workers=await getWorkers(); const incidents=demoMode?memory.incidents:(await prisma.incident.findMany({where:{status:{not:'RESOLVED'}},take:500}));
  const now=Date.now(); const online=workers.filter(w=>w.lastSeen && now-new Date(w.lastSeen).getTime()<=CONFIG.staleAfterMs).length;
  return {workers:workers.length,online,offline:Math.max(0,workers.length-online),openIncidents:incidents.filter(i=>i.status!=='CLOSED'&&i.status!=='RESOLVED').length,critical:incidents.filter(i=>i.severity==='CRITICAL'&&i.status!=='RESOLVED'&&i.status!=='CLOSED').length,serverUptime:process.uptime(),version:SERVER_VERSION};
}
async function incidentExistsRecently(workerId,type,zoneId=null) {
  if (demoMode) return memory.incidents.some(i=>i.workerId===workerId&&i.type===type&&(!zoneId||i.zoneId===zoneId)&&Date.now()-new Date(i.createdAt).getTime()<CONFIG.geofenceCooldownMs);
  const where={workerId,type,createdAt:{gte:new Date(Date.now()-CONFIG.geofenceCooldownMs)}}; if(zoneId) where.zoneId=zoneId;
  return Boolean(await prisma.incident.findFirst({where,select:{id:true}}));
}
async function evaluateSafety(t) {
  const results=[];
  const alt=altitudeRisk(t.workerId,t.altitudeM); if(alt) results.push({...alt,message:`Reference-level change ${alt.delta.toFixed(1)} m`});
  for(const r of vitalsRisk(t)) results.push({...r,message:r.type.replaceAll('_',' ')});
  const zones=await getZones();
  for(const zone of zones){
    if(!zone.enabled) continue;
    if(pointInPolygon(pointToGeoJSON(t.lat,t.lng),zone.polygon)) results.push({type:'RED_ZONE_ENTRY',severity:zone.severity||'CRITICAL',message:`Worker entered ${zone.name}`,zoneId:zone.id});
  }
  return results;
}

const memory = { workers: new Map(), zones: [], incidents: [], broadcasts: [] };

function workerJson(w) {
  return { ...w, lastSeen: w.lastSeen?.toISOString?.() || w.lastSeen };
}
async function getWorkers() {
  if (demoMode) return [...memory.workers.values()].map(workerJson);
  return (await prisma.worker.findMany({ orderBy: { name: 'asc' } })).map(workerJson);
}
async function getZones() {
  if (demoMode) return memory.zones;
  return prisma.zone.findMany({ orderBy: { createdAt: 'desc' } });
}

app.get('/api/health', (_, res) => res.json({ ok: true, demoMode, uptime: process.uptime() }));
app.get('/api/workers', async (_, res) => res.json(await getWorkers()));
app.get('/api/zones', async (_, res) => res.json(await getZones()));
app.get('/api/incidents', async (_, res) => {
  if (demoMode) return res.json(memory.incidents.slice(0, 100));
  res.json(await prisma.incident.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { worker: true } }));
});
app.get('/api/telemetry/:workerId', async (req, res) => {
  if (demoMode) return res.json([]);
  const rows = await prisma.telemetry.findMany({ where: { workerId: req.params.workerId }, orderBy: { createdAt: 'desc' }, take: 1000 });
  res.json(rows);
});

app.post('/api/workers', async (req, res) => {
  const { name, employeeCode, lat, lng, altitudeM = 0 } = req.body;
  if (!name || !employeeCode) return res.status(400).json({ error: 'name and employeeCode are required' });
  if (demoMode) {
    const w = { id: `demo-${employeeCode}`, name, employeeCode, status: 'ONLINE', lat, lng, altitudeM, lastSeen: new Date().toISOString() };
    memory.workers.set(w.id, w); io.emit('worker:update', w); return res.json(w);
  }
  const w = await prisma.worker.create({ data: { name, employeeCode, lat, lng, altitudeM } });
  io.emit('worker:update', workerJson(w)); res.json(w);
});

app.post('/api/telemetry', async (req, res) => {
  try { const t=normalizeTelemetry(req.body); const err=validateTelemetry(t); if(err)return res.status(400).json({error:err}); if(!bucketRate(`ip:${req.ip}`,600,60000))return res.status(429).json({error:'rate limit'}); return res.json({ok:true,...await processTelemetry(t)}); } catch(e){ return res.status(500).json({error:e.message}); }
});

/* LEGACY IMPLEMENTATION BELOW RETAINED FOR REFERENCE
app.post('/api/telemetry_LEGACY', async (req, res) => {
  const { workerId, lat, lng, altitudeM, heartRate, spo2, temperatureC, humidityPct } = req.body;
  if (!workerId || !Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'workerId, lat and lng are required' });

  let worker;
  if (demoMode) {
    worker = memory.workers.get(workerId);
    if (!worker) return res.status(404).json({ error: 'worker not found' });
    const next = { ...worker, lat, lng, altitudeM, heartRate, spo2, lastSeen: new Date().toISOString() };
    memory.workers.set(workerId, next); worker = next;
  } else {
    await prisma.telemetry.create({ data: { workerId, lat, lng, altitudeM, heartRate, spo2, temperatureC, humidityPct } });
    worker = await prisma.worker.update({ where: { id: workerId }, data: { lat, lng, altitudeM, heartRate, spo2, lastSeen: new Date() } });
  }
  const out = workerJson(worker);
  io.emit('worker:update', out);

  // Reference-based altitude drop. The first reading is the local baseline.
  const baselineKey = `baseline:${workerId}`;
  if (!memory[baselineKey] && Number.isFinite(altitudeM)) memory[baselineKey] = altitudeM;
  if (Number.isFinite(altitudeM) && Number.isFinite(memory[baselineKey])) {
    const delta = altitudeM - memory[baselineKey];
    if (Math.abs(delta) >= 5) {
      await createIncident({ workerId, type: 'ALTITUDE_DROP', severity: 'CRITICAL', message: `Elevation changed by ${delta.toFixed(1)} m from worker baseline`, lat, lng, altitudeM });
      memory[baselineKey] = altitudeM;
    }
  }

  // Zone enforcement.
  const zones = await getZones();
  for (const zone of zones) {
    if (pointInPolygon(pointToGeoJSON(lat, lng), zone.polygon)) {
      await createIncident({ workerId, zoneId: zone.id, type: 'RED_ZONE_ENTRY', severity: 'CRITICAL', message: `Worker entered restricted zone: ${zone.name}`, lat, lng, altitudeM });
      break;
    }
  }
  res.json({ ok: true, worker: out });
});
*/


app.get('/api/meta', (_,res)=>res.json({name:'ALTIGUARD',version:SERVER_VERSION,startedAt:new Date(startedAt).toISOString(),features:['telemetry','geofencing','incidents','heatmap','broadcasts','pdf-reports','floorplans','analytics']}));
app.get('/api/dashboard', async (_,res)=>{ try{res.json(await getDashboardStats());}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/audit', async (req,res)=>res.json(await listAudit(req.query.limit)));
app.get('/api/settings', async (_,res)=>{ if(demoMode)return res.json(CONFIG); const rows=await prisma.systemSetting.findMany(); res.json(Object.fromEntries(rows.map(x=>[x.key,x.value]))); });
app.put('/api/settings/:key', async (req,res)=>{ const key=safeString(req.params.key); if(!key)return res.status(400).json({error:'key required'}); if(demoMode)return res.json({key,value:req.body.value}); const row=await prisma.systemSetting.upsert({where:{key},create:{key,value:req.body.value},update:{value:req.body.value}}); await audit('SETTING_UPDATED','SystemSetting',key,{value:req.body.value},req); res.json(row); });
app.get('/api/workers/:id', async (req,res)=>{ if(demoMode){const w=memory.workers.get(req.params.id);return w?res.json(w):res.status(404).json({error:'not found'});} const w=await prisma.worker.findUnique({where:{id:req.params.id},include:{shift:true}}); if(!w)return res.status(404).json({error:'not found'}); res.json(w); });
app.patch('/api/workers/:id', async (req,res)=>{ const allowed=['name','role','phone','status','deviceId','referenceM']; const data=Object.fromEntries(allowed.filter(k=>req.body[k]!==undefined).map(k=>[k,req.body[k]])); if(demoMode){const w=memory.workers.get(req.params.id);if(!w)return res.status(404).json({error:'not found'});Object.assign(w,data);io.emit('worker:update',workerJson(w));return res.json(w);} const w=await prisma.worker.update({where:{id:req.params.id},data});await audit('WORKER_UPDATED','Worker',w.id,data,req);io.emit('worker:update',workerJson(w));res.json(w); });
app.delete('/api/workers/:id', async (req,res)=>{ if(demoMode){memory.workers.delete(req.params.id);io.emit('worker:deleted',req.params.id);return res.json({ok:true});} await prisma.worker.delete({where:{id:req.params.id}});await audit('WORKER_DELETED','Worker',req.params.id,{},req);io.emit('worker:deleted',req.params.id);res.json({ok:true}); });
app.post('/api/telemetry/batch', async (req,res)=>{ if(!Array.isArray(req.body?.items))return res.status(400).json({error:'items array required'});if(req.body.items.length>CONFIG.maxTelemetryBatch)return res.status(413).json({error:`max ${CONFIG.maxTelemetryBatch} telemetry records`}); const out=[];for(const item of req.body.items){const t=normalizeTelemetry(item);const err=validateTelemetry(t);if(err){out.push({ok:false,error:err});continue;}try{out.push({ok:true,...await processTelemetry(t)});}catch(e){out.push({ok:false,error:e.message});}}res.json({processed:out.length,results:out}); });
app.get('/api/analytics/summary', async (req,res)=>{ const hours=clamp(Number(req.query.hours)||12,1,168); const since=new Date(Date.now()-hours*3600000); if(demoMode)return res.json({hours,telemetry:0,incidents:memory.incidents.length,topZones:[],byType:{}}); const [telemetry,incidents]=await Promise.all([prisma.telemetry.count({where:{createdAt:{gte:since}}}),prisma.incident.findMany({where:{createdAt:{gte:since}},select:{type:true,zoneId:true}})]);const byType={};for(const i of incidents)byType[i.type]=(byType[i.type]||0)+1;res.json({hours,telemetry,incidents:incidents.length,byType}); });
app.get('/api/floorplans', async (_,res)=>{if(demoMode)return res.json([]);res.json(await prisma.floorplan.findMany({orderBy:{createdAt:'desc'}}));});
app.post('/api/floorplans', async (req,res)=>{const {name,imageUrl,north,south,east,west,opacity=.65}=req.body;if(!name||!imageUrl)return res.status(400).json({error:'name and imageUrl required'});if(demoMode)return res.json({id:makeId('floor'),name,imageUrl,north,south,east,west,opacity,enabled:true});const fp=await prisma.floorplan.create({data:{name,imageUrl,north:Number(north),south:Number(south),east:Number(east),west:Number(west),opacity:Number(opacity)}});await audit('FLOORPLAN_CREATED','Floorplan',fp.id,{name},req);res.json(fp);});
app.delete('/api/floorplans/:id', async(req,res)=>{if(!demoMode)await prisma.floorplan.delete({where:{id:req.params.id}});res.json({ok:true});});
app.post('/api/broadcast/:id/ack', async(req,res)=>{const workerId=safeString(req.body.workerId);if(!workerId)return res.status(400).json({error:'workerId required'});if(demoMode)return res.json({ok:true});const b=await prisma.broadcast.findUnique({where:{id:req.params.id}});if(!b)return res.status(404).json({error:'broadcast not found'});const list=Array.isArray(b.acknowledgedBy)?b.acknowledgedBy:[];if(!list.includes(workerId))list.push(workerId);const out=await prisma.broadcast.update({where:{id:b.id},data:{acknowledgedBy:list}});io.emit('broadcast:ack',out);res.json(out);});
app.get('/api/telemetry/:workerId/range', async(req,res)=>{if(demoMode)return res.json([]);const hours=clamp(Number(req.query.hours)||8,1,168);const rows=await prisma.telemetry.findMany({where:{workerId:req.params.workerId,createdAt:{gte:new Date(Date.now()-hours*3600000)}},orderBy:{createdAt:'asc'},take:10000});res.json(rows);});
app.post('/api/incidents/:id/ack', async(req,res)=>{if(demoMode){const i=memory.incidents.find(x=>x.id===req.params.id);if(!i)return res.status(404).json({error:'not found'});i.status='ACKNOWLEDGED';i.acknowledgedAt=nowIso();io.emit('incident:update',i);return res.json(i);}const i=await prisma.incident.update({where:{id:req.params.id},data:{status:'ACKNOWLEDGED',acknowledgedAt:new Date()}});await audit('INCIDENT_ACKNOWLEDGED','Incident',i.id,{},req);io.emit('incident:update',i);res.json(i);});
async function processTelemetry(t){
  if(!bucketRate(`telemetry:${t.workerId}`,240,60000)) throw new Error('telemetry rate limit exceeded');
  let worker;
  if(demoMode){worker=memory.workers.get(t.workerId);if(!worker)throw new Error('worker not found');Object.assign(worker,{lat:t.lat,lng:t.lng,altitudeM:t.altitudeM,heartRate:t.heartRate,spo2:t.spo2,temperatureC:t.temperatureC,humidityPct:t.humidityPct,batteryPct:t.batteryPct,lastSeen:nowIso(),status:'ONLINE'});}else{await prisma.telemetry.create({data:t});worker=await prisma.worker.update({where:{id:t.workerId},data:{lat:t.lat,lng:t.lng,altitudeM:t.altitudeM,heartRate:t.heartRate,spo2:t.spo2,temperatureC:t.temperatureC,humidityPct:t.humidityPct,batteryPct:t.batteryPct,lastSeen:new Date(),status:'ONLINE'}});}
  const out=workerJson(worker);io.emit('worker:update',out);
  const risks=await evaluateSafety(t); const incidents=[];
  for(const risk of risks){const dedupeKey=`${t.workerId}:${risk.type}:${risk.zoneId||''}`;if(!dedupe(dedupeKey)||await incidentExistsRecently(t.workerId,risk.type,risk.zoneId))continue;const inc=await createIncident({workerId:t.workerId,zoneId:risk.zoneId,type:risk.type,severity:risk.severity,message:risk.message,lat:t.lat,lng:t.lng,altitudeM:t.altitudeM,metadata:{delta:risk.delta||null,source:t.source}});incidents.push(inc);}
  return {worker:out,incidents};
}

app.post('/api/zones', async (req, res) => {
  const { name, polygon, kind = 'RED', severity = 'CRITICAL', description = '' } = req.body;
  if (!name || !Array.isArray(polygon) || polygon.length < 3) return res.status(400).json({ error: 'name and polygon with at least 3 points are required' });
  if (polygon.some(p => !Array.isArray(p) || p.length < 2 || !finite(Number(p[0])) || !finite(Number(p[1])))) return res.status(400).json({error:'polygon points must be [lat,lng] numbers'});
  if (demoMode) {
    const zone = { id: `zone-${Date.now()}`, name, kind, severity, description, enabled:true, polygon, createdAt: new Date().toISOString() };
    memory.zones.unshift(zone); io.emit('zone:created', zone); return res.json(zone);
  }
  const zone = await prisma.zone.create({ data: { name, kind, severity, description, polygon, enabled:true } });
  io.emit('zone:created', zone); res.json(zone);
});

app.delete('/api/zones/:id', async (req, res) => {
  if (demoMode) memory.zones = memory.zones.filter(z => z.id !== req.params.id);
  else await prisma.zone.delete({ where: { id: req.params.id } });
  io.emit('zone:deleted', req.params.id); res.json({ ok: true });
});

async function createIncident(data) {
  let incident;
  if (demoMode) {
    incident = { id: `inc-${Date.now()}-${Math.random().toString(16).slice(2)}`, ...data, status: 'OPEN', createdAt: new Date().toISOString() };
    memory.incidents.unshift(incident);
  } else {
    incident = await prisma.incident.create({ data });
  }
  io.emit('incident:new', incident);
  return incident;
}

app.post('/api/incidents', async (req, res) => res.json(await createIncident(req.body)));

app.post('/api/incidents/:id/screenshot', async (req, res) => {
  const { screenshot } = req.body;
  if (!screenshot || typeof screenshot !== 'string' || !screenshot.startsWith('data:image/')) return res.status(400).json({ error: 'valid screenshot data URL required' });
  if (demoMode) {
    const incident = memory.incidents.find(i => i.id === req.params.id);
    if (!incident) return res.status(404).json({ error: 'incident not found' });
    incident.screenshot = screenshot;
    return res.json({ ok: true });
  }
  await prisma.incident.update({ where: { id: req.params.id }, data: { screenshot } });
  res.json({ ok: true });
});

app.post('/api/incidents/:id/close', async (req, res) => {
  if (demoMode) {
    const incident = memory.incidents.find(x => x.id === req.params.id);
    if (incident) incident.status = 'CLOSED';
    return res.json(incident || { error: 'not found' });
  }
  res.json(await prisma.incident.update({ where: { id: req.params.id }, data: { status: 'CLOSED' } }));
});

app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  let broadcast;
  if (demoMode) broadcast = { id: `b-${Date.now()}`, message, sender: 'ADMIN', createdAt: new Date().toISOString() };
  else broadcast = await prisma.broadcast.create({ data: { message } });
  io.emit('broadcast:new', broadcast);
  res.json(broadcast);
});

app.get('/api/heatmap', async (req, res) => {
  if (demoMode) return res.json([...memory.workers.values()].filter(w => w.lat && w.lng).map(w => [w.lat, w.lng, 0.5]));
  const since = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const rows = await prisma.telemetry.findMany({ where: { createdAt: { gte: since } }, select: { lat: true, lng: true } });
  res.json(rows.map(r => [r.lat, r.lng, 0.5]));
});

app.get('/api/incidents/:id/report.pdf', async (req, res) => {
  const id = req.params.id;
  let incident;
  let worker;
  if (demoMode) {
    incident = memory.incidents.find(i => i.id === id);
    worker = incident?.workerId ? memory.workers.get(incident.workerId) : null;
  } else {
    incident = await prisma.incident.findUnique({ where: { id }, include: { worker: true } });
    worker = incident?.worker;
  }
  if (!incident) return res.status(404).json({ error: 'incident not found' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="altiguard-incident-${id}.pdf"`);
  const doc = new PDFDocument({ margin: 42 });
  doc.pipe(res);
  doc.fontSize(22).text('ALTIGUARD INCIDENT REPORT', { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Incident ID: ${incident.id}`);
  doc.text(`Type: ${incident.type}`);
  doc.text(`Severity: ${incident.severity}`);
  doc.text(`Status: ${incident.status || 'OPEN'}`);
  doc.text(`Created: ${incident.createdAt}`);
  doc.moveDown();
  doc.fontSize(14).text('Event');
  doc.fontSize(11).text(incident.message || 'No message');
  doc.moveDown();
  doc.fontSize(14).text('Worker');
  doc.fontSize(11).text(worker ? `${worker.name} (${worker.employeeCode})` : 'Unknown');
  doc.text(`Coordinates: ${incident.lat ?? worker?.lat ?? '-'}, ${incident.lng ?? worker?.lng ?? '-'}`);
  doc.text(`Altitude: ${incident.altitudeM ?? worker?.altitudeM ?? '-'} m`);
  doc.moveDown();
  doc.fontSize(14).text('Platform note');
  doc.fontSize(10).text('This report contains telemetry recorded by ALTIGUARD. Validate field conditions and follow site emergency procedures.');
  if (incident.screenshot) {
    try { doc.moveDown().fontSize(14).text('Map snapshot'); doc.image(Buffer.from(incident.screenshot.split(',')[1], 'base64'), { fit: [500, 320] }); } catch {}
  }
  doc.end();
});

io.on('connection', socket => {
  socket.emit('snapshot', { workers: [...memory.workers.values()], zones: memory.zones, incidents: memory.incidents.slice(0, 50) });
});

async function seedMemoryIfDemo() {
  if (!demoMode) return;
  const seeded = [
    { id: 'demo-AG-001', name: 'Aarav Sharma', employeeCode: 'AG-001', status: 'ONLINE', lat: 20.7002, lng: 77.0084, altitudeM: 0, heartRate: 78, spo2: 98, lastSeen: new Date().toISOString() },
    { id: 'demo-AG-002', name: 'Rohan Patil', employeeCode: 'AG-002', status: 'ONLINE', lat: 20.7010, lng: 77.0101, altitudeM: 2.4, heartRate: 84, spo2: 97, lastSeen: new Date().toISOString() },
    { id: 'demo-AG-003', name: 'Imran Shaikh', employeeCode: 'AG-003', status: 'ONLINE', lat: 20.6996, lng: 77.0067, altitudeM: -1.2, heartRate: 91, spo2: 96, lastSeen: new Date().toISOString() }
  ];
  seeded.forEach(w => memory.workers.set(w.id, w));
}

setInterval(async()=>{
  const workers=await getWorkers(); const now=Date.now();
  for(const w of workers){if(w.lastSeen && now-new Date(w.lastSeen).getTime()>CONFIG.staleAfterMs && w.status==='ONLINE'){io.emit('worker:stale',{workerId:w.id,lastSeen:w.lastSeen});}}
}, Math.max(5000, CONFIG.staleAfterMs));
app.use((err,req,res,next)=>{console.error(err);if(res.headersSent)return next(err);res.status(500).json({error:'internal server error'});});
process.on('unhandledRejection',e=>console.error('Unhandled rejection',e));
seedMemoryIfDemo().then(() => server.listen(PORT, () => console.log(`ALTIGUARD running on http://localhost:${PORT}${demoMode ? ' (demo memory mode)' : ''}`)));

process.on('SIGINT', async () => { await prisma.$disconnect(); process.exit(0); });
process.on('SIGTERM', async () => { await prisma.$disconnect(); process.exit(0); });

// -----------------------------------------------------------------------------
// Operational reference constants.
// These named contracts make the backend easier to extend without scattering
// event names, state names and telemetry source strings across route handlers.
// -----------------------------------------------------------------------------
export const EVENTS = Object.freeze({
  WORKER_UPDATE:'worker:update', WORKER_DELETE:'worker:deleted', WORKER_STALE:'worker:stale',
  ZONE_CREATE:'zone:created', ZONE_DELETE:'zone:deleted', INCIDENT_NEW:'incident:new',
  INCIDENT_UPDATE:'incident:update', BROADCAST_NEW:'broadcast:new', BROADCAST_ACK:'broadcast:ack',
  AUDIT_NEW:'audit:new', SNAPSHOT:'snapshot'
});
export const INCIDENT_TYPES = Object.freeze({ALTITUDE_DROP:'ALTITUDE_DROP',ALTITUDE_JUMP:'ALTITUDE_JUMP',RED_ZONE_ENTRY:'RED_ZONE_ENTRY',LOW_SPO2:'LOW_SPO2',HEART_RATE_ANOMALY:'HEART_RATE_ANOMALY',LOW_BATTERY:'LOW_BATTERY'});
export const INCIDENT_STATES = Object.freeze({OPEN:'OPEN',ACKNOWLEDGED:'ACKNOWLEDGED',CLOSED:'CLOSED',RESOLVED:'RESOLVED'});
export const SEVERITIES = Object.freeze({NORMAL:'NORMAL',WARNING:'WARNING',HIGH:'HIGH',CRITICAL:'CRITICAL'});
export const TELEMETRY_SOURCES = Object.freeze({PHONE:'PHONE',PHONE_GPS:'PHONE_GPS',WEARABLE:'WEARABLE',CHEST_STRAP:'CHEST_STRAP',SIMULATION:'SIMULATION'});
function isAllowedSeverity(v){return Object.values(SEVERITIES).includes(v)}
function isAllowedIncidentState(v){return Object.values(INCIDENT_STATES).includes(v)}
function isAllowedTelemetrySource(v){return Object.values(TELEMETRY_SOURCES).includes(v)}
function normalizeSeverity(v){const s=safeString(v,'WARNING').toUpperCase();return isAllowedSeverity(s)?s:'WARNING'}
function normalizeIncidentState(v){const s=safeString(v,'OPEN').toUpperCase();return isAllowedIncidentState(s)?s:'OPEN'}
function normalizeSource(v){const s=safeString(v,'PHONE').toUpperCase();return isAllowedTelemetrySource(s)?s:'PHONE'}
function isCoordinatePair(v){return Array.isArray(v)&&v.length>=2&&finite(Number(v[0]))&&finite(Number(v[1]))}
function polygonAreaApprox(polygon){const ring=Array.isArray(polygon?.[0]?.[0])?polygon[0]:polygon;if(!Array.isArray(ring)||ring.length<3)return 0;let a=0;for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];if(!isCoordinatePair(p)||!isCoordinatePair(q))continue;a+=Number(p[0])*Number(q[1])-Number(q[0])*Number(p[1])}return Math.abs(a/2)}
function polygonIsUsable(polygon){if(!Array.isArray(polygon)||polygon.length<3)return false;const ring=Array.isArray(polygon[0]?.[0])?polygon[0]:polygon;return ring.length>=3&&ring.every(isCoordinatePair)&&polygonAreaApprox(ring)>0}
function sanitizeZonePayload(body){return {name:safeString(body.name).slice(0,120),kind:safeString(body.kind,'RED').toUpperCase().slice(0,30),severity:normalizeSeverity(body.severity),description:safeString(body.description).slice(0,500),polygon:body.polygon}}
function sanitizeBroadcastPayload(body){return {message:safeString(body.message).slice(0,1000),sender:safeString(body.sender,'ADMIN').slice(0,80),priority:normalizeSeverity(body.priority||'NORMAL'),target:safeString(body.target,'ALL').slice(0,80),expiresAt:body.expiresAt?new Date(body.expiresAt):null}}
function incidentPublicView(i){return {id:i.id,workerId:i.workerId||null,zoneId:i.zoneId||null,type:i.type,severity:i.severity,status:i.status,message:i.message,lat:i.lat,lng:i.lng,altitudeM:i.altitudeM,createdAt:i.createdAt,acknowledgedAt:i.acknowledgedAt||null,resolvedAt:i.resolvedAt||null}}
function workerPublicView(w){return {id:w.id,name:w.name,employeeCode:w.employeeCode,role:w.role,status:w.status,lat:w.lat,lng:w.lng,altitudeM:w.altitudeM,referenceM:w.referenceM,heartRate:w.heartRate,spo2:w.spo2,temperatureC:w.temperatureC,humidityPct:w.humidityPct,batteryPct:w.batteryPct,deviceId:w.deviceId,lastSeen:w.lastSeen}}
function healthState(){return {status:'ok',version:SERVER_VERSION,database:demoMode?'demo-memory':'postgresql',uptimeSeconds:Math.round(process.uptime()),timestamp:nowIso()}}
function staleCutoff(){return Date.now()-CONFIG.staleAfterMs}
function workerIsStale(w){return !w.lastSeen||new Date(w.lastSeen).getTime()<staleCutoff()}
function normalizeNumber(v){const n=Number(v);return Number.isFinite(n)?n:null}
function normalizeInt(v){const n=Number(v);return Number.isFinite(n)?Math.round(n):null}
function normalizePercent(v){const n=normalizeNumber(v);return n===null?null:clamp(n,0,100)}
function normalizeAngle(v){const n=normalizeNumber(v);return n===null?null:((n%360)+360)%360}
function telemetryAgeMs(w){return w?.lastSeen?Math.max(0,Date.now()-new Date(w.lastSeen).getTime()):Infinity}
function workerFreshness(w){const age=telemetryAgeMs(w);if(age===Infinity)return 'UNKNOWN';if(age>CONFIG.staleAfterMs)return 'STALE';return 'FRESH'}
function severityWeight(s){return {NORMAL:0,WARNING:1,HIGH:2,CRITICAL:3}[s]??0}
function sortIncidents(a,b){return severityWeight(b.severity)-severityWeight(a.severity)||new Date(b.createdAt)-new Date(a.createdAt)}
function sortWorkers(a,b){return String(a.name).localeCompare(String(b.name))}
function isOpenIncident(i){return ![INCIDENT_STATES.CLOSED,INCIDENT_STATES.RESOLVED].includes(i.status)}
function incidentNeedsImmediateAttention(i){return isOpenIncident(i)&&severityWeight(i.severity)>=severityWeight(SEVERITIES.HIGH)}
function telemetryHasVitals(t){return t.heartRate!==null||t.spo2!==null||t.temperatureC!==null||t.humidityPct!==null}
function telemetryHasPosition(t){return finite(t.lat)&&finite(t.lng)}
function telemetryHasMotion(t){return t.speedMps!==null||t.headingDeg!==null}
function telemetryQualityServer(t){let total=0,valid=0;for(const v of [telemetryHasPosition(t),finite(t.altitudeM),telemetryHasVitals(t),telemetryHasMotion(t),finite(t.batteryPct)]){total++;if(v)valid++}return Math.round(valid/total*100)}
function buildTelemetryAudit(t){return {workerId:t.workerId,source:t.source,quality:telemetryQualityServer(t),position:telemetryHasPosition(t),vitals:telemetryHasVitals(t),motion:telemetryHasMotion(t),receivedAt:nowIso()}}
function safeJson(value){try{return JSON.parse(JSON.stringify(value))}catch{return null}}
function boundedLimit(v,fallback=100,max=500){const n=Number(v);return Number.isInteger(n)&&n>0?Math.min(n,max):fallback}
function boundedHours(v,fallback=12,max=168){const n=Number(v);return Number.isFinite(n)&&n>0?Math.min(n,max):fallback}
function requestActor(req){return safeString(req?.headers?.['x-actor'],'ADMIN').slice(0,80)}
function requestCorrelation(req){return safeString(req?.headers?.['x-correlation-id'],makeId('req')).slice(0,100)}
function responseEnvelope(data,req){return {data,meta:{correlationId:requestCorrelation(req),timestamp:nowIso()}}}
function emitSafe(event,payload){try{io.emit(event,payload)}catch(e){console.error('socket emit failed',event,e.message)}}
function logRoute(req,extra={}){if(process.env.LOG_REQUESTS==='true')console.log(JSON.stringify({method:req.method,path:req.path,ip:req.ip,correlationId:requestCorrelation(req),...extra}))}
function ensureProductionGuard(){if(process.env.NODE_ENV==='production'&&!process.env.DATABASE_URL)console.warn('ALTIGUARD is running in memory mode in production. Do not use this configuration for a real site.')} 
function environmentSummary(){return {node:process.version,environment:process.env.NODE_ENV||'development',port:PORT,demoMode,telemetryIntervalMs:CONFIG.telemetryIntervalMs,staleAfterMs:CONFIG.staleAfterMs}}
function createSyntheticTelemetry(worker){return {workerId:worker.id,lat:Number(worker.lat),lng:Number(worker.lng),altitudeM:normalizeNumber(worker.altitudeM),heartRate:normalizeInt(worker.heartRate),spo2:normalizeNumber(worker.spo2),batteryPct:normalizePercent(worker.batteryPct),source:'SIMULATION'}}
function shouldCreateIncident(risk){return Boolean(risk&&risk.type&&risk.severity&&risk.message)}
function riskKey(workerId,risk){return `${workerId}:${risk.type}:${risk.zoneId||'global'}`}
function clearExpiredDedupe(){const cutoff=Date.now()-Math.max(CONFIG.geofenceCooldownMs*3,120000);for(const [key,time] of eventDedupe){if(time<cutoff)eventDedupe.delete(key)}}
function clearExpiredRateBuckets(){const cutoff=Date.now()-60000;for(const [key,times] of rateBuckets){const live=times.filter(t=>t>=cutoff);if(live.length)rateBuckets.set(key,live);else rateBuckets.delete(key)}}
setInterval(clearExpiredDedupe,60000).unref?.();
setInterval(clearExpiredRateBuckets,60000).unref?.();
ensureProductionGuard();
