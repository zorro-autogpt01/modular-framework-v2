// Lightweight validation helpers (no external deps)

function isPlainObject(v) {
  return Object.prototype.toString.call(v) === '[object Object]';
}

function str() {
  const rules = [];
  const api = {
    min(n) { rules.push(v => (typeof v === 'string' && v.trim().length >= n) || `min:${n}`); return api; },
    max(n) { rules.push(v => (typeof v === 'string' && v.length <= n) || `max:${n}`); return api; },
    optional() { api._optional = true; return api; },
    _type: 'string', _optional: false, _rules: rules
  };
  return api;
}

function num() {
  const rules = [];
  const api = {
    min(n){ rules.push(v => (typeof v === 'number' && v >= n) || `min:${n}`); return api; },
    max(n){ rules.push(v => (typeof v === 'number' && v <= n) || `max:${n}`); return api; },
    integer(){ rules.push(v => Number.isInteger(v) || 'integer'); return api; },
    optional(){ api._optional = true; return api; },
    _type: 'number', _optional: false, _rules: rules
  };
  return api;
}

function bool() {
  const api = { _type: 'boolean', _optional: false, optional(){ api._optional = true; return api; } };
  return api;
}

function oneOf(arr) {
  const api = { _type: 'oneOf', _vals: arr, _optional: false, optional(){ api._optional = true; return api; } };
  return api;
}

function obj() {
  const api = { _type: 'object', _optional: false, optional(){ api._optional = true; return api; } };
  return api;
}

function validate(input, schema) {
  const errors = {};
  for (const [key, rule] of Object.entries(schema || {})) {
    const val = input?.[key];
    if (val == null) {
      if (!rule._optional) errors[key] = 'required';
      continue;
    }
    switch (rule._type) {
      case 'string':
        if (typeof val !== 'string') { errors[key] = 'string'; break; }
        for (const r of rule._rules) { const ok = r(val); if (ok !== true) { errors[key] = ok; break; } }
        break;
      case 'number':
        if (typeof val !== 'number' || Number.isNaN(val)) { errors[key] = 'number'; break; }
        for (const r of rule._rules) { const ok = r(val); if (ok !== true) { errors[key] = ok; break; } }
        break;
      case 'boolean':
        if (typeof val !== 'boolean') errors[key] = 'boolean';
        break;
      case 'oneOf':
        if (!rule._vals.includes(val)) errors[key] = `oneOf:${rule._vals.join(',')}`;
        break;
      case 'object':
        if (!isPlainObject(val)) errors[key] = 'object';
        break;
      default:
        break;
    }
  }
  if (Object.keys(errors).length) {
    const err = new Error('validation_error');
    err.status = 400;
    err.details = errors;
    throw err;
  }
  return input;
}

module.exports = { str, num, bool, oneOf, obj, validate };
