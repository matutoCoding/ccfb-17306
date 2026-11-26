import sweWgsl from './shallowWater.wgsl?raw';
import renderWgsl from './render.wgsl?raw';
import type { ReplayFrame } from '../domain/types';

export async function getGpuDevice(): Promise<GPUDevice | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    return await adapter.requestDevice();
  } catch {
    return null;
  }
}

export class GpuSweCompute {
  device: GPUDevice;
  cols: number;
  rows: number;
  dx: number;
  pipeline: GPUComputePipeline;
  paramsBuffer: GPUBuffer;
  elevBuffer: GPUBuffer;
  maskBuffer: GPUBuffer;
  h: [GPUBuffer, GPUBuffer];
  hu: [GPUBuffer, GPUBuffer];
  hv: [GPUBuffer, GPUBuffer];
  bindGroups: [GPUBindGroup, GPUBindGroup];
  parity = 0;
  n: number;

  private constructor(device: GPUDevice, cols: number, rows: number, dx: number, elev: Float32Array, mask: Uint32Array) {
    this.device = device;
    this.cols = cols;
    this.rows = rows;
    this.dx = dx;
    this.n = cols * rows;
    const module = device.createShaderModule({ code: sweWgsl });
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' }
    });
    this.paramsBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.elevBuffer = device.createBuffer({ size: this.n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.maskBuffer = device.createBuffer({ size: this.n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.elevBuffer, 0, elev as Float32Array<ArrayBuffer>);
    device.queue.writeBuffer(this.maskBuffer, 0, mask as Uint32Array<ArrayBuffer>);

    const makePair = () => [
      device.createBuffer({ size: this.n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }),
      device.createBuffer({ size: this.n * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
    ] as [GPUBuffer, GPUBuffer];
    this.h = makePair();
    this.hu = makePair();
    this.hv = makePair();

    const makeGroup = (inIndex: 0 | 1, outIndex: 0 | 1) => device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.elevBuffer } },
        { binding: 2, resource: { buffer: this.maskBuffer } },
        { binding: 3, resource: { buffer: this.h[inIndex] } },
        { binding: 4, resource: { buffer: this.hu[inIndex] } },
        { binding: 5, resource: { buffer: this.hv[inIndex] } },
        { binding: 6, resource: { buffer: this.h[outIndex] } },
        { binding: 7, resource: { buffer: this.hu[outIndex] } },
        { binding: 8, resource: { buffer: this.hv[outIndex] } }
      ]
    });
    this.bindGroups = [makeGroup(0, 1), makeGroup(1, 0)];
  }

  static async create(cols: number, rows: number, dx: number, elev: Float32Array, mask: Uint32Array): Promise<GpuSweCompute | null> {
    const device = await getGpuDevice();
    if (!device) return null;
    return new GpuSweCompute(device, cols, rows, dx, elev, mask);
  }

  writeInitial(h: Float32Array, hu?: Float32Array, hv?: Float32Array) {
    this.device.queue.writeBuffer(this.h[0], 0, h as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.h[1], 0, h as Float32Array<ArrayBuffer>);
    const z = new Float32Array(this.n);
    this.device.queue.writeBuffer(this.hu[0], 0, (hu ?? z) as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.hu[1], 0, (hu ?? z) as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.hv[0], 0, (hv ?? z) as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.hv[1], 0, (hv ?? z) as Float32Array<ArrayBuffer>);
    this.parity = 0;
  }

  step(dt: number, rainRateMS = 0, infiltrationRateMS = 0) {
    const params = new ArrayBuffer(32);
    const u32 = new Uint32Array(params, 0, 2);
    const f32 = new Float32Array(params);
    u32[0] = this.cols;
    u32[1] = this.rows;
    f32[2] = dt;
    f32[3] = this.dx;
    f32[4] = 9.81;
    f32[5] = 1e-5;
    f32[6] = rainRateMS;
    f32[7] = infiltrationRateMS;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, params);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[this.parity]);
    pass.dispatchWorkgroups(Math.ceil(this.cols / 16), Math.ceil(this.rows / 16));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.parity = 1 - this.parity;
  }

  async readDepth(): Promise<Float32Array> {
    const src = this.h[this.parity];
    const read = this.device.createBuffer({ size: this.n * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, read, 0, this.n * 4);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    read.destroy();
    return out;
  }

  dispose() {
    for (const b of [this.paramsBuffer, this.elevBuffer, this.maskBuffer, ...this.h, ...this.hu, ...this.hv]) b.destroy();
  }
}

export class GpuMapRenderer {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  pipeline: GPURenderPipeline;
  uniform: GPUBuffer;
  depth: GPUBuffer;
  mu: GPUBuffer;
  mv: GPUBuffer;
  elev: GPUBuffer;
  mask: GPUBuffer;
  bindGroup: GPUBindGroup;
  cols = 1;
  rows = 1;
  n = 1;

  private constructor(canvas: HTMLCanvasElement, device: GPUDevice) {
    this.device = device;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('当前浏览器无法取得 WebGPU canvas context');
    this.context = ctx;
    this.format = navigator.gpu?.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
    ctx.configure({ device, format: this.format, alphaMode: 'premultiplied' });
    const module = device.createShaderModule({ code: renderWgsl });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' }
    });
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.depth = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mu = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mv = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.elev = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mask = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.depth } },
        { binding: 2, resource: { buffer: this.mu } },
        { binding: 3, resource: { buffer: this.mv } },
        { binding: 4, resource: { buffer: this.elev } },
        { binding: 5, resource: { buffer: this.mask } }
      ]
    });
  }

  static async create(canvas: HTMLCanvasElement): Promise<GpuMapRenderer | null> {
    const device = await getGpuDevice();
    if (!device) return null;
    return new GpuMapRenderer(canvas, device);
  }

  ensureSize(cols: number, rows: number) {
    const n = cols * rows;
    if (n === this.n && cols === this.cols) return;
    this.cols = cols; this.rows = rows; this.n = n;
    for (const b of [this.depth, this.mu, this.mv, this.elev, this.mask]) b.destroy();
    const size = Math.max(4, n * 4);
    this.depth = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mu = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mv = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.elev = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.mask = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: { buffer: this.depth } },
        { binding: 2, resource: { buffer: this.mu } },
        { binding: 3, resource: { buffer: this.mv } },
        { binding: 4, resource: { buffer: this.elev } },
        { binding: 5, resource: { buffer: this.mask } }
      ]
    });
  }

  updateFrame(frame: ReplayFrame, maxDepth = 2.5, timeSec = 0) {
    this.ensureSize(frame.cols, frame.rows);
    this.device.queue.writeBuffer(this.depth, 0, frame.depth as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.mu, 0, frame.u as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.mv, 0, frame.v as Float32Array<ArrayBuffer>);
    const elev = frame.elev ?? new Float32Array(this.n);
    const mask = frame.mask ?? new Uint8Array(this.n).fill(1);
    this.device.queue.writeBuffer(this.elev, 0, elev as Float32Array<ArrayBuffer>);
    this.device.queue.writeBuffer(this.mask, 0, new Uint32Array(mask) as Uint32Array<ArrayBuffer>);
    const u = new Float32Array([frame.cols, frame.rows, maxDepth, timeSec]);
    this.device.queue.writeBuffer(this.uniform, 0, u as Float32Array<ArrayBuffer>);
  }

  render() {
    const encoder = this.device.createCommandEncoder();
    const view = this.context.getCurrentTexture().createView();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, clearValue: { r: 0.05, g: 0.07, b: 0.09, a: 1 }, loadOp: 'clear', storeOp: 'store' }]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
