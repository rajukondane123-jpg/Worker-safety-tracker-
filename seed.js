import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const workers = [
  { name: 'Aarav Sharma', employeeCode: 'AG-001', lat: 20.7002, lng: 77.0084, altitudeM: 0.0 },
  { name: 'Rohan Patil', employeeCode: 'AG-002', lat: 20.7010, lng: 77.0101, altitudeM: 2.4 },
  { name: 'Imran Shaikh', employeeCode: 'AG-003', lat: 20.6996, lng: 77.0067, altitudeM: -1.2 }
];
for (const w of workers) {
  const worker = await prisma.worker.upsert({ where: { employeeCode: w.employeeCode }, update: w, create: w });
  await prisma.telemetry.create({ data: { workerId: worker.id, lat: w.lat, lng: w.lng, altitudeM: w.altitudeM } });
}
console.log('Seeded ALTIGUARD workers.');
await prisma.$disconnect();
