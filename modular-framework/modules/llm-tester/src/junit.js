export function toJUnitXml({ suiteName, runs }) {
  const tcs = runs.map(r => {
    const durationSec = Math.max(0, ((new Date(r.endedAt) - new Date(r.startedAt)) / 1000));
    const assertions = (r.assertions || []).map(a => `${a.name}: ${a.ok ? "PASS" : "FAIL"}${a.score!=null?` (score=${a.score})`:""}${a.why?` - ${a.why}`:""}`).join("\n");
    const sysout = escapeXml((r.artifacts?.completion || "").slice(0, 2000));
    if (r.ok) {
      return `<testcase classname="${escapeXml(r.suite)}" name="${escapeXml(r.testId)}" time="${durationSec.toFixed(3)}">
  <system-out>${sysout}</system-out>
  <system-err>${escapeXml(assertions)}</system-err>
</testcase>`;
    } else {
      return `<testcase classname="${escapeXml(r.suite)}" name="${escapeXml(r.testId)}" time="${durationSec.toFixed(3)}">
  <failure message="Assertions failed">${escapeXml(assertions)}</failure>
  <system-out>${sysout}</system-out>
</testcase>`;
    }
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${escapeXml(suiteName)}" tests="${runs.length}" failures="${runs.filter(r=>!r.ok).length}">
${tcs}
</testsuite>`;
}

function escapeXml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}
