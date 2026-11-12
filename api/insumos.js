/**
 * ============================================================================
 * Frescura Natural · Endpoint API Serverless para Vercel
 * ============================================================================
 * Ruta en Vercel: /api/insumos (y /api/insumos.php vía rewrite)
 *
 * Funcionalidad:
 * 1. OPTIONS: Responde preflight CORS con HTTP 200 (incluyendo X-ERP-Token).
 * 2. POST (action = "register_production_batch"):
 *    - Valida header X-ERP-Token: FN-ERP-PUBLISH-2026 o Authorization: Bearer FN-ERP-PUBLISH-2026.
 *    - Actualiza el stock de materias primas y materiales de empaque en "insumos".
 *    - Guarda el lote en lotes_produccion usando lote_code + product_name como clave única idempotente.
 *    - Si el lote es nuevo y finished_units > 0, busca el producto terminado por product_name o formula_id,
 *      suma finished_units a su stock disponible y actualiza su costo unitario con unit_cost_cop.
 *    - Responde con { "ok": true, "lote_code": "...", "finished_units_added": ... }.
 * 3. POST (sync_master / default):
 *    - Recibe catálogo o prueba de conexión desde FormuLab y sincroniza con Firestore.
 * 4. GET:
 *    - Retorna el catálogo JSON completo de insumos y los lotes de producción registrados.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const API_TOKEN = 'FN-ERP-PUBLISH-2026';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/frescura-admin/databases/(default)/documents';
const FIRESTORE_DOC_URL = `${FIRESTORE_BASE}/insumos/catalogo`;
const FIRESTORE_LOTES_URL = `${FIRESTORE_BASE}/insumos/lotes`;
const FIRESTORE_ADMIN_DB_URL = `${FIRESTORE_BASE}/admin/db`;

const TMP_BACKUP_FILE = path.join('/tmp', 'insumos.json');
const TMP_LOTES_FILE = path.join('/tmp', 'lotes_produccion.json');

/**
 * Valida el token de autorización (X-ERP-Token, Authorization Bearer, X-FN-Token, body o query)
 */
function isValidToken(req, body) {
  const xErp = req.headers['x-erp-token'] || req.headers['X-ERP-Token'] || req.headers['x-fn-token'] || req.headers['X-FN-Token'] || '';
  if (xErp && String(xErp).trim() === API_TOKEN) return true;

  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  if (authHeader) {
    const bearerMatch = String(authHeader).match(/Bearer\s+(\S+)/i);
    if (bearerMatch && bearerMatch[1].trim() === API_TOKEN) return true;
    if (String(authHeader).trim() === API_TOKEN) return true;
  }

  const parsedBody = body || req.body;
  const bodyToken = parsedBody && parsedBody.token ? String(parsedBody.token).trim() : null;
  if (bodyToken && bodyToken === API_TOKEN) return true;

  const queryToken = req.query && req.query.token ? String(req.query.token).trim() : null;
  if (queryToken && queryToken === API_TOKEN) return true;

  return false;
}

/**
 * Normaliza un objeto de insumo preservando stock y campos de FormuLab
 */
function generateFallbackSku(name, phase) {
  const cleanName = String(name || 'INSUMO')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = String(phase || '').toLowerCase().includes('emp') ? 'EMP' : 'MP';
  const cat = String(phase || 'GEN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'GEN';
  return `${prefix}-${cat}-${cleanName.slice(0, 6) || 'ITEM'}`;
}

function normalizeInsumo(item, existing = null) {
  const nameVal = item.commercial_name || item.name || item.nombre || (existing && existing.commercial_name) || '';
  const phaseVal = item.phase_default || item.category || item.fase || (existing && existing.phase_default) || '';
  const skuRaw = item.sku || item.code || item.id || (existing && existing.sku) || (existing && existing.code) || generateFallbackSku(nameVal, phaseVal);
  const sku = String(skuRaw).trim();
  const stockVal = (item.stock !== undefined && item.stock !== null && item.stock !== '' && !isNaN(Number(item.stock)))
    ? Number(item.stock)
    : (existing && existing.stock !== undefined ? Number(existing.stock) : 0);
  const minStockVal = (item.min_stock !== undefined && item.min_stock !== null && item.min_stock !== '' && !isNaN(Number(item.min_stock)))
    ? Number(item.min_stock)
    : ((item.stock_min !== undefined && !isNaN(Number(item.stock_min))) ? Number(item.stock_min) : (existing && existing.min_stock !== undefined ? Number(existing.min_stock) : 0));
  const unitCostVal = (item.last_unit_cost != null && item.last_unit_cost !== '' && !isNaN(Number(item.last_unit_cost)))
    ? Number(item.last_unit_cost)
    : ((item.unit_cost != null && item.unit_cost !== '' && !isNaN(Number(item.unit_cost)))
      ? Number(item.unit_cost)
      : ((item.cost != null && item.cost !== '' && !isNaN(Number(item.cost)))
        ? Number(item.cost)
        : (existing && existing.last_unit_cost != null ? Number(existing.last_unit_cost) : 0)));
  const densityVal = (item.density_g_ml != null && item.density_g_ml !== '' && !isNaN(Number(item.density_g_ml)))
    ? Number(item.density_g_ml)
    : ((item.density != null && item.density !== '' && !isNaN(Number(item.density)))
      ? Number(item.density)
      : (existing ? existing.density_g_ml : null));

  let suppliers = existing && Array.isArray(existing.suppliers) ? existing.suppliers : [];
  if (Array.isArray(item.suppliers)) {
    suppliers = item.suppliers;
  } else if (item.supplier && String(item.supplier).trim()) {
    const sup = String(item.supplier).trim();
    suppliers = suppliers.includes(sup) ? suppliers : [sup, ...suppliers];
  }

  return {
    sku,
    code: item.code || sku,
    commercial_name: item.commercial_name || item.name || item.nombre || (existing && existing.commercial_name) || '',
    inci_name: item.inci_name || item.inci || (existing && existing.inci_name) || '',
    phase_default: item.phase_default || item.category || item.fase || (existing && existing.phase_default) || '',
    category: item.category || item.phase_default || (existing && existing.category) || '',
    type: item.type || (existing && existing.type) || 'raw_material',
    density_g_ml: densityVal,
    last_unit_cost: unitCostVal,
    unit_cost: unitCostVal,
    cost_unit: item.cost_unit || item.unit || (existing && existing.cost_unit) || 'g',
    stock: stockVal,
    min_stock: minStockVal,
    suppliers,
    used_in_formulas: item.used_in_formulas || (existing && existing.used_in_formulas) || [],
    updated_at: item.updated_at || new Date().toISOString()
  };
}

/**
 * Carga el catálogo de insumos desde Firestore con respaldo en /tmp
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
    console.warn('[Vercel API] Error leyendo catálogo en Firestore:', err.message);
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
 * Guarda el catálogo de insumos en Firestore y en /tmp
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

    await fetch(FIRESTORE_DOC_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[Vercel API] Error guardando catálogo en Firestore:', err);
  }
}

/**
 * Carga la lista de lotes de producción desde Firestore (insumos/lotes) o /tmp
 */
async function loadLotes() {
  try {
    const resp = await fetch(FIRESTORE_LOTES_URL, {
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
    console.warn('[Vercel API] Error leyendo lotes en Firestore:', err.message);
  }

  try {
    if (fs.existsSync(TMP_LOTES_FILE)) {
      const raw = fs.readFileSync(TMP_LOTES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {}

  return [];
}

/**
 * Guarda la lista de lotes de producción en Firestore (insumos/lotes) y /tmp
 */
async function saveLotes(lotes) {
  try {
    fs.writeFileSync(TMP_LOTES_FILE, JSON.stringify(lotes), 'utf8');
  } catch (e) {}

  try {
    const payload = {
      fields: {
        data: { stringValue: JSON.stringify(lotes) },
        count: { integerValue: String(lotes.length) },
        updated_at: { stringValue: new Date().toISOString() }
      }
    };
    await fetch(FIRESTORE_LOTES_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[Vercel API] Error guardando lotes en Firestore:', err);
  }
}

/**
 * Carga el documento maestro del ERP (admin/db) desde Firestore
 */
async function loadAdminDB() {
  try {
    const resp = await fetch(FIRESTORE_ADMIN_DB_URL, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-store'
    });
    if (resp.ok) {
      const doc = await resp.json();
      if (doc && doc.fields && doc.fields.data && doc.fields.data.stringValue) {
        const dbData = JSON.parse(doc.fields.data.stringValue);
        const version = (doc.fields.version && doc.fields.version.stringValue) || 'frescura_v4_clean';
        return { dbData, version };
      }
    }
  } catch (err) {
    console.warn('[Vercel API] Error leyendo admin/db en Firestore:', err.message);
  }
  return null;
}

/**
 * Guarda el documento maestro del ERP (admin/db) en Firestore
 */
async function saveAdminDB(dbData, version = 'frescura_v4_clean') {
  try {
    const nowMs = Date.now();
    dbData._updated = nowMs;
    const payload = {
      fields: {
        data: { stringValue: JSON.stringify(dbData) },
        version: { stringValue: version },
        updated: { integerValue: String(nowMs) }
      }
    };
    await fetch(FIRESTORE_ADMIN_DB_URL, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[Vercel API] Error guardando admin/db en Firestore:', err);
  }
}

/**
 * Normaliza cadenas para comparación flexible de nombres de productos y presentaciones
 */
function normStr(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bdeo\s+fresh\b/g, 'deofresh')
    .replace(/\bfresh\s+lips\b/g, 'freshlips')
    .replace(/\bhydra\s+seal\b/g, 'hydraseal')
    .replace(/\bacne\s+balance\b/g, 'acnebalance')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactStr(s) {
  return normStr(s).replace(/\s+/g, '');
}

/**
 * Busca el producto terminado en DB.productos por product_name, formula_id y presentation
 */
function findFinishedProduct(productos, productName, formulaId, presentation, presentationQty, presentationUnit) {
  if (!Array.isArray(productos) || (!productName && !formulaId)) return null;
  const fid = String(formulaId || '').trim().toLowerCase();
  const normTarget = normStr(productName);
  const compactTarget = compactStr(productName);
  const normPres = normStr(`${presentation || ''} ${presentationQty || ''}${presentationUnit || ''}`);

  // 1. Coincidencia exacta por ID, formula_id o nombre normalizado/compacto
  let exact = productos.find(p => {
    const pid = String(p.id || '').trim().toLowerCase();
    const pfid = String(p.formula_id || '').trim().toLowerCase();
    const pNorm = normStr(p.nombre || p.name || '');
    const pCompact = compactStr(p.nombre || p.name || '');
    return (fid && (pid === fid || pfid === fid)) || (normTarget && (pNorm === normTarget || pCompact === compactTarget));
  });
  if (exact) return exact;

  // 2. Puntuación inteligente por tokens (considerando nombres compuestos y presentación)
  const stopWords = new Set(['con', 'sin', 'para', 'del', 'los', 'las', 'por', 'que', 'una', 'uno', 'de', 'en', 'el', 'la']);
  const isTargetKit = /\b(kit|pack|combo)\b/.test(normTarget);
  const rawTokens = normStr(`${productName} ${presentation || ''}`)
    .split(' ')
    .filter(t => t.length >= 3 && !stopWords.has(t));
  const targetTokens = [...new Set(rawTokens)];

  let bestMatch = null;
  let bestScore = 0;

  for (const p of productos) {
    const pName = p.nombre || p.name || '';
    const pNorm = normStr(pName);
    const pCompact = compactStr(pName);
    const isProdKit = /\b(kit|pack|combo)\b/.test(pNorm);

    // Evitar vincular un lote individual a un Kit/Pack/Combo a menos que el lote sea de un Kit
    if (isProdKit && !isTargetKit) continue;

    let score = 0;
    for (const tk of targetTokens) {
      if (pNorm.split(' ').includes(tk)) {
        score += 3;
      } else if (pNorm.includes(tk) || pCompact.includes(tk)) {
        score += 2;
      }
    }

    // Bonificación si un nombre contiene al otro de forma compacta
    if (pCompact.length >= 6 && compactTarget.length >= 6) {
      if (compactTarget.includes(pCompact) || pCompact.includes(compactTarget)) {
        score += 4;
      }
    }

    // Bonificación por coincidencia de presentación / gramaje (ej. "barra", "75", "50", "30")
    if (normPres) {
      const presTokens = normPres.split(' ').filter(t => t.length >= 2);
      for (const pt of presTokens) {
        if (pNorm.includes(pt)) score += 1.5;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  return bestScore >= 3 ? bestMatch : null;
}

module.exports = async (req, res) => {
  // Cabeceras CORS completas incluyendo X-ERP-Token
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-ERP-Token, X-FN-Token, X-Requested-With, Cache-Control');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method === 'OPTIONS') {
    return res.status(200).json({ ok: true, success: true, message: 'CORS OK' });
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }

    if (!isValidToken(req, body)) {
      return res.status(401).json({
        ok: false,
        success: false,
        error: 'No autorizado',
        message: 'Token inválido o ausente. Use X-ERP-Token: FN-ERP-PUBLISH-2026 o Authorization: Bearer FN-ERP-PUBLISH-2026'
      });
    }

    // 1. Caso "Probar Conexión"
    if (body && (body.test || body.action === 'test' || body.ping || body.probe)) {
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Conexión exitosa con el ERP Frescura Natural',
        status: 'connected',
        timestamp: new Date().toISOString()
      });
    }

    // =========================================================================
    // 2. Caso "register_production_batch" enviado desde FormuLab Pro
    // =========================================================================
    if (body && body.action === 'register_production_batch') {
      const batch = body.production_batch;
      if (!batch || typeof batch !== 'object') {
        return res.status(400).json({
          ok: false,
          error: 'El payload debe incluir el objeto production_batch'
        });
      }

      const loteCode = String(batch.lote_code || batch.loteCode || '').trim();
      const productName = String(batch.product_name || batch.formulaNombre || '').trim();
      const formulaId = String(batch.formula_id || batch.formulaId || '').trim();
      const finishedUnits = Math.max(0, parseInt(batch.finished_units ?? batch.unidades ?? 0, 10) || 0);
      const unitCostCop = Math.max(0, parseFloat(batch.unit_cost_cop ?? batch.costoUnitario ?? 0) || 0);
      const bulkCostCop = Math.max(0, parseFloat(batch.bulk_cost_cop ?? 0) || 0);
      const packagingCostCop = Math.max(0, parseFloat(batch.packaging_cost_cop ?? 0) || 0);
      const totalCostCop = Math.max(0, parseFloat(batch.total_cost_cop ?? (unitCostCop * finishedUnits) ?? 0) || 0);
      const presentation = String(batch.presentation || batch.presentacionNombre || '').trim();
      const presentationQty = batch.presentation_qty !== undefined ? Number(batch.presentation_qty) : null;
      const presentationUnit = String(batch.presentation_unit || '').trim();
      const batchSizeG = batch.batch_size_g !== undefined ? Number(batch.batch_size_g) : null;
      const fecha = String(batch.fecha || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const mes = String(batch.mes || fecha.slice(0, 7));

      if (!loteCode || !productName) {
        return res.status(400).json({
          ok: false,
          error: 'Los campos lote_code y product_name son obligatorios en production_batch'
        });
      }

      // A) Actualizar stocks de materias primas y materiales de empaque ("insumos")
      const incomingInsumos = Array.isArray(body.insumos)
        ? body.insumos
        : (Array.isArray(body.raw_materials) ? body.raw_materials : null);

      let updatedCatalog = await loadCatalog();
      if (Array.isArray(incomingInsumos) && incomingInsumos.length > 0) {
        const insMap = new Map();
        const nameToSkuKey = new Map();
        updatedCatalog.forEach(item => {
          const k = String(item.sku || item.code || '').trim().toUpperCase();
          if (k) {
            insMap.set(k, item);
            const nk = normStr(item.commercial_name || item.name || '');
            if (nk) nameToSkuKey.set(nk, k);
          }
        });

        incomingInsumos.forEach(raw => {
          if (!raw) return;
          const rawNameNorm = normStr(raw.commercial_name || raw.name || raw.nombre || '');
          let k = String(raw.sku || raw.code || raw.id || '').trim().toUpperCase();
          if (!k && rawNameNorm && nameToSkuKey.has(rawNameNorm)) {
            k = nameToSkuKey.get(rawNameNorm);
          }
          if (!k) {
            if (!rawNameNorm) return;
            k = generateFallbackSku(raw.commercial_name || raw.name || raw.nombre, raw.category || raw.phase_default).toUpperCase();
          }
          const existing = insMap.get(k) || null;
          const normItem = normalizeInsumo(raw, existing);
          insMap.set(k, normItem);
          if (rawNameNorm) nameToSkuKey.set(rawNameNorm, k);
        });

        updatedCatalog = Array.from(insMap.values());
        await saveCatalog(updatedCatalog);
      }

      // B) Cargar lotes y el documento maestro admin/db en Firestore
      const [lotesStore, adminBundle] = await Promise.all([
        loadLotes(),
        loadAdminDB()
      ]);

      const dbData = (adminBundle && adminBundle.dbData) ? adminBundle.dbData : null;
      const dbVersion = (adminBundle && adminBundle.version) ? adminBundle.version : 'frescura_v4_clean';

      // Unificar lotes de ambas fuentes para garantizar idempotencia estricta
      const allLotesMap = new Map();
      const makeBatchKey = (lc, pn) => `${String(lc || '').trim().toLowerCase()}||${String(pn || '').trim().toLowerCase()}`;

      lotesStore.forEach(l => {
        if (l && (l.lote_code || l.product_name)) {
          allLotesMap.set(makeBatchKey(l.lote_code, l.product_name), l);
        }
      });
      if (dbData && Array.isArray(dbData.lotes_produccion)) {
        dbData.lotes_produccion.forEach(l => {
          if (l && (l.lote_code || l.product_name)) {
            const k = makeBatchKey(l.lote_code, l.product_name);
            if (!allLotesMap.has(k)) allLotesMap.set(k, l);
          }
        });
      }

      const uniqueKey = makeBatchKey(loteCode, productName);
      const existingBatch = allLotesMap.get(uniqueKey) || null;
      const isNewBatch = !existingBatch;

      let finishedUnitsAdded = 0;
      let matchedProductInfo = null;

      const nowIso = new Date().toISOString();
      const batchRecord = {
        ...batch,
        id: batch.id || `LOT-${loteCode}`,
        lote_code: loteCode,
        fecha,
        mes,
        formula_id: formulaId,
        product_name: productName,
        formula_version: batch.formula_version || '',
        presentation,
        presentation_qty: presentationQty,
        presentation_unit: presentationUnit,
        batch_size_g: batchSizeG,
        finished_units: finishedUnits,
        bulk_cost_cop: bulkCostCop,
        packaging_cost_cop: packagingCostCop,
        total_cost_cop: totalCostCop,
        unit_cost_cop: unitCostCop,
        operario: batch.operario || '',
        verificador_qa: batch.verificador_qa || '',
        stock_deducted: Boolean(batch.stock_deducted),
        consumed_materials: Array.isArray(batch.consumed_materials) ? batch.consumed_materials : [],
        created_at: existingBatch ? (existingBatch.created_at || nowIso) : nowIso,
        updated_at: nowIso,
        synced_at: nowIso,
        stock_applied: existingBatch ? Boolean(existingBatch.stock_applied) : (finishedUnits > 0)
      };

      // C) Si el lote es nuevo y finished_units > 0, sumar al producto terminado y actualizar su costo unitario
      if (isNewBatch && finishedUnits > 0) {
        finishedUnitsAdded = finishedUnits;

        if (dbData && Array.isArray(dbData.productos)) {
          const matchedProd = findFinishedProduct(
            dbData.productos,
            productName,
            formulaId,
            presentation,
            presentationQty,
            presentationUnit
          );

          if (matchedProd) {
            matchedProd.stock = (Number(matchedProd.stock) || 0) + finishedUnits;
            if (unitCostCop > 0) {
              matchedProd.costo = Math.round(unitCostCop);
            }
            if (formulaId) {
              matchedProd.formula_id = formulaId;
            }
            matchedProd.ultimo_lote = loteCode;

            batchRecord.product_matched_id = matchedProd.id;
            batchRecord.product_matched_name = matchedProd.nombre;

            matchedProductInfo = {
              id: matchedProd.id,
              nombre: matchedProd.nombre,
              new_stock: matchedProd.stock,
              unit_cost_cop: matchedProd.costo
            };

            if (!Array.isArray(dbData.movimientos)) dbData.movimientos = [];
            dbData.movimientos.push({
              id: 'MOV-' + Date.now().toString(36).toUpperCase(),
              fecha,
              id_producto: matchedProd.id,
              tipo: 'entrada',
              cantidad: finishedUnits,
              costo_unitario: unitCostCop > 0 ? Math.round(unitCostCop) : (matchedProd.costo || 0),
              referencia: loteCode,
              nota: `Lote de producción ${loteCode} (${batch.operario || 'FormuLab Pro'})`
            });
          }
        }
      } else if (existingBatch) {
        // Idempotente: conservar vínculo previo sin volver a sumar stock
        if (existingBatch.product_matched_id) batchRecord.product_matched_id = existingBatch.product_matched_id;
        if (existingBatch.product_matched_name) batchRecord.product_matched_name = existingBatch.product_matched_name;
      }

      allLotesMap.set(uniqueKey, batchRecord);
      const finalLotesList = Array.from(allLotesMap.values());

      // Guardar en ambos documentos de Firestore (insumos/lotes y admin/db)
      const savePromises = [saveLotes(finalLotesList)];
      if (dbData) {
        dbData.lotes_produccion = finalLotesList;
        if (Array.isArray(incomingInsumos) && incomingInsumos.length > 0) {
          dbData.insumos = updatedCatalog;
        }
        savePromises.push(saveAdminDB(dbData, dbVersion));
      }
      await Promise.all(savePromises);

      return res.status(200).json({
        ok: true,
        lote_code: loteCode,
        finished_units_added: finishedUnitsAdded,
        is_new_batch: isNewBatch,
        product_matched: matchedProductInfo ? matchedProductInfo.nombre : (batchRecord.product_matched_name || null),
        product_id: matchedProductInfo ? matchedProductInfo.id : (batchRecord.product_matched_id || null),
        unit_cost_cop: unitCostCop,
        insumos_updated: Array.isArray(incomingInsumos) ? incomingInsumos.length : 0
      });
    }

    // =========================================================================
    // 3. Sincronización de catálogo de materias primas e insumos
    // =========================================================================
    let incomingList = null;
    if (body) {
      if (Array.isArray(body.raw_materials)) incomingList = body.raw_materials;
      else if (Array.isArray(body.catalog)) incomingList = body.catalog;
      else if (Array.isArray(body.insumos)) incomingList = body.insumos;
      else if (Array.isArray(body.materials)) incomingList = body.materials;
      else if (Array.isArray(body)) incomingList = body;
    }

    if (!Array.isArray(incomingList)) {
      return res.status(200).json({
        ok: true,
        success: true,
        message: 'Conexión verificada con el ERP Frescura Natural',
        status: 'connected'
      });
    }

    const isMasterSync = body.mode === 'replace' || body.sync_mode === 'master' || body.replace === true;
    if (isMasterSync) {
      const cleanCatalog = [];
      const seen = new Set();
      incomingList.forEach(item => {
        if (!item || !(item.sku || item.code)) return;
        const key = String(item.sku || item.code).trim().toUpperCase();
        if (seen.has(key)) return;
        seen.add(key);
        cleanCatalog.push(normalizeInsumo(item, null));
      });
      await saveCatalog(cleanCatalog);
      return res.status(200).json({
        ok: true,
        success: true,
        message: `Catálogo de materias primas sincronizado en Modo Maestro desde FormuLab (${cleanCatalog.length} insumos).`,
        mode: 'master_replace',
        total_stored: cleanCatalog.length,
        updated_at: new Date().toISOString()
      });
    }

    const currentCatalog = await loadCatalog();
    const map = new Map();
    currentCatalog.forEach(item => {
      const k = item && (item.sku || item.code) ? String(item.sku || item.code).trim().toUpperCase() : '';
      if (k) map.set(k, item);
    });

    let added = 0;
    let updated = 0;

    incomingList.forEach(item => {
      if (!item || !(item.sku || item.code)) return;
      const key = String(item.sku || item.code).trim().toUpperCase();
      const existing = map.get(key) || null;
      const normalized = normalizeInsumo(item, existing);
      if (existing) {
        map.set(key, normalized);
        updated++;
      } else {
        map.set(key, normalized);
        added++;
      }
    });

    const newCatalog = Array.from(map.values());
    await saveCatalog(newCatalog);

    return res.status(200).json({
      ok: true,
      success: true,
      message: 'Catálogo de materias primas actualizado con éxito en Vercel y Firestore',
      count: incomingList.length,
      added,
      updated,
      total_stored: newCatalog.length,
      updated_at: new Date().toISOString()
    });
  }

  // MÉTODO GET: Consultar catálogo de insumos y lotes de producción
  if (req.method === 'GET') {
    const [catalog, lotes] = await Promise.all([loadCatalog(), loadLotes()]);
    return res.status(200).json({
      ok: true,
      success: true,
      message: 'Catálogo de materias primas y lotes de producción de Frescura Natural',
      count: catalog.length,
      updated_at: new Date().toISOString(),
      raw_materials: catalog,
      insumos: catalog,
      lotes_count: lotes.length,
      lotes_produccion: lotes
    });
  }

  return res.status(405).json({
    ok: false,
    success: false,
    error: 'Método no permitido',
    message: 'Solo se aceptan peticiones GET, POST y OPTIONS.'
  });
};
