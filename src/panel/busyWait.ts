/** 同步忙等，模拟真实业务函数约 0.4ms 的 CPU 耗时 */
export function busyWait(ms: number): void {
  if (ms <= 0) return
  const start = performance.now()
  while (performance.now() - start < ms) {
    // busy-wait
  }
}
