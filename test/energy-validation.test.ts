import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { robots } from '../src/domain/state.js';
import { estimatePlan } from '../src/services/navigation.js';

const robot = robots.find(r => r.id === 'AUV-07')!;
const CAP = robot.batteryCapacityWh; // 18000

// 生成一段直线航程的 waypoints，使其能耗落在目标区间
function waypointsForDistance(d: number) {
  return [
    { x: 0, y: 0, z: 50, dwellSec: 0, speedMs: 1.6 },
    { x: d, y: 0, z: 50, dwellSec: 0, speedMs: 1.6 },
  ];
}

// 能耗介于 50% 与 80% 电量之间（默认阈值放行、自定义 0.5 阈值拦截）
const MID_WPS = waypointsForDistance(17000);
const MID_ENERGY = estimatePlan(robot, MID_WPS).energyWh;
assert.ok(MID_ENERGY > CAP * 0.5 && MID_ENERGY < CAP * 0.8, `mid energy ${MID_ENERGY}`);

// 能耗超过 80% 电量的航程
const HUGE_WPS = waypointsForDistance(22000);
const HUGE_ENERGY = estimatePlan(robot, HUGE_WPS).energyWh;
assert.ok(HUGE_ENERGY > CAP * 0.8, `huge energy ${HUGE_ENERGY}`);

// 临界值：找到一段航程，使 maxEnergyFraction = energy/cap 在浮点下精确往返（energy === 阈值）
let EDGE_WPS: any = null;
let EDGE_FRACTION = 0;
for (let d = 12000; d < 21000; d++) {
  const wps = waypointsForDistance(d);
  const e = estimatePlan(robot, wps).energyWh;
  const f = e / CAP;
  if (CAP * f === e) { EDGE_WPS = wps; EDGE_FRACTION = f; break; }
}
assert.ok(EDGE_WPS, 'no exact boundary distance found');

async function setup(app: any, riskAcceptance?: any, waypoints = MID_WPS) {
  const m = await app.inject({ method: 'POST', url: '/api/missions', payload: { name: 't', robotId: 'AUV-07', ...(riskAcceptance ? { riskAcceptance } : {}) } });
  const mission = m.json();
  const p = await app.inject({ method: 'POST', url: `/api/missions/${mission.id}/plan`, payload: { waypoints } });
  const plan = p.json();
  const v = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/validate`, payload: {} });
  return { mission, plan: v.json() };
}

test('默认阈值：未设置 riskAcceptance 时按 80% 判断，能耗低于 80% 放行并可审批', async () => {
  const app = await buildApp();
  const { mission, plan } = await setup(app);
  assert.equal(plan.validation.valid, true);
  assert.equal(plan.status, 'validated');
  const approve = await app.inject({ method: 'POST', url: `/api/missions/${mission.id}/approve`, payload: {} });
  assert.equal(approve.statusCode, 200);
  assert.equal(approve.json().status, 'approved');
});

test('自定义阈值：maxEnergyFraction=0.5 时，超过 50% 的计划被阻止且无法审批', async () => {
  const app = await buildApp();
  const { mission, plan } = await setup(app, { maxDepthM: 1200, maxEnergyFraction: 0.5 });
  assert.equal(plan.validation.valid, false);
  assert.equal(plan.status, 'blocked');
  const failure = plan.validation.failures.find((f: any) => f.type === 'energy-budget');
  assert.ok(failure, 'expected energy-budget failure');
  assert.equal(failure.max, CAP * 0.5);
  assert.equal(failure.energyWh, MID_ENERGY);
  const approve = await app.inject({ method: 'POST', url: `/api/missions/${mission.id}/approve`, payload: {} });
  assert.equal(approve.statusCode, 409);
});

test('临界值：能耗恰好等于阈值时放行（严格大于才拦截）', async () => {
  const app = await buildApp();
  const { plan } = await setup(app, { maxDepthM: 1200, maxEnergyFraction: EDGE_FRACTION }, EDGE_WPS);
  assert.equal(plan.validation.estimate.energyWh, CAP * EDGE_FRACTION);
  assert.equal(plan.validation.valid, true);
  assert.equal(plan.status, 'validated');
});

test('超限：能耗超过默认 80% 上限的计划被阻止且无法审批', async () => {
  const app = await buildApp();
  const { mission, plan } = await setup(app, undefined, HUGE_WPS);
  assert.equal(plan.validation.valid, false);
  assert.equal(plan.status, 'blocked');
  const failure = plan.validation.failures.find((f: any) => f.type === 'energy-budget');
  assert.ok(failure, 'expected energy-budget failure');
  assert.equal(failure.max, CAP * 0.8);
  const approve = await app.inject({ method: 'POST', url: `/api/missions/${mission.id}/approve`, payload: {} });
  assert.equal(approve.statusCode, 409);
});
