import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { robots } from '../src/domain/state.js';
import { estimatePlan } from '../src/services/navigation.js';

const app = await buildApp();
// AUV-07：batteryCapacityWh = 18000 → 默认阈值 0.8 = 14400 Wh，自定义 0.5 = 9000 Wh
const robot = robots[0];
const START = { x: 0, y: 0, z: 100 };

// 直线航线：从 START 出发沿 x 轴飞行 distanceM，避开禁入区（z=100 不在 200~500m 深度带内）
function waypoints(distanceM: number) {
  return [
    { x: 0, y: 0, z: 100, dwellSec: 0, speedMs: 1.6 },
    { x: distanceM, y: 0, z: 100, dwellSec: 0, speedMs: 1.6 },
  ];
}

// 二分查找一段航程，使 estimatePlan 的能耗恰好等于 targetWh（不硬编码能耗公式系数）
function distanceForEnergy(targetWh: number) {
  let lo = 0, hi = 100_000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const energy = estimatePlan(robot, waypoints(mid), START).energyWh;
    if (energy === targetWh) return mid;
    if (energy < targetWh) lo = mid; else hi = mid;
  }
  throw new Error(`无法构造能耗恰好为 ${targetWh} Wh 的航线`);
}

async function createMission(riskAcceptance?: any) {
  const res = await app.inject({ method: 'POST', url: '/api/missions', payload: { name: '能耗阈值测试', robotId: robot.id, ...(riskAcceptance ? { riskAcceptance } : {}) } });
  assert.equal(res.statusCode, 200);
  return res.json();
}

async function createAndValidate(missionId: string, energyWh: number) {
  const planRes = await app.inject({ method: 'POST', url: `/api/missions/${missionId}/plan`, payload: { waypoints: waypoints(distanceForEnergy(energyWh)) } });
  assert.equal(planRes.statusCode, 200);
  const plan = planRes.json();
  const valRes = await app.inject({ method: 'POST', url: `/api/plans/${plan.id}/validate`, payload: { startPosition: START } });
  assert.equal(valRes.statusCode, 200);
  return valRes.json();
}

async function approve(missionId: string) {
  return app.inject({ method: 'POST', url: `/api/missions/${missionId}/approve`, payload: { operator: 'tester' } });
}

test('默认阈值：未设置 riskAcceptance 时按电池 80%（14400 Wh）校验', async () => {
  const m = await createMission();
  assert.equal(m.riskAcceptance.maxEnergyFraction, 0.8);

  // 14000 Wh < 14400 Wh → 校验通过，且可正常审批
  const ok = await createAndValidate(m.id, 14000);
  assert.equal(ok.validation.estimate.energyWh, 14000);
  assert.equal(ok.validation.valid, true);
  assert.equal(ok.status, 'validated');
  const approved = await approve(m.id);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().status, 'approved');

  // 15000 Wh > 14400 Wh → 被阻止，审批拒绝
  const m2 = await createMission();
  const over = await createAndValidate(m2.id, 15000);
  assert.equal(over.validation.valid, false);
  assert.equal(over.status, 'blocked');
  const failure = over.validation.failures.find((f: any) => f.type === 'energy-budget');
  assert.equal(failure.max, 14400);
  assert.equal(failure.maxEnergyFraction, 0.8);
  assert.equal((await approve(m2.id)).statusCode, 409);
});

test('自定义阈值：maxEnergyFraction=0.5 时按 9000 Wh 校验', async () => {
  // 10000 Wh 介于 9000 与 14400 之间：旧的硬编码 80% 逻辑会放行，修复后必须阻止
  const m = await createMission({ maxDepthM: 1200, maxEnergyFraction: 0.5 });
  const blocked = await createAndValidate(m.id, 10000);
  assert.equal(blocked.validation.estimate.energyWh, 10000);
  assert.equal(blocked.validation.valid, false);
  assert.equal(blocked.status, 'blocked');
  const failure = blocked.validation.failures.find((f: any) => f.type === 'energy-budget');
  assert.equal(failure.max, 9000);
  assert.equal(failure.maxEnergyFraction, 0.5);
  assert.equal((await approve(m.id)).statusCode, 409);

  // 8000 Wh < 9000 Wh → 校验通过，可审批
  const m2 = await createMission({ maxDepthM: 1200, maxEnergyFraction: 0.5 });
  const ok = await createAndValidate(m2.id, 8000);
  assert.equal(ok.validation.valid, true);
  assert.equal(ok.status, 'validated');
  assert.equal((await approve(m2.id)).statusCode, 200);
});

test('临界值：能耗恰好等于阈值时通过，略超即阻止', async () => {
  // 能耗 == 阈值（9000 Wh）：判断为严格大于，恰好达到上限应放行
  const m = await createMission({ maxEnergyFraction: 0.5 });
  const exact = await createAndValidate(m.id, 9000);
  assert.equal(exact.validation.estimate.energyWh, 9000);
  assert.equal(exact.validation.valid, true);
  assert.equal(exact.status, 'validated');
  assert.equal((await approve(m.id)).statusCode, 200);

  // 能耗仅超 0.01 Wh → 阻止且不可审批
  const m2 = await createMission({ maxEnergyFraction: 0.5 });
  const justOver = await createAndValidate(m2.id, 9000.01);
  assert.equal(justOver.validation.estimate.energyWh, 9000.01);
  assert.equal(justOver.validation.valid, false);
  assert.equal(justOver.status, 'blocked');
  assert.equal((await approve(m2.id)).statusCode, 409);
});

test('超限：远超任务阈值的计划被阻止且无法通过审批', async () => {
  const m = await createMission({ maxEnergyFraction: 0.5 });
  const plan = await createAndValidate(m.id, 20000);
  assert.equal(plan.validation.valid, false);
  assert.equal(plan.status, 'blocked');
  const failure = plan.validation.failures.find((f: any) => f.type === 'energy-budget');
  assert.equal(failure.energyWh, 20000);
  assert.equal(failure.max, 9000);
  assert.equal((await approve(m.id)).statusCode, 409);
});

test('默认值处理：riskAcceptance 缺少 maxEnergyFraction 时回退到 0.8', async () => {
  const m = await createMission({ maxDepthM: 800 });
  assert.equal(m.riskAcceptance.maxEnergyFraction, undefined);

  // 10000 Wh 超过 0.5 阈值但低于默认 14400 Wh → 回退默认后应通过
  const ok = await createAndValidate(m.id, 10000);
  assert.equal(ok.validation.valid, true);
  assert.equal((await approve(m.id)).statusCode, 200);

  // 15000 Wh 超过默认 14400 Wh → 仍被阻止
  const m2 = await createMission({ maxDepthM: 800 });
  const over = await createAndValidate(m2.id, 15000);
  assert.equal(over.validation.valid, false);
  assert.equal(over.validation.failures.find((f: any) => f.type === 'energy-budget').max, 14400);
  assert.equal((await approve(m2.id)).statusCode, 409);
});
