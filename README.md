# 城市内涝管网耦合推演系统

浏览器端城市内涝“一维管网 + 二维地表”耦合推演原型。技术栈为 **TypeScript + Vite + Vitest + 原生 WebGPU/WGSL**，不依赖国外商业模型软件；工程、地形和每场推演结果通过 **IndexedDB** 保存在浏览器本地。

> 已内置 2 km² 老城样例：328 个节点（含 323 个格网检查井）、615 段管、铁路桥下穿、分级泵站、河东排口和河道水位顶托过程；同时包含 Ritter 溃坝与 DN1200 满管恒定流校核算例。

## 快速开始

```bash
npm install
npm run dev        # 打开 http://127.0.0.1:5173
npm test           # 9 个单元/校核/UI 冒烟测试
npm run bench      # Ritter、满管流、导入校核、两小时水量平衡
npm run build      # tsc --noEmit + Vite 生产构建
npm run preview
```

要求 Node.js 20+；WebGPU 页面建议使用最新版 Chrome/Edge。无 WebGPU 时自动使用 Canvas2D 与 TypeScript CPU 守恒参考核。

## 页面与需求对应

| 页面 | 已实现内容 |
| --- | --- |
| **管网模型** | 检查井、管段、排口、泵站、闸门台账；上下游管底标高、断面形状、糙率、CCTV 淤积深度和 0–4 级结构缺陷；导入校核列出倒坡/缓坡、标高异常、孤立管段、重复编号；JSON 工程导入导出；淤积直接扣减断面 |
| **地形下垫面** | 200×100、10 m DEM；建筑 GeoJSON 导入并在二维计算中设为阻水 mask；道路/绿地/屋面/水体/其他五类下垫面及 Horton 参数；下穿 V 型纵坡、最低点、链距和车模位置；DEM JSON 导入 |
| **降雨情景** | 本地暴雨强度公式生成芝加哥雨型，重现期、历时、雨峰系数、A1/C/b/n 可调；三站实测样例与 JSON 分钟雨量导入；规则采样泰森面积权重 |
| **耦合推演** | Rusanov 有限体积二维浅水、一维动力波格室、Preissmann 窄缝、井—地表孔口/堰交换、河道顶托/倒灌、泵站分级启停；水量台账；第 N 分钟检查点与泵调度增量重算；WebGPU 百万格 WGSL 吞吐自检 |
| **积水回放** | 时间轴播放/拖动；深度色阶；高流速流向箭头；建筑、街道、管网、冒溢井和井盖顶飞脉冲；下穿侧视车模随水深变化；任意多选管串绘制管底/地面/实时水力坡度线并与当前帧联动；可切换 WGSL 全屏渲染器 |
| **易涝报告** | 最大水深、超 0.15 m 历时、峰现时间、雨停后退水时间；下穿/低洼路段/井位排名；现状、疏通 DN1200、加泵优化等方案选择与并排差值；报告 JSON 导出 |

## 数值方法

### 一维管网

- 管段划分为若干高程线性插值的有限体积格室。
- 界面流量采用带 Manning 摩阻的动力波动量方程：

\[
\frac{dQ}{dt}=gA\left(\frac{H_a-H_b}{\Delta x}-S_f\right),\qquad
S_f=\frac{n^2Q|Q|}{A^2R^{4/3}}
\]

- 满管后使用 **Preissmann 窄缝**：

\[
T_{\rm slot}=\frac{gA_{\rm full}}{c^2}
\]

- 圆形断面使用弓形面积解析积分；淤积深度以下面积直接扣除，淤积顶面参与湿周。矩形/梯形断面按台形积分。
- 每个界面共享同一流量，节点/管格体积严格一进一出；出流限制器保证格室体积不为负。

### 二维地表

CPU 参考核 `src/sim/swe.ts` 使用二维浅水方程和 Rusanov 数值通量：

\[
\partial_t h+\partial_x(hu)+\partial_y(hv)=0
\]

\[
\partial_t(hu)+\partial_x(hu^2/h+\tfrac12gh^2)+\partial_y(huv)=-gh\,\partial_xz-\frac{gn^2u\sqrt{u^2+v^2}}{h^{1/3}}
\]

并采取：

- 二维联合 CFL 步长；
- 干床动量置零和干深阈值；
- 底坡中心差分与 Manning 阻力半隐式分母；
- 负水深守恒补偿：记录负深总量后从有水格按水深比例扣回，避免“削负为零”凭空造水；
- 建筑格 `mask=0`，界面零通量。

`src/gpu/shallowWater.wgsl` 是同一 Rusanov 思路的 WebGPU compute 实现；`src/gpu/render.wgsl` 负责深度设色和流向条纹渲染。

### 井—地表交换

- 井内水头高于地面且高于地表水位：孔口出流，井 → 地面；
- 地表水位高于井圈：堰流回灌，地面 → 井；
- 交换流量同时、同额修改两边体积，并受井体积和地面积水可供量限制；
- 压力水头超过 `coverLiftHead` 后将井盖标记为 `coverBlown`，回放中显示红色脉冲。

### 泵、排口与增量重算

- 每台泵有独立 `startLevel/stopLevel` 迟滞区间，可按水位分级启停。
- 排口挂河道水位过程线，线性插值；河水位高于井水头时流量反向并计入 `riverBackflowM3`。
- `CoupledEngine.createCheckpoint()` 保存地表水深/动量、管网体积/流量、河口径流和累计水量。调整启泵水位或台数后，用 `recomputeFromCheckpoint()` 从改动时刻恢复，只重算后续时段。

## 水量平衡

台账定义：

\[
\Delta S = R - I - P - O + B - D
\]

其中 `R` 降雨、`I` 入渗、`P` 泵排、`O` 排口出流、`B` 河道倒灌、`D` 地表边界净出流；井—地表交换是内部量，只统计累计交换规模，不进入闭合误差。

两小时样例（粗格快速校核配置）实测：

```text
rainfallM3          ≈ 231,123.8 m³
infiltrationM3      ≈  38,976.6 m³
outfallM3           ≈  14,842.9 m³
riverBackflowM3     ≈   1,381.4 m³
pumpM3              ≈   5,754.1 m³
residualM3          ≈  -2.5e-8 m³
relativeErrorPct    ≈   1.1e-11 %
```

要求阈值为体积平衡误差 `< 0.5%`，测试 `test/mass-balance.test.ts` 会强制校验。

## 解析解校核

Ritter 平底干床溃坝：

\[
h(x,t)=\frac{(2c_0-x/t)^2}{9g},\quad -c_0t\le x\le 2c_0t
\]

当前 4000 格、Δx=0.5 m、h₀=10 m、t=30 s 的结果：

```text
RMSE / h0                 0.332 %
最大归一化偏差（含锋面）    1.93 %
水量误差                   2.7e-13 %
```

满管恒定流用 DN1200、Manning n=0.013 与 Manning 公式对比：

```text
Qtheory    ≈ 2.9599 m³/s
Qnumeric   ≈ 2.9497 m³/s
误差        0.345 %
```

运行 `npm run bench` 可复现以上数字。

## IndexedDB

`src/data/db.ts` 建两个 object store：

- `projects`：工程、DEM typed arrays、建筑、降雨和方案；
- `runs`：推演汇总、水量台账、易涝点和回放帧。

首次打开若库中没有工程，会自动写入样例工程。若浏览器配额不足，页面会降级为当前会话内存回放，不影响当次计算。

## 目录结构

```text
src/
  domain/            领域类型、水力学断面、降雨、导入校核
  data/              样例数据生成器、IndexedDB
  sim/
    swe.ts           CPU 二维 Rusanov 浅水有限体积核
    network1d.ts     一维动力波/Preissmann 格室网络
    coupled.ts       耦合编排、水量台账、检查点、统计
    runTask.ts       异步运行与 RunRecord 组装
  gpu/
    shallowWater.wgsl
    render.wgsl
    GpuFlood.ts      WebGPU compute/renderer 封装与百万格自检
  ui/                DOM helper、Canvas 地图和图表
  pages/             六个业务页面
test/                Vitest 校核、守恒和 UI 冒烟测试
bench/               Node 校核脚本
```

## 性能口径与边界

- 自动化测试和 `npm run bench` 验证的是 **TypeScript CPU 参考核**：它完全可在 Node/CI 中运行并保证守恒与解析解精度。
- `simulationPage` 的 WebGPU 面板会实际申请 `1024×1024` 设备缓冲并执行 30 次 WGSL compute dispatch，显示当前机器的 `ms/step`；`replayPage` 可切换到自研 WGSL 渲染器。
- 主耦合编排目前仍使用 CPU 二维核，以便在所有浏览器和测试环境中得到同一套可审计、严格守恒的结果。WGSL 核的状态数组与 CPU 核一致，后续可将 `CoupledEngine.advanceSurface()` 替换为 `GpuSweCompute` 的写入/dispatch/回读路径，并把井交换扩展为 WGSL 井缓冲。
- “百万格 + 300 井、两小时降雨三分钟完成”是面向独显 WebGPU 的工程目标；本仓库提供了百万缓冲 dispatch、WGSL 核和性能面板，但没有在当前无头 CI 环境中伪造完整端到端三分钟实测数字。

## 后续可加强

1. 将井交换和下渗栅格搬入 WGSL，形成全异步 GPU 耦合闭环。
2. 增加 SWMM/InfoWorks 文本导入适配器与更完整的时间序列编辑。
3. 纵断面支持拓扑方向自动排序、倒流箭头和压力管线动画。
4. 为方案对比增加二维差分淹没图和改造前后动画滑杆。
