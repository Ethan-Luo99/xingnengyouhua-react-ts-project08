let summaryRenderCount = 0

export function getSummaryRenderCount(): number {
  return summaryRenderCount
}

export function bumpSummaryRenderCount(): void {
  summaryRenderCount += 1
}
