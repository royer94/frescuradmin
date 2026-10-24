/**
 * ============================================================================
 * Frescura Natural · Endpoint API Serverless para Vercel
 * ============================================================================
 * Ruta en Vercel: /api/insumos (y /api/insumos.php vía rewrite)
 *
 * Funcionalidad:
 * 1. OPTIONS: Responde preflight CORS con HTTP 200.
 * 2. POST:    Recibe catálogo o prueba de conexión desde FormuLab.
 *             Valida el token Bearer FN-ERP-PUBLISH-2026.
 *             Realiza Upsert en Firebase Firestore (frescura-admin).
 * 3. GET:     Retorna el catálogo JSON completo de insumos para el ERP.
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
    if (bearerMatch && bearerMatch[1].trim() === API_TOKEN) return true;
    if (authHeader.trim() === API_TOKEN) return true;
  }

  // Token en cuerpo JSON (fallback)
  const bodyToken = req.body && req.body.token ? String(req.body.token).trim() : null;
  if (bodyToken && bodyToken === API_TOKEN) return true;

  // Token en query params (fallback)
  const queryToken = req.query && req.query.token ? String(req.query.token).trim() : null;
  if (queryToken && queryToken === API_TOKEN) return true;

  return false;
}

/**
 * Carga el catálogo desde Firestore con respaldo en /tmp
 */
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
  } catch (err) {
    console.warn('[Vercel API] Error leyendo Firestore, intentando /tmp:', err.message);
  }

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
  // Cabeceras CORS completas
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Preflight OPTIONS (vital para que el navegador de FormuLab no bloquee la petición)
  if (req.method === 'OPTIONS') {
    return res.status(200).json({ success: true, message: 'CORS OK' });
  }

  // MÉTODO POST: Recibir catálogo o Probar Conexión desde FormuLab
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

    // 1. Caso "Probar Conexión": si es un test o ping sin catálogo, responder éxito inmediato
    if (body && (body.test || body.action === 'test' || body.ping || body.probe)) {
      return res.status(200).json({
        success: true,
        message: 'Conexión exitosa con el ERP Frescura Natural en Vercel',
        status: 'connected',
        timestamp: new Date().toISOString()
      });
    }

    // 2. Extraer lista de materias primas
    let incomingList = null;
    if (body) {
      if (Array.isArray(body.raw_materials)) incomingList = body.raw_materials;
      else if (Array.isArray(body.catalog)) incomingList = body.catalog;
      else if (Array.isArray(body.insumos)) incomingList = body.insumos;
      else if (Array.isArray(body.materials)) incomingList = body.materials;
      else if (Array.isArray(body)) incomingList = body;
    }

    // Si el body no contenía arreglo (ej. ping de prueba vacío), responder OK de conexión
    if (!Array.isArray(incomingList)) {
      return res.status(200).json({
        success: true,
        message: 'Conexión verificada con el ERP Frescura Natural',
        status: 'connected'
      });
    }

    // FormuLab es la fuente de la verdad: Modo Maestro (reemplazar catálogo para limpiar registros huérfanos/obsoletos)
    const isMasterSync = body.mode === 'replace' || body.sync_mode === 'master' || body.replace === true;
    if (isMasterSync) {
      const cleanCatalog = [];
      const seen = new Set();
      incomingList.forEach(item => {
        if (!item || !item.sku) return;
        const key = String(item.sku).trim().toUpperCase();
        if (seen.has(key)) return;
        seen.add(key);
        cleanCatalog.push({
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
        });
      });
      await saveCatalog(cleanCatalog);
      return res.status(200).json({
        success: true,
        message: `Catálogo de materias primas sincronizado en Modo Maestro desde FormuLab. El ERP ahora tiene exactamente ${cleanCatalog.length} insumos oficiales y se depuraron los registros huérfanos.`,
        mode: 'master_replace',
        total_stored: cleanCatalog.length,
        updated_at: new Date().toISOString()
      });
    }

    // 3. Procesar catálogo y hacer Upsert
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

  // MÉTODO GET: Consultar catálogo o probar conexión
  if (req.method === 'GET') {
    const catalog = await loadCatalog();
    return res.status(200).json({
      success: true,
      message: 'Catálogo de materias primas de Frescura Natural',
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
