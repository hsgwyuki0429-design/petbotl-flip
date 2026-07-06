'use strict';

// ===== 基本設定 =====
const W = 480;
const H = 720;

const GRAVITY = 2200;        // px/s^2
const GROUND_Y = H - 150;    // テーブル面のY座標

// ボトルの物理サイズ(当たり判定用の矩形)
const BOT_W = 40;
const BOT_H = 106;

const RESTITUTION = 0.32;    // 反発係数
const FRICTION = 0.85;       // 接地時の横速度減衰
const ANGULAR_DAMP = 0.988;  // 空中の回転減衰

const UPRIGHT_TOL = 0.26;    // 直立判定の許容角度(rad)

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;

function fitCanvas() {
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = (W * scale) + 'px';
  canvas.style.height = (H * scale) + 'px';
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// ===== サウンド (WebAudio) =====
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) { /* 音なしで続行 */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function beep(freq, dur, type, vol, slide) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  gain.gain.setValueAtTime(vol || 0.15, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}
const sfx = {
  launch: () => beep(220, 0.25, 'triangle', 0.18, 500),
  bounce: () => beep(140, 0.08, 'square', 0.08, -60),
  success: () => { beep(660, 0.12, 'sine', 0.18); setTimeout(() => beep(880, 0.18, 'sine', 0.18), 90); },
  capflip: () => { beep(660, 0.1, 'sine', 0.18); setTimeout(() => beep(880, 0.1, 'sine', 0.18), 80); setTimeout(() => beep(1320, 0.25, 'sine', 0.2), 160); },
  fail: () => beep(160, 0.35, 'sawtooth', 0.12, -100),
  levelup: () => { beep(523, 0.1, 'square', 0.1); setTimeout(() => beep(784, 0.2, 'square', 0.1), 100); },
};

// ===== ゲーム状態 =====
const STATE = { TITLE: 0, IDLE: 1, CHARGING: 2, FLYING: 3, SETTLED: 4 };

const game = {
  state: STATE.TITLE,
  score: 0,
  best: Number(localStorage.getItem('petbotl-best') || 0),
  combo: 0,
  level: 0,
  power: 0,
  powerDir: 1,
  settleTimer: 0,
  flightTimer: 0,
  message: '',
  messageTimer: 0,
  messageColor: '#fff',
  shake: 0,
};

const bottle = {
  x: 0, y: 0,       // 中心座標
  vx: 0, vy: 0,
  angle: 0,         // rad (0 = 直立)
  va: 0,            // 角速度 rad/s
  slosh: 0,         // 水の揺れ(見た目用)
  sloshV: 0,
  restTimer: 0,     // 低エネルギー状態の継続時間
};

// 慣性モーメント(質量1の矩形)
const INERTIA = (BOT_W * BOT_W + BOT_H * BOT_H) / 12;

const particles = [];

function spinSpeed() {
  // レベルが上がると回転が速くなり、タイミングがシビアになる
  return 6.2 + game.level * 1.3;
}

function resetBottle() {
  bottle.x = W / 2;
  bottle.y = GROUND_Y - BOT_H / 2;
  bottle.vx = 0;
  bottle.vy = 0;
  bottle.angle = 0;
  bottle.va = 0;
  bottle.slosh = 0;
  bottle.sloshV = 0;
  bottle.restTimer = 0;
}
resetBottle();

function showMessage(text, color) {
  game.message = text;
  game.messageColor = color || '#fff';
  game.messageTimer = 1.6;
}

function launch() {
  const p = game.power;
  bottle.vy = -(620 + p * 780);
  bottle.vx = (Math.random() - 0.5) * 30;
  bottle.va = -(spinSpeed() * (0.55 + p * 0.75));
  game.state = STATE.FLYING;
  game.flightTimer = 0;
  sfx.launch();
}

function spawnParticles(x, y, color, n) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 80 + Math.random() * 260;
    particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 150,
      life: 0.6 + Math.random() * 0.5,
      maxLife: 1,
      color,
      size: 3 + Math.random() * 4,
    });
  }
}

function normalizeAngle(a) {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function settle() {
  game.state = STATE.SETTLED;
  game.settleTimer = 1.2;
  const a = Math.abs(normalizeAngle(bottle.angle));

  if (a < UPRIGHT_TOL) {
    // 直立成功!
    game.combo++;
    const pts = 1 * Math.max(1, game.combo);
    game.score += pts;
    showMessage(game.combo > 1 ? `ナイスフリップ! コンボ x${game.combo} +${pts}` : `ナイスフリップ! +${pts}`, '#7CFC9A');
    spawnParticles(bottle.x, bottle.y, '#7CFC9A', 24);
    sfx.success();
  } else if (Math.abs(a - Math.PI) < UPRIGHT_TOL) {
    // キャップ着地(逆立ち)は大ボーナス!
    game.combo++;
    const pts = 5 * Math.max(1, game.combo);
    game.score += pts;
    showMessage(`キャップフリップ!! +${pts}`, '#FFD35A');
    spawnParticles(bottle.x, bottle.y, '#FFD35A', 40);
    sfx.capflip();
  } else {
    // 失敗
    game.combo = 0;
    showMessage('しっぱい…', '#FF7B7B');
    game.shake = 8;
    sfx.fail();
  }

  if (game.score > game.best) {
    game.best = game.score;
    localStorage.setItem('petbotl-best', String(game.best));
  }

  const newLevel = Math.floor(game.score / 10);
  if (newLevel > game.level) {
    game.level = newLevel;
    setTimeout(() => {
      showMessage(`レベル ${game.level + 1}! 回転スピードUP!`, '#7BD4FF');
      sfx.levelup();
    }, 900);
  }
}

// ===== 物理 =====
function bottleCorners() {
  const c = Math.cos(bottle.angle);
  const s = Math.sin(bottle.angle);
  const hw = BOT_W / 2;
  const hh = BOT_H / 2;
  const pts = [];
  for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
    pts.push({
      x: bottle.x + lx * c - ly * s,
      y: bottle.y + lx * s + ly * c,
      rx: lx * c - ly * s,
      ry: lx * s + ly * c,
    });
  }
  return pts;
}

function physicsStep(dt) {
  bottle.vy += GRAVITY * dt;
  bottle.x += bottle.vx * dt;
  bottle.y += bottle.vy * dt;
  bottle.angle += bottle.va * dt;
  bottle.va *= ANGULAR_DAMP;

  // 壁で軽く跳ね返す
  const margin = BOT_H / 2;
  if (bottle.x < margin) { bottle.x = margin; bottle.vx = Math.abs(bottle.vx) * 0.5; }
  if (bottle.x > W - margin) { bottle.x = W - margin; bottle.vx = -Math.abs(bottle.vx) * 0.5; }

  // 地面(テーブル)との衝突: 角ごとのインパルス法
  let contact = false;
  for (let iter = 0; iter < 4; iter++) {
    let deepest = null;
    for (const p of bottleCorners()) {
      if (p.y > GROUND_Y && (!deepest || p.y > deepest.y)) deepest = p;
    }
    if (!deepest) break;
    contact = true;

    // めり込み補正
    bottle.y -= (deepest.y - GROUND_Y);

    // 接触点の速度 (v + ω × r)
    const vpy = bottle.vy + bottle.va * deepest.rx;
    if (vpy > 0) {
      // 低速の衝突は反発させない(微振動でいつまでも静止しないのを防ぐ)
      const e = vpy > 140 ? RESTITUTION : 0;
      const j = -(1 + e) * vpy / (1 + (deepest.rx * deepest.rx) / INERTIA);
      bottle.vy += j;
      bottle.va += (j * deepest.rx) / INERTIA;
      bottle.vx *= FRICTION;
      if (Math.abs(vpy) > 120) sfx.bounce();
    } else {
      break;
    }
  }

  // 水の揺れ(バネ)
  const target = Math.max(-1, Math.min(1, bottle.va * 0.15 + bottle.vx * 0.002));
  const spring = (target - bottle.slosh) * 30;
  bottle.sloshV += spring * dt;
  bottle.sloshV *= 0.92;
  bottle.slosh += bottle.sloshV * dt * 10;

  // 静止判定: 接地付近で低エネルギー状態が一定時間続いたら着地確定
  let touching = contact;
  if (!touching) {
    for (const p of bottleCorners()) {
      if (p.y > GROUND_Y - 1.5) { touching = true; break; }
    }
  }
  if (touching &&
      Math.abs(bottle.vx) < 25 &&
      Math.abs(bottle.vy) < 55 &&
      Math.abs(bottle.va) < 1.2) {
    bottle.restTimer += dt;
    // 追加の減衰で微振動を殺す
    bottle.va *= 0.92;
    bottle.vx *= 0.9;
  } else {
    bottle.restTimer = 0;
  }

  game.flightTimer += dt;

  // 保険: 長時間暴れたら強制終了
  if (bottle.restTimer > 0.3 || game.flightTimer > 6) {
    snapPose();
    settle();
  }
}

// 最終姿勢をきれいに揃える(直立/逆立ち/横倒し)
function snapPose() {
  const a = normalizeAngle(bottle.angle);
  if (Math.abs(a) < UPRIGHT_TOL) {
    bottle.angle = 0;
    bottle.y = GROUND_Y - BOT_H / 2;
  } else if (Math.abs(Math.abs(a) - Math.PI) < UPRIGHT_TOL) {
    bottle.angle = Math.PI;
    bottle.y = GROUND_Y - BOT_H / 2;
  } else {
    bottle.angle = a > 0 ? Math.PI / 2 : -Math.PI / 2;
    bottle.y = GROUND_Y - BOT_W / 2;
  }
  bottle.vx = bottle.vy = bottle.va = 0;
}

// ===== 入力 =====
function pressStart() {
  ensureAudio();
  if (game.state === STATE.TITLE) {
    game.state = STATE.IDLE;
    return;
  }
  if (game.state === STATE.SETTLED && game.settleTimer < 0.9) {
    // 着地演出中でも次のチャージを始められる
    resetBottle();
    game.state = STATE.IDLE;
  }
  if (game.state === STATE.IDLE) {
    game.state = STATE.CHARGING;
    game.power = 0;
    game.powerDir = 1;
  }
}
function pressEnd() {
  if (game.state === STATE.CHARGING) {
    launch();
  }
}

canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); pressStart(); });
window.addEventListener('pointerup', () => pressEnd());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat) { e.preventDefault(); pressStart(); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { e.preventDefault(); pressEnd(); }
});

// ===== 描画 =====
function drawBackground() {
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#1b2a4a');
  grad.addColorStop(0.7, '#2d4a73');
  grad.addColorStop(1, '#3a5f8a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // 星
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 40; i++) {
    const x = (i * 137.5) % W;
    const y = (i * 89.3) % (GROUND_Y * 0.7);
    const tw = 0.5 + 0.5 * Math.sin(performance.now() / 700 + i);
    ctx.globalAlpha = 0.2 + 0.4 * tw;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.globalAlpha = 1;

  // 窓と月
  ctx.fillStyle = 'rgba(255, 244, 200, 0.9)';
  ctx.beginPath();
  ctx.arc(W - 90, 110, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(27, 42, 74, 0.35)';
  ctx.beginPath();
  ctx.arc(W - 102, 100, 30, 0, Math.PI * 2);
  ctx.fill();
}

function drawTable() {
  // テーブル天板
  ctx.fillStyle = '#8a5a33';
  ctx.fillRect(0, GROUND_Y, W, 18);
  ctx.fillStyle = '#6f4626';
  ctx.fillRect(0, GROUND_Y + 18, W, 8);
  // 木目
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  for (let x = 20; x < W; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y + 3);
    ctx.lineTo(x + 30, GROUND_Y + 15);
    ctx.stroke();
  }
  // 脚
  ctx.fillStyle = '#5d3a1f';
  ctx.fillRect(40, GROUND_Y + 26, 22, H - GROUND_Y - 26);
  ctx.fillRect(W - 62, GROUND_Y + 26, 22, H - GROUND_Y - 26);
  // 床
  ctx.fillStyle = '#243447';
  ctx.fillRect(0, H - 24, W, 24);
}

function drawBottle() {
  ctx.save();
  ctx.translate(bottle.x, bottle.y);
  ctx.rotate(bottle.angle);

  const hw = BOT_W / 2;
  const hh = BOT_H / 2;

  // 影(接地時のみ、回転を打ち消して描く)
  ctx.save();
  ctx.rotate(-bottle.angle);
  const groundDist = GROUND_Y - bottle.y;
  if (groundDist < 260) {
    const sh = Math.max(0, 1 - groundDist / 260);
    ctx.fillStyle = `rgba(0,0,0,${0.25 * sh})`;
    ctx.beginPath();
    ctx.ellipse(0, groundDist, 34 * (0.5 + 0.5 * sh) + 14, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // ボトル本体(ペットボトル型のパス)
  const bodyTop = -hh + 30;   // 肩の位置
  ctx.beginPath();
  ctx.moveTo(-hw + 6, hh);                                  // 底左
  ctx.lineTo(hw - 6, hh);
  ctx.quadraticCurveTo(hw, hh, hw, hh - 8);                 // 底の角丸
  ctx.lineTo(hw, bodyTop + 14);
  ctx.quadraticCurveTo(hw, bodyTop, hw - 12, bodyTop - 8);  // 肩
  ctx.lineTo(11, -hh + 8);                                  // ネック
  ctx.lineTo(-11, -hh + 8);
  ctx.lineTo(-hw + 12, bodyTop - 8);
  ctx.quadraticCurveTo(-hw, bodyTop, -hw, bodyTop + 14);
  ctx.lineTo(-hw, hh - 8);
  ctx.quadraticCurveTo(-hw, hh, -hw + 6, hh);
  ctx.closePath();

  ctx.fillStyle = 'rgba(210, 235, 250, 0.35)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(230, 245, 255, 0.8)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 水(ボトルの下 40% 、slosh で傾く)
  ctx.save();
  ctx.clip();
  const waterTop = hh - BOT_H * 0.4;
  const tilt = bottle.slosh * 10;
  ctx.beginPath();
  ctx.moveTo(-hw, waterTop - tilt);
  ctx.lineTo(hw, waterTop + tilt);
  ctx.lineTo(hw, hh);
  ctx.lineTo(-hw, hh);
  ctx.closePath();
  ctx.fillStyle = 'rgba(70, 160, 235, 0.75)';
  ctx.fill();
  // 水面のハイライト
  ctx.strokeStyle = 'rgba(180, 225, 255, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-hw, waterTop - tilt);
  ctx.lineTo(hw, waterTop + tilt);
  ctx.stroke();
  ctx.restore();

  // ラベル
  ctx.fillStyle = '#4fa3e0';
  ctx.fillRect(-hw, -6, BOT_W, 26);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('AQUA', 0, 7);

  // ハイライト(光沢)
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(-hw + 5, bodyTop, 5, hh - bodyTop - 10);

  // キャップ
  ctx.fillStyle = '#e04f6a';
  ctx.fillRect(-12, -hh - 4, 24, 14);
  ctx.fillStyle = '#c03852';
  ctx.fillRect(-12, -hh + 6, 24, 4);

  ctx.restore();
}

function drawPowerGauge() {
  if (game.state !== STATE.CHARGING) return;
  const gw = 200;
  const gh = 18;
  const gx = (W - gw) / 2;
  const gy = GROUND_Y + 60;

  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(gx - 4, gy - 4, gw + 8, gh + 8, 8);
  ctx.fill();

  const p = game.power;
  const hue = 120 - p * 120; // 緑→赤
  ctx.fillStyle = `hsl(${hue}, 85%, 55%)`;
  roundRect(gx, gy, gw * p, gh, 5);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('パワー', W / 2, gy - 14);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawHUD() {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // スコア
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 52px sans-serif';
  ctx.fillText(String(game.score), W / 2, 78);

  ctx.font = 'bold 14px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(`ベスト: ${game.best}`, W / 2, 102);

  if (game.combo > 1) {
    ctx.fillStyle = '#FFD35A';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText(`🔥 ${game.combo} コンボ`, W / 2, 128);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = 'bold 13px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`レベル ${game.level + 1}`, 14, 26);

  // メッセージ
  if (game.messageTimer > 0) {
    const alpha = Math.min(1, game.messageTimer / 0.4);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = game.messageColor;
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(game.message, W / 2, 190);
    ctx.globalAlpha = 1;
  }

  // 操作ガイド
  if (game.state === STATE.IDLE) {
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 350);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 17px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('長押しでパワーをためて、離してフリップ!', W / 2, GROUND_Y + 78);
    ctx.globalAlpha = 1;
  }
}

function drawTitle() {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#7BD4FF';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('ペットボトル', W / 2, H / 2 - 90);
  ctx.fillStyle = '#FFD35A';
  ctx.font = 'bold 56px sans-serif';
  ctx.fillText('フリップ!', W / 2, H / 2 - 30);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText('ボトルを投げて、きれいに着地させよう', W / 2, H / 2 + 30);
  ctx.fillText('キャップ着地は 5倍ボーナス!', W / 2, H / 2 + 58);

  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
  ctx.globalAlpha = 0.5 + 0.5 * pulse;
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('タップ / スペースキーでスタート', W / 2, H / 2 + 130);
  ctx.globalAlpha = 1;
}

function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

// ===== メインループ =====
let lastTime = performance.now();

function frame(now) {
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  if (dt > 0.05) dt = 0.05;

  // 更新
  if (game.state === STATE.CHARGING) {
    game.power += game.powerDir * dt / 0.9; // 0.9秒で満タン→折り返し
    if (game.power >= 1) { game.power = 1; game.powerDir = -1; }
    if (game.power <= 0) { game.power = 0; game.powerDir = 1; }
    // チャージ中はぷるぷる震える
    bottle.angle = Math.sin(now / 40) * 0.03 * game.power;
  } else if (game.state === STATE.FLYING) {
    physicsStep(dt);
  } else if (game.state === STATE.SETTLED) {
    game.settleTimer -= dt;
    if (game.settleTimer <= 0) {
      resetBottle();
      game.state = STATE.IDLE;
    }
  }

  if (game.messageTimer > 0) game.messageTimer -= dt;
  if (game.shake > 0) game.shake = Math.max(0, game.shake - dt * 30);

  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += GRAVITY * 0.4 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) particles.splice(i, 1);
  }

  // 描画
  ctx.save();
  if (game.shake > 0) {
    ctx.translate((Math.random() - 0.5) * game.shake, (Math.random() - 0.5) * game.shake);
  }
  drawBackground();
  drawTable();
  drawBottle();
  drawParticles();
  drawPowerGauge();
  drawHUD();
  ctx.restore();

  if (game.state === STATE.TITLE) drawTitle();

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
