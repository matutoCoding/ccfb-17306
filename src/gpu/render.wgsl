struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  var out: VertexOutput;
  let pos = p[vi];
  out.position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = vec2<f32>((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
  return out;
}

struct RenderParams {
  cols: f32,
  rows: f32,
  maxDepth: f32,
  time: f32,
};

@group(0) @binding(0) var<uniform> rp: RenderParams;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
@group(0) @binding(2) var<storage, read> momentumU: array<f32>;
@group(0) @binding(3) var<storage, read> momentumV: array<f32>;
@group(0) @binding(4) var<storage, read> elevation: array<f32>;
@group(0) @binding(5) var<storage, read> mask: array<u32>;

fn depthColor(d: f32) -> vec3<f32> {
  let t = clamp(d / max(rp.maxDepth, 0.2), 0.0, 1.0);
  let shallow = vec3<f32>(0.72, 0.91, 0.98);
  let mid = vec3<f32>(0.13, 0.59, 0.95);
  let deep = vec3<f32>(0.03, 0.18, 0.48);
  if (t < 0.55) { return mix(shallow, mid, t / 0.55); }
  return mix(mid, deep, (t - 0.55) / 0.45);
}

@fragment
fn fsMain(in: VertexOutput) -> @location(0) vec4<f32> {
  let c = clamp(u32(in.uv.x * rp.cols), 0u, u32(rp.cols) - 1u);
  let r = clamp(u32(in.uv.y * rp.rows), 0u, u32(rp.rows) - 1u);
  let i = r * u32(rp.cols) + c;

  // 地形高程做微弱晕渲，建筑/阻水块呈深灰
  let z = elevation[i];
  let shade = 0.88 + 0.08 * sin(z * 1.7);
  var base = vec3<f32>(0.34, 0.42, 0.36) * shade;
  if (mask[i] == 0u) { base = vec3<f32>(0.16, 0.17, 0.20); }

  let d = max(depth[i], 0.0);
  var color = base;
  if (d > 0.02) {
    let water = depthColor(d);
    let alpha = clamp(0.28 + d * 0.55, 0.0, 0.92);
    color = mix(base, water, alpha);

    // 高流速处生成沿流向移动的细条纹
    let h = max(d, 0.05);
    let u = momentumU[i] / h;
    let v = momentumV[i] / h;
    let speed = length(vec2<f32>(u, v));
    if (speed > 0.35) {
      let dir = normalize(vec2<f32>(u, v) + vec2<f32>(1e-5));
      let cellUv = fract(in.uv * vec2<f32>(rp.cols, rp.rows) * 0.18);
      let along = dot(cellUv - 0.5, dir);
      let stripe = smoothstep(0.42, 0.5, abs(fract(along * 3.0 - rp.time * speed * 1.7) - 0.5));
      color = mix(color, vec3<f32>(0.86, 0.97, 1.0), stripe * clamp(speed / 3.0, 0.15, 0.7));
    }
  }
  return vec4<f32>(color, 1.0);
}
