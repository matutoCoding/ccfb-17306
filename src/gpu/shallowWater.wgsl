struct Params {
  cols: u32,
  rows: u32,
  dt: f32,
  dx: f32,
  gravity: f32,
  dryDepth: f32,
  rainRate: f32,
  infiltrationRate: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elev: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var<storage, read> hIn: array<f32>;
@group(0) @binding(4) var<storage, read> huIn: array<f32>;
@group(0) @binding(5) var<storage, read> hvIn: array<f32>;
@group(0) @binding(6) var<storage, read_write> hOut: array<f32>;
@group(0) @binding(7) var<storage, read_write> huOut: array<f32>;
@group(0) @binding(8) var<storage, read_write> hvOut: array<f32>;

fn vel(q: f32, h: f32) -> f32 {
  if (h <= 1e-6) { return 0.0; }
  return q / h;
}

fn rusanovX(hL: f32, qxL: f32, qyL: f32, hR: f32, qxR: f32, qyR: f32) -> vec3<f32> {
  let g = params.gravity;
  if (hL <= 1e-6 && hR <= 1e-6) { return vec3<f32>(0.0); }
  let uL = vel(qxL, hL);
  let uR = vel(qxR, hR);
  let cL = sqrt(g * max(hL, 0.0));
  let cR = sqrt(g * max(hR, 0.0));
  let s = max(abs(uL) + cL, abs(uR) + cR);
  let fL = vec3<f32>(qxL, qxL * qxL / max(hL, 1e-6) + 0.5 * g * hL * hL, qxL * qyL / max(hL, 1e-6));
  let fR = vec3<f32>(qxR, qxR * qxR / max(hR, 1e-6) + 0.5 * g * hR * hR, qxR * qyR / max(hR, 1e-6));
  let du = vec3<f32>(hR - hL, qxR - qxL, qyR - qyL);
  return 0.5 * (fL + fR) - 0.5 * s * du;
}

fn rusanovY(hB: f32, qxB: f32, qyB: f32, hT: f32, qxT: f32, qyT: f32) -> vec3<f32> {
  let g = params.gravity;
  if (hB <= 1e-6 && hT <= 1e-6) { return vec3<f32>(0.0); }
  let vB = vel(qyB, hB);
  let vT = vel(qyT, hT);
  let cB = sqrt(g * max(hB, 0.0));
  let cT = sqrt(g * max(hT, 0.0));
  let s = max(abs(vB) + cB, abs(vT) + cT);
  let fB = vec3<f32>(qyB, qxB * qyB / max(hB, 1e-6), qyB * qyB / max(hB, 1e-6) + 0.5 * g * hB * hB);
  let fT = vec3<f32>(qyT, qxT * qyT / max(hT, 1e-6), qyT * qyT / max(hT, 1e-6) + 0.5 * g * hT * hT);
  let du = vec3<f32>(hT - hB, qxT - qxB, qyT - qyB);
  return 0.5 * (fB + fT) - 0.5 * s * du;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let c = gid.x;
  let r = gid.y;
  if (c >= params.cols || r >= params.rows) { return; }
  let cols = params.cols;
  let i = r * cols + c;
  if (mask[i] == 0u) {
    hOut[i] = 0.0; huOut[i] = 0.0; hvOut[i] = 0.0;
    return;
  }

  var h = max(hIn[i], 0.0);
  var hu = huIn[i];
  var hv = hvIn[i];

  // 源项：降雨与 Horton/下垫面下渗容量（CPU 传当前网格等效速率）
  h = h + params.rainRate * params.dt;
  let inf = min(h, params.infiltrationRate * params.dt);
  h = h - inf;

  let l = select(i - 1u, i, c == 0u);
  let rr = select(i + 1u, i, c + 1u >= params.cols);
  let b = select(i - cols, i, r == 0u);
  let t = select(i + cols, i, r + 1u >= params.rows);

  var hL = hIn[l]; var huL = huIn[l]; var hvL = hvIn[l];
  var hR = hIn[rr]; var huR = huIn[rr]; var hvR = hvIn[rr];
  var hB = hIn[b]; var huB = huIn[b]; var hvB = hvIn[b];
  var hT = hIn[t]; var huT = huIn[t]; var hvT = hvIn[t];

  // 闭合/反射边界
  if (c == 0u) { huL = -huR; hvL = hvR; hL = hR; }
  if (c + 1u >= params.cols) { huR = -huL; hvR = hvL; hR = hL; }
  if (r == 0u) { hvB = -hvT; huB = huT; hB = hT; }
  if (r + 1u >= params.rows) { hvT = -hvB; huT = huB; hT = hB; }

  let fLeft = rusanovX(hL, huL, hvL, h, hu, hv);
  let fRight = rusanovX(h, hu, hv, hR, huR, hvR);
  let fBottom = rusanovY(hB, huB, hvB, h, hu, hv);
  let fTop = rusanovY(h, hu, hv, hT, huT, hvT);

  let dx = params.dx;
  var hn = h - params.dt / dx * (fRight.x - fLeft.x + fTop.x - fBottom.x);
  var hun = hu - params.dt / dx * (fRight.y - fLeft.y + fTop.y - fBottom.y);
  var hvn = hv - params.dt / dx * (fRight.z - fLeft.z + fTop.z - fBottom.z);

  // 底坡源与 Manning 阻力的 GPU 轻量形式；CPU 参考核含完整诊断
  let dzdx = (elev[rr] - elev[l]) / (2.0 * dx);
  let dzdy = (elev[t] - elev[b]) / (2.0 * dx);
  hn = max(hn, 0.0);
  let hm = max(hn, params.dryDepth);
  hun = hun - params.dt * 9.81 * hm * dzdx;
  hvn = hvn - params.dt * 9.81 * hm * dzdy;
  if (hn <= params.dryDepth) {
    hun = 0.0; hvn = 0.0;
  } else {
    let speed = length(vec2<f32>(hun, hvn) / hm);
    let n = 0.032;
    let den = 1.0 + params.dt * 9.81 * n * n * speed / pow(hm, 1.0 / 3.0);
    hun = hun / den;
    hvn = hvn / den;
  }

  hOut[i] = hn;
  huOut[i] = hun;
  hvOut[i] = hvn;
}
