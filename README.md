# multichannel-downmixer

纯 Node.js 多声道音频下混库（无播放、无原生依赖）。输入为按明确布局排列的
float32 平面（planar）PCM，支持 mono / stereo / 5.1 / 7.1，提供每声道增益、
LFE 混入控制、目标峰值检查与分块安全的增益平滑。

## 安装与测试

```bash
npm test   # 即 node --test
```

要求 Node.js >= 18（使用 `node:test`）。

## 声道布局与顺序

输入/输出均为**平面数组**：每个声道一个 `Float32Array`（或普通数组），数组顺序
必须等于下表的规范顺序（也可用 `channelOrder` 显式声明自定义顺序，必须是规范
顺序的精确排列，否则抛 `RangeError`）。

| 布局      | 声道顺序（索引升序）                        |
| --------- | ------------------------------------------- |
| `mono`    | `M`                                         |
| `stereo`  | `L, R`                                      |
| `5.1`     | `L, R, C, LFE, Ls, Rs`                      |
| `7.1`     | `L, R, C, LFE, Ls, Rs, Lrs, Rrs`            |

`Ls/Rs` 为侧环绕，`Lrs/Rrs` 为后环绕。只支持下混或同布局直通，不支持上混
（输出声道数大于输入时抛 `RangeError`）。LFE 不能作为独立输出布局
（`outputLayout: 'lfe'` 会抛出明确错误）。

## 下混系数

`k = 1/√2 ≈ 0.7071`（-3.01 dB）。矩阵行 = 输出声道，列 = 输入声道。

**→ stereo（Lo/Ro）**

| 输出 | L   | R   | C   | Ls  | Rs  | Lrs | Rrs | M   | LFE            |
| ---- | --- | --- | --- | --- | --- | --- | --- | --- | -------------- |
| L'   | 1   |     | k   | k   |     | k   |     | 1   | `lfeGain`*     |
| R'   |     | 1   | k   |     | k   |     | k   | 1   | `lfeGain`*     |

**→ mono**

| 输出 | L   | R   | C   | Ls  | Rs  | Lrs | Rrs | M   | LFE        |
| ---- | --- | --- | --- | --- | --- | --- | --- | --- | ---------- |
| M'   | k   | k   | 1   | 0.5 | 0.5 | 0.5 | 0.5 | 1   | `lfeGain`* |

**7.1 → 5.1**：`Ls' = Ls + k·Lrs`，`Rs' = Rs + k·Rrs`，其余声道（含 LFE）直通。

\* LFE 默认**丢弃**（`includeLfe: false`）；设 `includeLfe: true` 后按
`lfeGain`（默认 0.5）混入左右/单声道输出。输出布局本身含 LFE 声道时 LFE 始终直通。

## 用法

```js
import { Downmixer } from 'multichannel-downmixer';

const dm = new Downmixer({
  inputLayout: '5.1',
  outputLayout: 'stereo',
  sampleRate: 48000,
  channelGains: { C: 1.5, Ls: 0.7 }, // 每个源声道的目标增益
  includeLfe: false,                 // 是否把 LFE 混入非 LFE 输出
  lfeGain: 0.5,
  targetPeak: 1.0,                   // 整体目标峰值
  smoothingMs: 5,                    // 增益平滑时间常数；0 = 立即生效
  // channelOrder: [...],            // 可选：声明输入缓冲的实际声道顺序
  // autoAttenuate: false,           // true 时超限自动衰减到 targetPeak
});

dm.setChannelGain('C', 2.0); // 运行中改增益，按 smoothingMs 平滑过渡

const result = dm.process([fl, fr, fc, lfe, ls, rs]);
// result = {
//   channels: [Float32Array L', Float32Array R'],
//   frameCount, peak, limited,
//   requiredAttenuationDb,   // 超限时需要的衰减量（dB），否则为 0
//   clippedSamples: [{ channel, index, value }, ...], // 超限样本位置
// }
```

## 峰值行为

下混后逐样本检查峰值。**绝不静默削波**：当 `peak > targetPeak` 时返回
`limited: true`、所需衰减量 `requiredAttenuationDb` 以及全部超限样本的
`{channel, index, value}` 位置，输出保持原值由调用方决定如何处理；只有显式
设置 `autoAttenuate: true` 才会把输出整体缩放到 `targetPeak`。

## 分块处理

`Downmixer` 实例是有状态的：增益变化通过一阶平滑器逐样本过渡，平滑器状态
跨 `process()` 调用延续。因此把同一流切成任意大小的块依次处理，与一次性
处理的结果**逐位一致**——分块边界不会被当作新的独立音频。开始一段无关的
新流时调用 `reset()` 清除状态。

## 错误与边界行为

| 情况                                   | 行为                                             |
| -------------------------------------- | ------------------------------------------------ |
| 声道缓冲数与布局不符                   | 抛 `RangeError`                                  |
| 各声道帧数不一致                       | 抛 `RangeError`                                  |
| 样本为 `NaN` / `Infinity`              | 抛 `TypeError`，消息含声道名与帧号               |
| `channelOrder` 不是布局的精确排列      | 抛 `RangeError`                                  |
| `outputLayout: 'lfe'`（LFE 单独输出）  | 抛 `RangeError`（明确说明不支持）                |
| 未知布局名 / 上混请求                  | 抛 `RangeError`                                  |
| 增益或 `targetPeak` 非法（负数、NaN）  | 抛 `RangeError`                                  |
| 空帧（0 帧）输入                       | 正常返回空输出，`peak: 0`，`limited: false`      |
