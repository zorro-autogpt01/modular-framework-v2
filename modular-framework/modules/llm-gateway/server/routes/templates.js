const express = require('express');
const router = express.Router();
const { ah } = require('../utils/asyncHandler');
const { validate, str, bool, obj } = require('../utils/validate');
const {
  listTemplates, getTemplate, getTemplateByName, 
  createTemplate, updateTemplate, deleteTemplate
} = require('../db');
const { logInfo, logDebug } = require('../logger');

// Helper to substitute variables in template
function substituteTemplate(template, variables) {
  if (!template || !variables) return template;
  
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    result = result.replace(pattern, String(value));
  }
  return result;
}

// Helper to extract variable names from template
function extractVariables(template) {
  if (!template) return [];
  const matches = template.match(/{{(.*?)}}/g) || [];
  return matches.map(m => m.replace(/[{}]/g, '').trim());
}

// List templates
router.get('/templates', ah(async (req, res) => {
  logInfo('GW /api/templates list', { 
    query: req.query, 
    ip: req.ip 
  });

  const opts = {
    archived: req.query.archived === 'true',
    tags: req.query.tags ? req.query.tags.split(',') : null
  };

  const items = await listTemplates(opts);
  res.json({ items });
}));

// Get template by ID
router.get('/templates/:id', ah(async (req, res) => {
  logInfo('GW /api/templates get', { 
    id: req.params.id, 
    ip: req.ip 
  });

  const tmpl = await getTemplate(Number(req.params.id));
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  
  res.json({ template: tmpl });
}));

// Get template by name (latest version or specific)
router.get('/templates/by-name/:name', ah(async (req, res) => {
  logInfo('GW /api/templates by-name', { 
    name: req.params.name,
    version: req.query.version,
    ip: req.ip 
  });

  const version = req.query.version ? Number(req.query.version) : null;
  const tmpl = await getTemplateByName(req.params.name, version);
  
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });
  
  res.json({ template: tmpl });
}));

// Create new template
router.post('/templates', ah(async (req, res) => {
  logInfo('GW /api/templates create', { 
    body: req.body, 
    ip: req.ip 
  });

  const data = validate(req.body || {}, {
    name: str().min(1),
    template: str().min(1),
    description: str().optional(),
    variables: obj().optional(),
    tags: obj().optional() // expecting array but validate as object
  });

  // Auto-detect variables if not provided
  if (!data.variables) {
    const vars = extractVariables(data.template);
    data.variables = vars.reduce((acc, v) => {
      acc[v] = { type: 'string', description: '', required: true };
      return acc;
    }, {});
  }

  const tmpl = await createTemplate(data);
  res.json({ ok: true, template: tmpl });
}));

// Update template
router.put('/templates/:id', ah(async (req, res) => {
  logInfo('GW /api/templates update', { 
    id: req.params.id,
    body: req.body, 
    ip: req.ip 
  });

  const updates = validate(req.body || {}, {
    template: str().optional(),
    description: str().optional(),
    variables: obj().optional(),
    tags: obj().optional(),
    archived: bool().optional()
  });

  const tmpl = await updateTemplate(Number(req.params.id), updates);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  res.json({ ok: true, template: tmpl });
}));

// Delete template
router.delete('/templates/:id', ah(async (req, res) => {
  logInfo('GW /api/templates delete', { 
    id: req.params.id, 
    ip: req.ip 
  });

  await deleteTemplate(Number(req.params.id));
  res.json({ ok: true });
}));

// Render template with variables (for preview/testing)
router.post('/templates/:id/render', ah(async (req, res) => {
  logInfo('GW /api/templates/:id/render', { 
    id: req.params.id,
    body: req.body,
    ip: req.ip 
  });

  const tmpl = await getTemplate(Number(req.params.id));
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  const data = validate(req.body || {}, {
    variables: obj()
  });

  const rendered = substituteTemplate(tmpl.template, data.variables);
  
  res.json({ 
    template: tmpl,
    rendered,
    variables_used: data.variables 
  });
}));

// Render template by name (convenience endpoint)
router.post('/templates/by-name/:name/render', ah(async (req, res) => {
  logInfo('GW /api/templates/by-name/:name/render', { 
    name: req.params.name,
    body: req.body,
    ip: req.ip 
  });

  const version = req.query.version ? Number(req.query.version) : null;
  const tmpl = await getTemplateByName(req.params.name, version);
  
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  const data = validate(req.body || {}, {
    variables: obj()
  });

  const rendered = substituteTemplate(tmpl.template, data.variables);
  
  res.json({ 
    template: tmpl,
    rendered,
    variables_used: data.variables 
  });
}));

module.exports = { router, substituteTemplate, extractVariables };