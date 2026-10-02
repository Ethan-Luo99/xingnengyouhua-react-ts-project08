export function busyWait(ms: number): void {
  if (ms <= 0) return
  const end = performance.now() + ms
  while (performance.now() < end) {
    // 同步空转，模拟真实业务计算对主线程的占用
  }
}
