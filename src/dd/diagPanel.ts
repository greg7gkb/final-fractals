/**
 * diagPanel.ts — full-detail overlay shown when ?diag is in the URL
 *
 * The title-bar chip already tells you "DD inactive" or not. This panel adds
 * per-test detail so you can see exactly which primitive is broken and what
 * the actual-vs-expected numbers look like.
 */
import type { ValidationResult } from './validate.js';

export function renderDiagPanel(result: ValidationResult): void {
  const panel = document.createElement('div');
  panel.id = 'dd-diag-panel';
  panel.style.cssText = `
    position: fixed;
    top: 16px;
    left: 16px;
    max-width: 560px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    background: rgba(10, 10, 16, 0.92);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 10px;
    padding: 14px 16px;
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 11px;
    line-height: 1.5;
    color: #e8e8e8;
    z-index: 100;
  `;

  const header = document.createElement('div');
  header.style.cssText = 'font-size: 13px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;';
  if (result.error) {
    header.innerHTML = `<span style="color:#ff8080;">⚠</span> DD validator could not run`;
  } else {
    const total = result.results.length;
    const passed = result.results.filter(r => r.passed).length;
    const ok = result.allPassed;
    header.innerHTML = `<span style="color:${ok ? '#7ddcaa' : '#ff8080'};">${ok ? '✓' : '✗'}</span> DD validation — ${passed}/${total} passed`;
  }
  panel.appendChild(header);

  const sub = document.createElement('div');
  sub.style.cssText = 'color: #888; margin-bottom: 12px;';
  sub.textContent = 'GPU dd primitives tested against float64 reference values. Failures indicate the GLSL→native compiler has elided the dd error-reconstruction (most likely cause: TwoSum / TwoProd algebraic simplification on this driver).';
  panel.appendChild(sub);

  if (result.error) {
    const err = document.createElement('div');
    err.style.cssText = 'background: rgba(255,128,128,0.1); border: 1px solid rgba(255,128,128,0.3); border-radius: 6px; padding: 8px 10px; color: #ffa0a0;';
    err.textContent = result.error;
    panel.appendChild(err);
  } else {
    for (const r of result.results) {
      panel.appendChild(renderTestRow(r));
    }
  }

  document.body.appendChild(panel);
}

function renderTestRow(r: { name: string; why: string; passed: boolean; expected: [number, number]; actual: [number, number] }): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = `
    margin-bottom: 10px;
    padding: 8px 10px;
    background: rgba(255,255,255,0.03);
    border-left: 3px solid ${r.passed ? '#7ddcaa' : '#ff8080'};
    border-radius: 4px;
  `;
  const title = document.createElement('div');
  title.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
  title.innerHTML = `<span style="color:${r.passed ? '#7ddcaa' : '#ff8080'};">${r.passed ? '✓' : '✗'}</span> ${escape(r.name)}`;
  row.appendChild(title);

  const why = document.createElement('div');
  why.style.cssText = 'color: #aaa; margin-bottom: 5px; font-family: inherit;';
  why.textContent = r.why;
  row.appendChild(why);

  const nums = document.createElement('div');
  nums.style.cssText = 'color: #ccc; font-size: 10.5px;';
  nums.innerHTML = `
    expected hi=${fmt(r.expected[0])}  lo=${fmt(r.expected[1])}<br>
    actual&nbsp;&nbsp; hi=${fmt(r.actual[0])}  lo=${fmt(r.actual[1])}
  `;
  row.appendChild(nums);

  return row;
}

function fmt(n: number): string {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e-3 && abs < 1e6) return n.toPrecision(8);
  return n.toExponential(6);
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}
