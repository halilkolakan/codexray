/**
 * Render a shields.io-style SVG badge for CodeXray health scores
 */
export function renderScoreBadgeSvg(score: number | null): string {
  const label = 'CodeXray';
  const valueText = score !== null ? `Score ${score}/100` : 'Not Analyzed';

  // Color-coded green (>=80), amber (60-79), red (<60), slate (null)
  let rightColor = '#64748b';
  if (score !== null) {
    if (score >= 80) {
      rightColor = '#10b981'; // emerald-500
    } else if (score >= 60) {
      rightColor = '#f59e0b'; // amber-500
    } else {
      rightColor = '#ef4444'; // red-500
    }
  }

  const leftWidth = 68;
  const rightWidth = score !== null ? 88 : 92;
  const totalWidth = leftWidth + rightWidth;
  const leftCenter = Math.round(leftWidth / 2) * 10;
  const rightCenter = (leftWidth + Math.round(rightWidth / 2)) * 10;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${valueText}">
  <title>${label}: ${valueText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftWidth}" height="20" fill="#18181b"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${rightColor}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${leftCenter}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(leftWidth - 10) * 10}">${label}</text>
    <text x="${leftCenter}" y="140" transform="scale(.1)" fill="#22d3ee" font-weight="bold" textLength="${(leftWidth - 10) * 10}">${label}</text>
    <text aria-hidden="true" x="${rightCenter}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(rightWidth - 12) * 10}">${valueText}</text>
    <text x="${rightCenter}" y="140" transform="scale(.1)" fill="#fff" font-weight="bold" textLength="${(rightWidth - 12) * 10}">${valueText}</text>
  </g>
</svg>`;
}
