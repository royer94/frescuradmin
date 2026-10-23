/**
 * ============================================================================
 * Frescura Natural · Endpoint API Serverless para Vercel
 * ============================================================================
 * Ruta en Vercel: /api/insumos (y /api/insumos.php vía rewrite)
 *
 * Funcionalidad:
 * 1. OPTIONS: Responde preflight CORS con HTTP 200.
 * 2. POST:    Recibe catálogo de materias primas desde FormuLab mediante el
 *             botón "📡 Enviar a API ERP". Valida token Bearer FN-ERP-PUBLISH-2026,
 *             realiza Upsert (guardar/actualizar por SKU) y lo almacena de forma
 *             persistente en Firebase Firestore (proyecto: frescura-admin).
 * 3. GET:     Retorna el catálogo JSON completo de insumos para que el ERP
 *             lo sincronice y visualice.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const API_TOKEN = 'FN-ERP-PUBLISH-2026';
const FIRESTORE_DOC_URL = 'https://firestore.googleapis.com/v1/projects/frescura-admin/databases/(default)/documents/insumos/catalogo';
const TMP_BACKUP_FILE = path.join('/tmp', 'insumos.json');

/**
 * Valida el token de autorización
 */
function isValidToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader) {
    const bearerMatch = authHeader.match(/Bearer\s+(\S+)/i);
    if (bearerMatch && bearerMatch[1] === API_TOKEN) return true;
    if (authHeader.trim() === API_TOKEN) return true;
  }

  // Token en cuerpo JSON (fallback)
  const bodyToken = req.body && req.body.token ? req.body.token : null;
  if (bodyToken && bodyToken === API_TOKEN) return true;

  // Token en query params (fallback)
  const queryToken = req.query && req.query.token ? req.query.token : null;
  if (queryToken && queryToken === API_TOKEN) return true;

  return false;
}

/**
 * Carga el catálogo desde Firestore con respaldo en /tmp
 */
async function loadCatalog() {
  // 1. Intentar leer desde Firestore REST API
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
  } catch (err) {
    console.warn('[Vercel API] Error leyendo Firestore, intentando /tmp:', err.message);
  }

  // 2. Respaldo en /tmp
  try {
    if (fs.existsSync(TMP_BACKUP_FILE)) {
      const raw = fs.readFileSync(TMP_BACKUP_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}

  return [];
}

/**
 * Guarda el catálogo en Firestore y en /tmp
 */
async function saveCatalog(catalog) {
  // 1. Guardar en /tmp (cache local inmediato de la instancia)
  try {
    fs.writeFileSync(TMP_BACKUP_FILE, JSON.stringify(catalog), 'utf8');
  } catch (e) {}

  // 2. Guardar en Firestore REST API (almacenamiento persistente en la nube)
  try {
    const payload = {
      fields: {
        data: { stringValue: JSON.stringify(catalog) },
        count: { integerValue: String(catalog.length) },
        updated_at: { stringValue: new Date().toISOString() }
      }
    };

    const resp = await fetch(FIRESTORE_DOC_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      console.warn('[Vercel API] Firestore write status:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('[Vercel API] Error guardando en Firestore:', err);
  }
}

module.exports = async (req, res) => {
  // Cabeceras CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ success: true, message: 'CORS preflight OK' });
  }

  // MÉTODO POST: Recibir catálogo desde FormuLab
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

    let incomingList = null;
    if (body) {
      if (Array.isArray(body.raw_materials)) incomingList = body.raw_materials;
      else if (Array.isArray(body.insumos)) incomingList = body.insumos;
      else if (Array.isArray(body.materials)) incomingList = body.materials;
      else if (Array.isArray(body)) incomingList = body;
    }

    if (!Array.isArray(incomingList)) {
      return res.status(400).json({
        success: false,
        error: 'Datos inválidos',
        message: 'El cuerpo debe contener un arreglo "raw_materials" o "insumos".'
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
      message: 'Catálogo de materias primas actualizado con éxito',
      count: incomingList.length,
      added,
      updated,
      total_stored: newCatalog.length,
      updated_at: new Date().toISOString()
    });
  }

  // MÉTODO GET: Consultar catálogo para el ERP
  if (req.method === 'GET') {
    const catalog = await loadCatalog();
    return res.status(200).json({
      success: true,
      count: catalog.length,
      updated_at: new Date().toISOString(),
      raw_materials: catalog
    });
  }

  return res.status(405).json({
    success: false,
    error: 'Método no permitido',
    message: 'Solo se aceptan peticiones GET, POST y OPTIONS.'
  });
};
