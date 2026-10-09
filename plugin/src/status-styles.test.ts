import { readFileSync } from "node:fs";
import { describe,expect,it } from "vitest";

const css=readFileSync(new URL("../styles.css",import.meta.url),"utf8");
function keyframes(name:string){
  const start=css.indexOf(`@keyframes ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth=0,end=start;
  for(let i=css.indexOf("{",start);i<css.length;i++){
    if(css[i]==="{")depth++;
    if(css[i]==="}"&&--depth===0){end=i+1;break;}
  }
  return css.slice(start,end);
}

describe("checking indicator animation",()=>{
  it("changes only the checkmark color without scaling, fading or filtering",()=>{
    const frames=keyframes("gib-sync-check-hue");
    expect(frames).toContain("color: var(--color-green)");
    expect(frames).toContain("var(--color-green) 96%");
    expect(frames).toContain("var(--color-cyan, var(--color-green)) 4%");
    expect(frames).not.toMatch(/transform|opacity|filter|width|height/);
  });
  it("limits the slow hue cycle to verified green checking icons",()=>{
    expect(css).toContain(".is-checking.is-success.is-animated .gib-sync-indicator-icon { animation: gib-sync-check-hue 3.6s ease-in-out infinite;");
    expect(css).not.toMatch(/indicator-icon\s*\{\s*animation:\s*gib-sync-pulse/);
  });
  it("keeps the mobile checking dot still except for its subtle color shift",()=>{
    expect(css).toContain(".is-checking.is-animated .gib-sync-indicator-dot { animation: none;");
    const frames=keyframes("gib-sync-check-dot-hue");
    expect(frames).toContain("border-color:");expect(frames).toContain("background-color:");
    expect(frames).not.toMatch(/transform|opacity|filter|width|height/);
  });
  it("preserves reduced-motion support and the actual-transfer loading ring",()=>{
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".gib-sync-indicator.is-animated .gib-sync-indicator-dot,");
    expect(css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)")).split("}")[0]).toContain("animation: none !important;");
    expect(css).toContain(".gib-sync-progress-ring.is-indeterminate { animation: gib-sync-ring 1s linear infinite;");
  });
});
