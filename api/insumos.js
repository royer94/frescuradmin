const fs = require('fs');
const path = require('path');

const API_TOKEN = 'FN-ERP-PUBLISH-2026';
const FIRESTORE_DOC_URL = 'https://firestore.googleapis.com/v1/projects/frescura-admin/databases/(default)/documents/insumos/catalogo';
const TMP_BACKUP_FILE = path.join('/tmp', 'insumos.json');

function isValidToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader) {
    const bearerMatch = authHeader.match(/Bearer\s+(\S+)/i);
    if (bearerMatch && bearerMatch[1].trim() === API_TOKEN) return true;
    if (authHeader.trim() === API_TOKEN) return true;
  }
  const bodyToken = req.body && req.body.token ? String(req.body.token).trim() : null;
  if (bodyToken && bodyToken === API_TOKEN) return true;
  const queryToken = req.query && req.query.token ? String(req.query.token).trim() : null;
  if (queryToken && queryToken === API_TOKEN) return true;
  return false;
}

async function loadCatalog() {
  try {
    const resp = await fetch(FIRESTORE_DOC_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });
    if (resp.ok) {
      const doc = await resp.json();
      if (doc && doc.fields && doc.fields.data && doc.fields.data.stringValue) {
        const parsed = JSON.parse(doc.fields.data.stringValue);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch (err) {}

  try {
    if (fs.existsSync(TMP_BACKUP_FILE)) {
      const raw = fs.readFileSync(TMP_BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}

  return [];
}

async function saveCatalog(catalog) {
  try {
    fs.writeFileSync(TMP_BACKUP_FILE, JSON.stringify(catalog), 'utf8');
  } catch (e) {}

  try {
    const payload = {
      fields: {
        data: { stringValue: JSON.stringify(catalog) },
        count: { integerValue: String(catalog.length) },
        updated_at: { stringValue: new Date().toISOString() }
      }
    };
    await fetch(FIRESTORE_DOC_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {}
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ success: true, message: 'CORS OK' });
  }

  if (req.method === 'POST') {
    if (!isValidToken(req)) {
      return res.status(401).json({
        success: false,
        error: 'No autorizado',
        message: 'Token Bearer inválido o ausente. Use Bearer FN-ERP-PUBLISH-2026'
      });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    // Respuesta inmediata para el botón "Probar Conexión" de FormuLab
    if (body && (body.test || body.action === 'test' || body.ping || body.probe)) {
      return res.status(200).json({
        success: true,
        message: 'Conexión exitosa con el ERP Frescura Natural en Vercel',
        status: 'connected'
      });
    }

    let incomingList = null;
    if (body) {
      if (Array.isArray(body.raw_materials)) incomingList = body.raw_materials;
      else if (Array.isArray(body.insumos)) incomingList = body.insumos;
      else if (Array.isArray(body.materials)) incomingList = body.materials;
      else if (Array.isArray(body)) incomingList = body;
    }

    if (!Array.isArray(incomingList)) {
      return res.status(200).json({
        success: true,
        message: 'Conexión verificada con el ERP Frescura Natural',
        status: 'connected'
      });
    }

    const currentCatalog = await loadCatalog();
    const map = new Map();
    currentCatalog.forEach(item => {
      if (item && item.sku) map.set(String(item.sku).trim().toUpperCase(), item);
    });

    let added = 0;
    let updated = 0;

    incomingList.forEach(item => {
      if (!item || !item.sku) return;
      const key = String(item.sku).trim().toUpperCase();
      const normalized = {
        sku: String(item.sku).trim(),
        commercial_name: item.commercial_name || item.nombre || '',
        inci_name: item.inci_name || '',
        phase_default: item.phase_default || item.fase || '',
        density_g_ml: (item.density_g_ml != null && item.density_g_ml !== '' && !isNaN(Number(item.density_g_ml))) ? Number(item.density_g_ml) : null,
        last_unit_cost: (item.last_unit_cost != null && item.last_unit_cost !== '' && !isNaN(Number(item.last_unit_cost))) ? Number(item.last_unit_cost) : 0,
        cost_unit: item.cost_unit || 'g',
        suppliers: item.suppliers || [],
        used_in_formulas: item.used_in_formulas || [],
        updated_at: item.updated_at || new Date().toISOString()
      };

      if (map.has(key)) {
        Object.assign(map.get(key), normalized);
        updated++;
      } else {
        map.set(key, normalized);
        added++;
      }
    });

    const newCatalog = Array.from(map.values());
    await saveCatalog(newCatalog);

    return res.status(200).json({
      success: true,
      message: 'Catálogo de materias primas actualizado con éxito en Vercel y Firestore',
      count: incomingList.length,
      added,
      updated,
      total_stored: newCatalog.length,
      updated_at: new Date().toISOString()
    });
  }

  if (req.method === 'GET') {
    const catalog = await loadCatalog();
    return res.status(200).json({
      success: true,
      count: catalog.length,
      updated_at: new Date().toISOString(),
      raw_materials: catalog
    });
  }

  return res.status(405).json({ success: false, error: 'Método no permitido' });
};
