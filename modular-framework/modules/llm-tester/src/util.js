export function interpolate(str, vars) {
  if (!str || typeof str !== "string") return str;
  return str.replace(/\$\{artifact\.content\}/g, vars.artifactContent || "");
}

export function buildMessages(base, { artifactContent, ragContext, staticContext }) {
  const msgs = (base || []).map(m => ({ ...m, content: interpolate(m.content, { artifactContent }) }));
  const prefix = [];
  if (staticContext) prefix.push({ role: "system", content: staticContext });
  if (ragContext) prefix.push({ role: "system", content: `Domain context:\n${ragContext}` });
  return [...prefix, ...msgs];
}

export function countBullets(text) {
  return String(text).split(/\r?\n/).filter(l => /^\s*[-*]\s+/.test(l)).length;
}

export function assertAll({ completion, test }) {
  const results = [];
  let ok = true;

  // exact
  for (const s of (test.assert?.exact || [])) {
    const pass = completion.includes(s);
    results.push({ name: `exact:${s}`, ok: pass });
    ok &&= pass;
  }

  // regex
  for (let pattern of (test.assert?.regex || [])) {
    // Default to multiline+unicode for text assertions
    let flags = "mu";
    // Accept inline flags like (?imsgu) and merge them
    const m = pattern.match(/^\(\?([imsguy]+)\)/);
    if (m) {
      pattern = pattern.replace(/^\(\?[imsguy]+\)/, "");
      // merge unique flags
      flags = Array.from(new Set((flags + m[1]).split(""))).join("");
    }
    const pass = new RegExp(pattern, flags).test(completion);
    results.push({ name: `regex:${pattern}`, ok: pass });
    ok &&= pass;
  }

  // counts
  if (test.assert?.count) {
    const n = countBullets(completion);
    const { bulletsMin, bulletsMax } = test.assert.count;
    const pass = (bulletsMin==null || n >= bulletsMin) && (bulletsMax==null || n <= bulletsMax);
    results.push({ name: `count:bullets=${n}`, ok: pass });
    ok &&= pass;
  }

  // safety
  if (test.assert?.safety?.mustNotContain?.length) {
    for (const ban of test.assert.safety.mustNotContain) {
      const pass = !completion.includes(ban);
      results.push({ name: `safety:notContain:${ban}`, ok: pass });
      ok &&= pass;
    }
  }

  return { ok, results };
}
