'use strict';

/** WeightDisplayFilter：按设备、启动和校准版本隔离显示滤波；不改测量、稳定门槛或控制输入。
 * push(channel, context) 输入质量为 mg、时间为 ms；重复采样不会推进滤波。
 * 5 点中值消除孤立尖峰，时间常数 EMA 抑制抖动，大幅真实变化加快跟随。
 */
class WeightDisplayFilter {
  constructor(mode = 'balanced') { this.mode = mode; this.channels = new Map(); }
  reset() { this.channels.clear(); }
  setMode(mode) {
    this.mode = ['balanced', 'steady', 'device'].includes(mode) ? mode : 'balanced';
    this.reset();
  }
  push(channel, { device, boot, sequence, at, interval = 200 }) {
    const key = `${device}:${channel.channel}`;
    if (!channel.valid || !Number.isFinite(channel.filtered_mg)) { this.channels.delete(key); return null; }
    const identity = `${boot}:${channel.calibration_version ?? 0}`;
    const sample = channel.sample_sequence ?? sequence;
    const old = this.channels.get(key);
    if (old?.identity === identity && at >= old.at && at - old.at <= Math.max(1500, interval * 3)) {
      if (sample === old.sample) return old.shown;
      if (sample < old.sample) return old.shown;
      const dt = Math.max(1, at - old.at);
      old.values.push(channel.filtered_mg);
      // 慢速上报不积累数十秒窗口；中值窗口最多覆盖约 1 秒。
      const size=dt>=750 ? 1 : dt>=300 ? 3 : 5;
      while(old.values.length>size)old.values.shift();
      const ordered = [...old.values].sort((a,b)=>a-b);
      const median = ordered[Math.floor(ordered.length/2)];
      const delta = Math.abs(median - old.value);
      const fast = delta > Math.max(1000, (channel.noise_band_mg || 50) * 6);
      const tau = fast ? 140 : this.mode === 'steady' ? 1400 : 650;
      old.value = this.mode === 'device' ? channel.filtered_mg : old.value + (1 - Math.exp(-dt/tau)) * (median-old.value);
      // 仅对末位显示做 0.02 g 滞回；累计变化仍跟随，不进行自动去皮或归零。
      if (this.mode === 'device' || Math.abs(old.value-old.shown) >= 20) old.shown = Math.round(old.value);
      old.at=at; old.sample=sample;
      return old.shown;
    }
    const value=channel.filtered_mg;
    this.channels.set(key,{identity,sample,at,value,shown:value,values:[value]});
    return value;
  }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { WeightDisplayFilter };
else window.WeightDisplayFilter = WeightDisplayFilter;
