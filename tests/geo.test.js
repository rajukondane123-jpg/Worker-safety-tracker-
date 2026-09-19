import test from 'node:test';
import assert from 'node:assert/strict';
import { pointInPolygon, pointToGeoJSON } from '../src-geo.js';

test('flat [lat,lng] polygon accepts an interior point', () => {
  const polygon = [[0,0],[0,1],[1,1],[1,0]];
  assert.equal(pointInPolygon(pointToGeoJSON(.5,.5), polygon), true);
});

test('flat polygon rejects an exterior point', () => {
  const polygon = [[0,0],[0,1],[1,1],[1,0]];
  assert.equal(pointInPolygon(pointToGeoJSON(2,2), polygon), false);
});

test('nested GeoJSON-style ring is also accepted', () => {
  const polygon = [[[0,0],[1,0],[1,1],[0,1]]];
  assert.equal(pointInPolygon([.5,.5], polygon), true);
});
