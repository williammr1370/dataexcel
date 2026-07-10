// ===================================================================
// BROADCAST - APLICACIÓN COMPLETA
// ===================================================================

// ===================================================================
// 1. ESTADO GLOBAL
// ===================================================================
let currentAnalysis = null;
let currentRawData = null;
let currentFileName = '';
let currentMode = 'default';
let currentBroadcastData = null;
let dataPage = 0;
const DATA_PAGE_SIZE = 50;
const DB_NAME = 'BroadcastDB';
const DB_VERSION = 2;
const STORE_NAME = 'analyses';
const LOG_STORE_NAME = 'logs';
let chartInstances = {};
let isProcessing = false;
let renderTimeout = null;

// ===================================================================
// 2. FUNCIONES DE UTILIDAD
// ===================================================================
function formatNumber(n) {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (Number.isInteger(n)) return n.toLocaleString('es');
  return n.toFixed(4);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds < 0) return '—';
  return Math.round(seconds).toLocaleString('es') + ' s';
}

function typeBadge(type) {
  const map = {
    numeric: ['badge-numeric', 'Numérico'],
    categorical: ['badge-categorical', 'Categórico'],
    date: ['badge-date', 'Fecha'],
    mixed: ['badge-mixed', 'Mixto']
  };
  const [cls, label] = map[type] || ['badge-mixed', type];
  return `<span class="badge ${cls}">${label}</span>`;
}

function generateColors(n) {
  const base = ['rgba(52,211,153,0.7)', 'rgba(96,165,250,0.7)', 'rgba(251,191,36,0.7)', 'rgba(248,113,113,0.7)', 'rgba(167,139,250,0.7)', 'rgba(244,114,182,0.7)', 'rgba(45,212,191,0.7)', 'rgba(251,146,60,0.7)', 'rgba(129,230,217,0.7)', 'rgba(196,181,253,0.7)'];
  const colors = [];
  for (let i = 0; i < n; i++) colors.push(base[i % base.length]);
  return colors;
}

function correlationColor(r) {
  const abs = Math.abs(r);
  if (r > 0) return `rgba(52,211,153,${abs * 0.5})`;
  return `rgba(248,113,113,${abs * 0.5})`;
}

function createHistogramBins(values, numBins) {
  const min = values[0];
  const max = values[values.length - 1];
  if (min === max) return [{ label: formatNumber(min), count: values.length }];
  const binWidth = (max - min) / numBins;
  const bins = [];
  for (let i = 0; i < numBins; i++) {
    const lo = min + i * binWidth;
    bins.push({ label: formatNumber(lo), count: 0, min: lo, max: lo + binWidth });
  }
  values.forEach(v => {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= numBins) idx = numBins - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  });
  return bins;
}

function getPercentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function standardDeviation(values, mean) {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function skewness(values, mean, std) {
  if (values.length < 3 || std === 0) return 0;
  return values.reduce((s, v) => s + Math.pow((v - mean) / std, 3), 0) / values.length;
}

function pearsonCorrelation(x, y) {
  const pairs = [];
  for (let i = 0; i < x.length; i++) {
    const xv = typeof x[i] === 'number' ? x[i] : parseFloat(String(x[i]).replace(/,/g, ''));
    const yv = typeof y[i] === 'number' ? y[i] : parseFloat(String(y[i]).replace(/,/g, ''));
    if (!isNaN(xv) && !isNaN(yv)) pairs.push([xv, yv]);
  }
  if (pairs.length < 3) return 0;
  const n = pairs.length;
  const sumX = pairs.reduce((s, p) => s + p[0], 0);
  const sumY = pairs.reduce((s, p) => s + p[1], 0);
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0, denX = 0, denY = 0;
  pairs.forEach(([xi, yi]) => {
    const dx = xi - meanX;
    const dy = yi - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  });
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showModal(content) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal-content">${content}</div>
    </div>
  `;
}

function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

function destroyAllCharts() {
  Object.keys(chartInstances).forEach(key => {
    if (chartInstances[key]) {
      try { chartInstances[key].destroy(); } catch(e) {}
      delete chartInstances[key];
    }
  });
}

// ===================================================================
// 3. INDEXEDDB
// ===================================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('fileName', 'fileName', { unique: false });
      }
      if (!db.objectStoreNames.contains(LOG_STORE_NAME)) {
        const logStore = db.createObjectStore(LOG_STORE_NAME, { keyPath: 'id' });
        logStore.createIndex('timestamp', 'timestamp', { unique: false });
        logStore.createIndex('fileName', 'fileName', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAnalysis(name, fileName, analysis, mode, broadcastData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record = { name, fileName, timestamp: Date.now(), analysis, mode: mode || 'default', broadcastData: broadcastData || null };
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllAnalyses() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.timestamp - a.timestamp));
    req.onerror = () => reject(req.error);
  });
}

async function getAnalysisById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAnalysis(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function updateDBStats() {
  const all = await getAllAnalyses();
  const el = document.getElementById('db-stats');
  if (el) el.textContent = `${all.length} análisis guardados`;
}

// ===================================================================
// 4. PARSEADOR DE DURACIÓN
// ===================================================================
function parseDuration(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return (value > 0 && value < 86400) ? value : null;
  }
  if (typeof value === 'string') {
    let str = value.trim();
    if (str === '') return null;
    let num = parseFloat(str.replace(/,/g, '').replace(/\s/g, ''));
    if (!isNaN(num) && num > 0 && num < 86400) return num;
    return null;
  }
  return null;
}

// ===================================================================
// 5. ANÁLISIS DEFAULT
// ===================================================================
function analyzeData(data) {
  const columns = Object.keys(data[0]);
  const rowCount = data.length;
  const columnAnalyses = {};
  let typeCounts = { numeric: 0, categorical: 0, date: 0, mixed: 0 };

  columns.forEach(col => {
    const values = data.map(row => row[col]);
    const analysis = analyzeColumn(values, col);
    columnAnalyses[col] = analysis;
    typeCounts[analysis.type] = (typeCounts[analysis.type] || 0) + 1;
  });

  const numericCols = columns.filter(c => columnAnalyses[c].type === 'numeric');
  const correlations = {};
  numericCols.forEach((c1, i) => {
    numericCols.forEach((c2, j) => {
      if (j <= i) return;
      const v1 = data.map(r => r[c1]);
      const v2 = data.map(r => r[c2]);
      const r = pearsonCorrelation(v1, v2);
      correlations[`${c1}__${c2}`] = { col1: c1, col2: c2, r, absR: Math.abs(r) };
    });
  });

  let totalNulls = 0;
  columns.forEach(c => totalNulls += columnAnalyses[c].nullCount);

  return {
    columnCount: columns.length,
    rowCount,
    columns,
    typeCounts,
    columnAnalyses,
    correlations,
    numericCols,
    totalNulls,
    totalCells: rowCount * columns.length,
    nullPercentage: ((totalNulls / (rowCount * columns.length)) * 100).toFixed(2),
    timestamp: Date.now()
  };
}

function analyzeColumn(values, name) {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== '');
  const nullCount = values.length - nonNull.length;
  const uniqueCount = new Set(nonNull.map(String)).size;

  let type = 'categorical';
  let numericValues = [];
  let dateValues = [];

  const numParsed = nonNull.map(v => {
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return isNaN(n) ? null : n;
  });
  const validNumeric = numParsed.filter(v => v !== null);
  const numericRatio = nonNull.length > 0 ? validNumeric.length / nonNull.length : 0;

  const dateParsed = nonNull.map(v => {
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  });
  const validDates = dateParsed.filter(v => v !== null);
  const dateRatio = nonNull.length > 0 ? validDates.length / nonNull.length : 0;

  if (numericRatio > 0.85) { type = 'numeric'; numericValues = validNumeric; }
  else if (dateRatio > 0.85) { type = 'date'; dateValues = validDates; }
  else if (numericRatio > 0.5 && dateRatio > 0.5) { type = 'mixed'; }

  const result = { name, type, nullCount, nullPercentage: ((nullCount / values.length) * 100).toFixed(2), uniqueCount, nonNullCount: nonNull.length };

  if (type === 'numeric' && numericValues.length > 0) {
    numericValues.sort((a, b) => a - b);
    result.min = numericValues[0];
    result.max = numericValues[numericValues.length - 1];
    result.sum = numericValues.reduce((s, v) => s + v, 0);
    result.mean = result.sum / numericValues.length;
    result.median = getPercentile(numericValues, 50);
    result.stdDev = standardDeviation(numericValues, result.mean);
    result.q1 = getPercentile(numericValues, 25);
    result.q3 = getPercentile(numericValues, 75);
    result.iqr = result.q3 - result.q1;
    result.skewness = skewness(numericValues, result.mean, result.stdDev);
    result.values = numericValues;
  }

  if (type === 'categorical' || type === 'mixed') {
    const freq = {};
    nonNull.forEach(v => {
      const key = String(v);
      freq[key] = (freq[key] || 0) + 1;
    });
    const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    result.frequency = sorted;
    result.mode = sorted.length > 0 ? sorted[0][0] : null;
    result.modeCount = sorted.length > 0 ? sorted[0][1] : 0;
    result.topValues = sorted.slice(0, 10);
  }

  if (type === 'date' && dateValues.length > 0) {
    dateValues.sort((a, b) => a - b);
    result.minDate = dateValues[0];
    result.maxDate = dateValues[dateValues.length - 1];
    result.dateValues = dateValues;
  }

  return result;
}

// ===================================================================
// FUNCIÓN PARA PARSEAR FECHA EN FORMATO 'DD/MM/YY'
// ===================================================================
function parseFechaDDMMYY(fechaStr) {
  if (!fechaStr) return null;
  if (fechaStr instanceof Date) return fechaStr;
  
  if (typeof fechaStr === 'string') {
    let str = fechaStr.trim();
    if (str === '') return null;
    
    // Formato: DD/MM/YY o DD/MM/YYYY
    let match = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (match) {
      let dia = parseInt(match[1]);
      let mes = parseInt(match[2]) - 1;
      let anio = parseInt(match[3]);
      if (anio < 100) anio += 2000;
      const fecha = new Date(anio, mes, dia);
      if (!isNaN(fecha.getTime())) return fecha;
    }
    
    // Formato: DD-MM-YY o DD-MM-YYYY
    match = str.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (match) {
      let dia = parseInt(match[1]);
      let mes = parseInt(match[2]) - 1;
      let anio = parseInt(match[3]);
      if (anio < 100) anio += 2000;
      const fecha = new Date(anio, mes, dia);
      if (!isNaN(fecha.getTime())) return fecha;
    }
    
    // Intentar con Date nativo
    const fecha = new Date(str);
    if (!isNaN(fecha.getTime())) return fecha;
    
    return null;
  }
  
  if (typeof fechaStr === 'number') {
    const fecha = new Date(fechaStr);
    if (!isNaN(fecha.getTime())) return fecha;
    return null;
  }
  
  return null;
}

// ===================================================================
// 6. ANÁLISIS BROADCAST - CORREGIDO (con parseo de fecha DD/MM/YY)
// ===================================================================
function analyzeBroadcastData(data) {
  console.log('🔍 Iniciando análisis Broadcast...');
  console.log('📊 Total de filas:', data.length);
  
  if (data.length === 0) return null;
  
  const colNames = Object.keys(data[0]);
  console.log('📋 Columnas disponibles:', colNames);
  
  // Buscar columna de duración
  let duracionCol = colNames.find(c => /^duracion\s*\(s\)$/i.test(c) || /^duracion_s$/i.test(c) || /^duracionsegundos$/i.test(c));
  if (!duracionCol) {
    duracionCol = colNames.find(c => /^duracion$/i.test(c) || /^duration$/i.test(c));
  }
  if (!duracionCol) {
    duracionCol = colNames.find(c => /duracion|duration/i.test(c));
  }
  
  if (!duracionCol) {
    console.error('❌ No se encontró columna de duración');
    return null;
  }
  
  console.log('✅ Columna de duración:', duracionCol);
  
  // Buscar columna de título (EXACTA)
  let tituloCol = colNames.find(c => c === 'Titulo' || c === 'Título');
  if (!tituloCol) {
    tituloCol = colNames.find(c => c.toLowerCase() === 'titulo' || c.toLowerCase() === 'título');
  }
  if (!tituloCol) {
    tituloCol = colNames.find(c => /^(titulo|título)$/i.test(c));
  }
  if (!tituloCol) {
    tituloCol = colNames.find(c => /titulo|title|canción|cancion/i.test(c));
  }
  
  console.log('✅ Columna de título:', tituloCol || '❌ No encontrada');
  
  // Detectar otras columnas
  const fechaCol = colNames.find(c => /fecha|date|dia/i.test(c));
  const msCol = colNames.find(c => /m\/s|ms|tipo_audio/i.test(c) && !/tipo.*musica/i.test(c));
  const tipoMusicaCol = colNames.find(c => /tipo.*musica|musica.*tipo|genero|género|estilo|tipo_musica|music_type|genre/i.test(c));

  console.log('🔑 Columnas identificadas:');
  console.log('  Duración:', duracionCol);
  console.log('  Título:', tituloCol || '❌ No encontrada');
  console.log('  Fecha:', fechaCol || '❌ No encontrada');
  console.log('  M/S:', msCol || '❌ No encontrada');
  console.log('  Tipo Música:', tipoMusicaCol || '❌ No encontrada');

  // Función para verificar si el título es nulo
  const isTituloNulo = (row) => {
    if (!tituloCol) return true;
    const titulo = row[tituloCol];
    if (titulo === null || titulo === undefined) return true;
    if (typeof titulo === 'string' && titulo.trim() === '') return true;
    if (typeof titulo === 'string' && titulo.trim().toLowerCase() === 'null') return true;
    if (typeof titulo === 'string' && titulo.trim().toLowerCase() === 'nulo') return true;
    return false;
  };

  // Función para verificar si un valor está vacío
  const isEmpty = (v) => {
    return v === null || v === undefined || String(v).trim() === '';
  };

  // Función para obtener duración
  const getDuracion = (row) => {
    const val = row[duracionCol];
    return parseDuration(val);
  };

  // Contar valores válidos de duración
  let validCount = 0, invalidCount = 0;
  data.forEach(row => {
    const dur = getDuracion(row);
    if (dur !== null) validCount++;
    else invalidCount++;
  });
  
  console.log(`📊 Valores de duración válidos: ${validCount}, inválidos: ${invalidCount}`);
  
  if (validCount === 0) {
    console.error('❌ No hay valores de duración válidos');
    return null;
  }

  // Suma de duraciones con filtro
  const sumDuraciones = (filterFn, filterName = '') => {
    let sum = 0, count = 0;
    data.forEach((row) => {
      const dur = getDuracion(row);
      if (dur !== null) {
        const shouldInclude = !filterFn || filterFn(row);
        if (shouldInclude) {
          sum += dur;
          count++;
        }
      }
    });
    console.log(`  📊 ${filterName}: ${count} registros, suma: ${sum.toLocaleString('es')} s`);
    return { sum, count };
  };

  // Tiempo de emisión - usar la primera fecha válida
  let tiempoEmision = 0;
  let mesReferencia = null;
  let anioReferencia = null;
  let diasDelMes = 0;

  if (fechaCol) {
    console.log('📊 Buscando fecha de referencia para el mes...');
    
    for (let i = 0; i < data.length; i++) {
      const fechaVal = data[i][fechaCol];
      const fecha = parseFechaDDMMYY(fechaVal);
      if (fecha) {
        mesReferencia = fecha.getMonth();
        anioReferencia = fecha.getFullYear();
        diasDelMes = new Date(anioReferencia, mesReferencia + 1, 0).getDate();
        tiempoEmision = diasDelMes * 24 * 3600;
        console.log(`📅 Mes de referencia: ${mesReferencia + 1}, Año: ${anioReferencia}, Días: ${diasDelMes}`);
        console.log('📅 Tiempo de emisión:', tiempoEmision.toLocaleString('es'), 's');
        break;
      }
    }
  }

  // Calcular indicadores
  console.log('\n📊 CALCULANDO INDICADORES');
  console.log('========================================');
  
  // 1. Tiempo Analizado
  console.log('📊 1. Tiempo Analizado:');
  const { sum: tiempoAnalizado, count: countAnalizado } = sumDuraciones(null, 'Tiempo Analizado');

  // 2. Música y Música+Palabra
  console.log('📊 2. Música y Música+Palabra:');
  const { sum: sumaMusica, count: countMusica } = sumDuraciones((row) => {
    if (!msCol) return false;
    const val = row[msCol];
    if (isEmpty(val)) return false;
    const str = String(val).toLowerCase().trim();
    return str === 'musica' || str === 'musica y palabra' || str === 'música' || str === 'música y palabra';
  }, 'Música y Música+Palabra');

  // 3. Música Identificada
  console.log('📊 3. Música Identificada:');
  const { sum: musicaIdentificada, count: countIdentificada } = sumDuraciones((row) => {
    if (!tituloCol) return false;
    return !isTituloNulo(row);
  }, 'Música Identificada');

  // 4. Música Comercial
  console.log('📊 4. Música Comercial:');
  const { sum: musicaComercial, count: countComercial } = sumDuraciones((row) => {
    if (!tipoMusicaCol) return false;
    const val = row[tipoMusicaCol];
    if (isEmpty(val)) return false;
    const str = String(val).toLowerCase().trim();
    return str === 'musica comercial' || str === 'música comercial';
  }, 'Música Comercial');

  // 5. FCFs
  console.log('📊 5. FCFs:');
  const { sum: fcfSum, count: countFcf } = sumDuraciones((row) => {
    if (!tipoMusicaCol) return false;
    const val = row[tipoMusicaCol];
    if (isEmpty(val)) return false;
    return String(val).toUpperCase().trim() === 'FCF';
  }, 'FCFs');

  console.log('========================================');

  // Porcentajes
  const pctAnalizado = tiempoEmision > 0 ? (tiempoAnalizado / tiempoEmision) * 100 : 0;
  const pctMusica = tiempoAnalizado > 0 ? (sumaMusica / tiempoAnalizado) * 100 : 0;
  const pctMusicaIdentificada = tiempoAnalizado > 0 ? (musicaIdentificada / tiempoAnalizado) * 100 : 0;
  const pctMusicaComercial = tiempoAnalizado > 0 ? (musicaComercial / tiempoAnalizado) * 100 : 0;
  const pctFCF = tiempoAnalizado > 0 ? (fcfSum / tiempoAnalizado) * 100 : 0;

  console.log('📊 PORCENTAJES:');
  console.log(`  % Analizado: ${pctAnalizado.toFixed(2)}%`);
  console.log(`  % Música: ${pctMusica.toFixed(2)}%`);
  console.log(`  % Música Identificada: ${pctMusicaIdentificada.toFixed(2)}%`);
  console.log(`  % Música Comercial: ${pctMusicaComercial.toFixed(2)}%`);
  console.log(`  % FCFs: ${pctFCF.toFixed(2)}%`);

  // --- TOCADAS POR DÍA DEL MES ---
  console.log('\n📅 Calculando tocadas por día del mes...');

  // Inicializar el conteo de tocadas por día (1 a 31)
  const tocadasPorDia = {};
  for (let i = 1; i <= 31; i++) {
    tocadasPorDia[i] = 0;
  }

  // Contar tocadas por día del mes
  if (fechaCol && tituloCol && mesReferencia !== null) {
    console.log('📊 Contando tocadas por día...');
    let totalTocadas = 0;
    let filasConFecha = 0;
    let filasSinFecha = 0;
    let filasSinTitulo = 0;
    
    data.forEach(row => {
      // Verificar que el título no sea nulo
      if (isTituloNulo(row)) {
        filasSinTitulo++;
        return;
      }
      
      const fechaVal = row[fechaCol];
      const fecha = parseFechaDDMMYY(fechaVal);
      
      if (fecha) {
        filasConFecha++;
        // Verificar que sea del mismo mes y año
        if (fecha.getMonth() === mesReferencia && fecha.getFullYear() === anioReferencia) {
          const dia = fecha.getDate();
          tocadasPorDia[dia] = (tocadasPorDia[dia] || 0) + 1;
          totalTocadas++;
        }
      } else {
        filasSinFecha++;
      }
    });
    
    // Mostrar resumen detallado
    console.log(`📊 Resumen de conteo:`);
    console.log(`  ✅ Filas con fecha válida: ${filasConFecha}`);
    console.log(`  ❌ Filas sin fecha válida: ${filasSinFecha}`);
    console.log(`  ❌ Filas sin título: ${filasSinTitulo}`);
    console.log(`  📊 Total tocadas: ${totalTocadas}`);
    
    // Mostrar días con tocadas
    let diasConTocadas = 0;
    for (let i = 1; i <= diasDelMes; i++) {
      if (tocadasPorDia[i] > 0) diasConTocadas++;
    }
    console.log(`  📊 Días con tocadas: ${diasConTocadas} de ${diasDelMes}`);
    console.log('📊 Tocadas por día:', tocadasPorDia);
    
  } else {
    console.warn('⚠️ No se pudo calcular tocadas por día:');
    if (!fechaCol) console.warn('  - Falta columna de fecha');
    if (!tituloCol) console.warn('  - Falta columna de título');
    if (mesReferencia === null) console.warn('  - No se encontró fecha de referencia');
  }

  console.log('✅ Análisis Broadcast completado');

  // --- CÁLCULO DE ERRORES ---
  console.log('\n📊 CALCULANDO ERRORES');
  console.log('========================================');

  // 1. Días sin tocadas
  let diasSinTocadas = 0;
  let diasConTocadas = 0;
  if (mesReferencia !== null) {
    for (let i = 1; i <= diasDelMes; i++) {
      if (tocadasPorDia[i] > 0) {
        diasConTocadas++;
      } else {
        diasSinTocadas++;
      }
    }
    console.log(`📊 Días sin tocadas: ${diasSinTocadas} de ${diasDelMes}`);
  }

  // 2. Celdas vacías en Título pero con Label no vacío
  let erroresLabelSinTitulo = 0;
  let labelCol = null;

  // Buscar columna de Sello (posibles nombres)
  const posiblesLabel = ['Label', 'Sello', 'Labels', 'Sellos', 'label', 'sello'];
  labelCol = colNames.find(c => posiblesLabel.includes(c) || /label|sello|tag/i.test(c));

  if (labelCol) {
    console.log(`📊 Columna de Label encontrada: ${labelCol}`);
    
    data.forEach(row => {
      const titulo = row[tituloCol];
      const label = row[labelCol];
      
      // Verificar si Título está vacío/nulo
      const tituloVacio = titulo === null || titulo === undefined || String(titulo).trim() === '';
      // Verificar si Label NO está vacío
      const labelNoVacio = label !== null && label !== undefined && String(label).trim() !== '';
      
      if (tituloVacio && labelNoVacio) {
        erroresLabelSinTitulo++;
      }
    });
    console.log(`📊 Celdas con Label pero sin Título: ${erroresLabelSinTitulo}`);
  } else {
    console.warn('⚠️ No se encontró columna de Label para calcular errores');
  }

  console.log('========================================');

  return {
    tiempoEmision,
    tiempoAnalizado,
    sumaMusica,
    musicaIdentificada,
    musicaComercial,
    fcfSum,
    pctAnalizado,
    pctMusica,
    pctMusicaIdentificada,
    pctMusicaComercial,
    pctFCF,
    tocadasPorDia: tocadasPorDia,
    diasDelMes: diasDelMes || 31,
    mesReferencia: mesReferencia,
    anioReferencia: anioReferencia,
    diasSinTocadas: diasSinTocadas,
    erroresLabelSinTitulo: erroresLabelSinTitulo,
    labelCol: labelCol,
    hasData: true
  };
}

// ===================================================================
// 7. RENDERIZADO - OVERVIEW
// ===================================================================
function renderOverview() {
  // Cancelar cualquier renderizado pendiente
  if (renderTimeout) {
    clearTimeout(renderTimeout);
    renderTimeout = null;
  }
  
  if (isProcessing) {
    renderTimeout = setTimeout(() => renderOverview(), 100);
    return;
  }
  
  if (!currentAnalysis) {
    console.warn('⚠️ No hay análisis para renderizar');
    return;
  }
  
  isProcessing = true;
  
  try {
    // Destruir gráficos anteriores
    destroyAllCharts();
    // Limpiar específicamente el chart de días
    if (chartInstances.weekday) {
      try { chartInstances.weekday.destroy(); } catch(e) {}
      chartInstances.weekday = null;
    }

    const titleEl = document.getElementById('overview-title');
    const subtitleEl = document.getElementById('overview-subtitle');
    if (titleEl) titleEl.textContent = currentFileName || 'Análisis';
    if (subtitleEl) {
      subtitleEl.textContent = `${currentAnalysis.rowCount.toLocaleString('es')} filas · ${currentAnalysis.columnCount} columnas · ${new Date(currentAnalysis.timestamp).toLocaleString('es')}`;
    }

    const isBroadcast = currentMode === 'broadcast' && currentBroadcastData && currentBroadcastData.hasData;
    
    const defaultCharts = document.getElementById('default-charts');
    const broadcastCharts = document.getElementById('broadcast-charts');
    
    if (defaultCharts) defaultCharts.style.display = isBroadcast ? 'none' : 'grid';
    if (broadcastCharts) broadcastCharts.style.display = isBroadcast ? 'block' : 'none';

    if (isBroadcast) {
      renderBroadcastOverview();
    } else {
      renderDefaultOverview();
    }
  } catch (error) {
    console.error('Error en renderOverview:', error);
  } finally {
    isProcessing = false;
    renderTimeout = null;
  }
}

function renderDefaultOverview() {
  const statCards = document.getElementById('stat-cards');
  if (!statCards) return;
  
  const cards = [
    { icon: 'fa-table', label: 'Filas', value: currentAnalysis.rowCount.toLocaleString('es'), color: 'var(--accent)' },
    { icon: 'fa-columns', label: 'Columnas', value: currentAnalysis.columnCount, color: '#60a5fa' },
    { icon: 'fa-calculator', label: 'Numéricas', value: currentAnalysis.typeCounts.numeric, color: '#93c5fd' },
    { icon: 'fa-tags', label: 'Categóricas', value: currentAnalysis.typeCounts.categorical, color: '#fde68a' },
    { icon: 'fa-calendar', label: 'Fechas', value: currentAnalysis.typeCounts.date, color: '#6ee7b7' },
    { icon: 'fa-exclamation-triangle', label: 'Nulos', value: `${currentAnalysis.totalNulls.toLocaleString('es')} (${currentAnalysis.nullPercentage}%)`, color: parseFloat(currentAnalysis.nullPercentage) > 10 ? 'var(--danger)' : 'var(--warning)' }
  ];

  statCards.innerHTML = cards.map(c => `
    <div class="card stat-card" style="padding:20px;">
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="width:36px; height:36px; border-radius:8px; background:${c.color}15; display:flex; align-items:center; justify-content:center;">
          <i class="fas ${c.icon}" style="color:${c.color}; font-size:14px;"></i>
        </div>
        <div>
          <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">${c.label}</div>
          <div class="mono" style="font-size:18px; font-weight:600; color:${c.color};">${c.value}</div>
        </div>
      </div>
    </div>
  `).join('');

  // Chart: Tipos de datos
  const ctxTypes = document.getElementById('chart-types');
  if (ctxTypes) {
    try {
      if (chartInstances.types) chartInstances.types.destroy();
      chartInstances.types = new Chart(ctxTypes, {
        type: 'doughnut',
        data: {
          labels: ['Numérico', 'Categórico', 'Fecha', 'Mixto'],
          datasets: [{
            data: [currentAnalysis.typeCounts.numeric || 0, currentAnalysis.typeCounts.categorical || 0, currentAnalysis.typeCounts.date || 0, currentAnalysis.typeCounts.mixed || 0],
            backgroundColor: ['rgba(96,165,250,0.7)', 'rgba(251,191,36,0.7)', 'rgba(52,211,153,0.7)', 'rgba(248,113,113,0.7)'],
            borderColor: 'transparent',
            borderWidth: 0
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '65%',
          plugins: { legend: { position: 'bottom', labels: { color: '#8fa898', padding: 16, font: { family: 'Space Grotesk', size: 12 } } } }
        }
      });
    } catch (e) { console.warn('Chart error:', e); }
  }

  // Tabla resumen
  const tbody = document.querySelector('#columns-summary-table tbody');
  if (tbody) {
    tbody.innerHTML = currentAnalysis.columns.map(col => {
      const a = currentAnalysis.columnAnalyses[col];
      const mainStat = a.type === 'numeric' ? formatNumber(a.mean) : (a.mode || '—');
      return `<tr>
        <td class="mono" style="font-weight:500;">${col}</td>
        <td>${typeBadge(a.type)}</td>
        <td class="mono">${a.uniqueCount}</td>
        <td class="mono">${a.nullCount}</td>
        <td class="mono" style="color:${parseFloat(a.nullPercentage) > 10 ? 'var(--danger)' : 'var(--text-secondary)'}">${a.nullPercentage}%</td>
        <td class="mono">${mainStat}</td>
      </tr>`;
    }).join('');
  }
}

// ===================================================================
// 8. RENDERIZADO - BROADCAST
// ===================================================================
function renderTocadasPorDia(bd) {
  const ctxWeekday = document.getElementById('chart-weekday');
  if (!ctxWeekday) {
    console.warn('⚠️ No se encontró el canvas chart-weekday');
    return;
  }
  
  // Verificar que no haya un gráfico existente
  if (chartInstances.weekday) {
    try {
      chartInstances.weekday.destroy();
      chartInstances.weekday = null;
    } catch(e) {
      console.warn('Error destruyendo gráfico anterior:', e);
    }
  }
  
  if (!bd || !bd.tocadasPorDia) {
    console.warn('⚠️ No hay datos para el gráfico de días');
    ctxWeekday.style.display = 'none';
    return;
  }
  
  ctxWeekday.style.display = 'block';
  
  try {
    const diasDelMes = bd.diasDelMes || 31;
    const labels = [];
    const data = [];
    
    for (let i = 1; i <= diasDelMes; i++) {
      labels.push(String(i));
      data.push(bd.tocadasPorDia[i] || 0);
    }
    
    const backgroundColor = data.map(val => 
      val > 0 ? 'rgba(52,211,153,0.7)' : 'rgba(42,61,48,0.3)'
    );
    
    chartInstances.weekday = new Chart(ctxWeekday, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Tocadas',
          data: data,
          backgroundColor: backgroundColor,
          borderColor: 'transparent',
          borderRadius: 3,
          barPercentage: 0.9,
          categoryPercentage: 0.95
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function(context) {
                return `Día ${context.label}: ${context.parsed.y} tocadas`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { 
              color: '#8fa898', 
              font: { family: 'Space Grotesk', size: 10 },
              maxTicksLimit: 31,
              autoSkip: true,
              maxRotation: 0
            }
          },
          y: {
            grid: { color: 'rgba(42,61,48,0.3)' },
            ticks: { 
              color: '#5c7a66',
              font: { family: 'Space Grotesk', size: 11 },
              beginAtZero: true,
              stepSize: 1
            }
          }
        }
      }
    });
    
    // Actualizar el título del gráfico
    const chartTitle = document.querySelector('#broadcast-charts .card h3');
    if (chartTitle) {
      const mesNombre = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
      const mes = (bd.mesReferencia !== null && bd.mesReferencia !== undefined) ? mesNombre[bd.mesReferencia] : '';
      const anio = bd.anioReferencia || '';
      chartTitle.innerHTML = `<i class="fas fa-calendar-day" style="margin-right:8px;"></i> Tocadas por Día - ${mes} ${anio}`.trim();
    }
    
  } catch (e) {
    console.warn('Error creando chart de días:', e);
  }
}

function renderBroadcastOverview() {
  const bd = currentBroadcastData;
  if (!bd) {
    console.warn('⚠️ No hay datos Broadcast');
    return;
  }

  // --- CARDS DE ERRORES ---
  const errorCards = document.getElementById('error-cards');
  if (errorCards) {
    const errorStats = [
      { icon: 'fa-clock', label: 'Tiempo de Emisión', value: formatDuration(bd.tiempoEmision), color: '#60a5fa' },
      { 
        icon: 'fa-calendar-times', 
        label: 'Días sin tocadas', 
        value: `${bd.diasSinTocadas || 0} de ${bd.diasDelMes || 31}`,
        color: bd.diasSinTocadas > 0 ? 'var(--danger)' : 'var(--accent)',
        bgColor: bd.diasSinTocadas > 0 ? 'rgba(248,113,113,0.15)' : 'rgba(52,211,153,0.15)'
      },
      { 
        icon: 'fa-exclamation-triangle', 
        label: 'Track sin Título', 
        value: (bd.erroresLabelSinTitulo || 0).toLocaleString('es'),
        color: (bd.erroresLabelSinTitulo || 0) > 0 ? 'var(--warning)' : 'var(--accent)',
        bgColor: (bd.erroresLabelSinTitulo || 0) > 0 ? 'rgba(251,191,36,0.15)' : 'rgba(52,211,153,0.15)'
      }
    ];

    errorCards.innerHTML = errorStats.map(c => `
      <div class="card stat-card" style="padding:20px; border-left: 3px solid ${c.color};">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:36px; height:36px; border-radius:8px; background:${c.bgColor}; display:flex; align-items:center; justify-content:center;">
            <i class="fas ${c.icon}" style="color:${c.color}; font-size:14px;"></i>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">${c.label}</div>
            <div class="mono" style="font-size:20px; font-weight:600; color:${c.color};">${c.value}</div>
          </div>
        </div>
      </div>
    `).join('');
  }

  const statCards = document.getElementById('stat-cards');
  if (!statCards) return;
  
  const stats = [
    { icon: 'fa-chart-line', label: 'Tiempo Analizado', value: formatDuration(bd.tiempoAnalizado), color: 'var(--accent)' },
    { icon: 'fa-music', label: 'Música y Música+Palabra', value: formatDuration(bd.sumaMusica), color: '#6ee7b7' },
    { icon: 'fa-headphones', label: 'Música Identificada', value: formatDuration(bd.musicaIdentificada), color: '#93c5fd' },
    { icon: 'fa-tag', label: 'Música Comercial', value: formatDuration(bd.musicaComercial), color: '#fde68a' },
    { icon: 'fa-flag', label: 'FCFs', value: formatDuration(bd.fcfSum), color: '#f87171' }
  ];

  statCards.innerHTML = stats.map(c => `
    <div class="card stat-card broadcast-stat" style="padding:20px; border-left-color: ${c.color};">
      <div style="display:flex; align-items:center; gap:12px;">
        <div style="width:36px; height:36px; border-radius:8px; background:${c.color}15; display:flex; align-items:center; justify-content:center;">
          <i class="fas ${c.icon}" style="color:${c.color}; font-size:14px;"></i>
        </div>
        <div>
          <div class="stat-label" style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.5px;">${c.label}</div>
          <div class="stat-value mono" style="font-size:18px; font-weight:600; color:${c.color};">${c.value}</div>
        </div>
      </div>
    </div>
  `).join('');

  // Porcentajes
  const broadcastStats = document.getElementById('broadcast-stats');
  if (broadcastStats) {
    const pctStats = [
      { label: '% Analizado', value: bd.pctAnalizado.toFixed(2) + '%', color: 'var(--accent)' },
      { label: '% Música', value: bd.pctMusica.toFixed(2) + '%', color: '#6ee7b7' },
      { label: '% Música Identificada', value: bd.pctMusicaIdentificada.toFixed(2) + '%', color: '#93c5fd' },
      { label: '% Música Comercial', value: bd.pctMusicaComercial.toFixed(2) + '%', color: '#fde68a' },
      { label: '% FCFs', value: bd.pctFCF.toFixed(2) + '%', color: '#f87171' }
    ];
    broadcastStats.innerHTML = pctStats.map(s => `
      <div class="card" style="padding:16px; text-align:center;">
        <div style="font-size:24px; font-weight:700; color:${s.color};" class="mono">${s.value}</div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${s.label}</div>
      </div>
    `).join('');
  }

  // Gráfico de tocadas por día
  renderTocadasPorDia(bd);

  // Tabla resumen de columnas
  const tbody = document.querySelector('#columns-summary-table tbody');
  if (tbody) {
    tbody.innerHTML = currentAnalysis.columns.map(col => {
      const a = currentAnalysis.columnAnalyses[col];
      const mainStat = a.type === 'numeric' ? formatNumber(a.mean) : (a.mode || '—');
      return `<tr>
        <td class="mono" style="font-weight:500;">${col}</td>
        <td>${typeBadge(a.type)}</td>
        <td class="mono">${a.uniqueCount}</td>
        <td class="mono">${a.nullCount}</td>
        <td class="mono" style="color:${parseFloat(a.nullPercentage) > 10 ? 'var(--danger)' : 'var(--text-secondary)'}">${a.nullPercentage}%</td>
        <td class="mono">${mainStat}</td>
      </tr>`;
    }).join('');
  }
}

// ===================================================================
// 9. NAVEGACIÓN
// ===================================================================
function navigateTo(section) {
  if (isProcessing) {
    setTimeout(() => navigateTo(section), 100);
    return;
  }
  
  console.log('🔀 Navegando a:', section);
  
  document.querySelectorAll('main > section').forEach(s => s.style.display = 'none');
  const target = document.getElementById('section-' + section);
  if (target) {
    target.style.display = 'block';
    target.classList.remove('section-enter');
    void target.offsetWidth;
    target.classList.add('section-enter');
  }

  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.nav === section);
  });

  if (section === 'overview') renderOverview();
  else if (section === 'upload') loadQuickHistory();
  else if (section === 'history') renderHistory();
  else if (section === 'data') renderRawData();
  else if (section === 'columns') renderColumnDetails();
  else if (section === 'correlations') renderCorrelations();
  else if (section === 'distributions') renderDistributions();
  else if (section === 'compare') renderCompareSelects();
  else if (section === 'logs') renderLogsView();
}

function updateNavVisibility() {
  const hasData = !!currentAnalysis;
  const isBroadcast = currentMode === 'broadcast';
  
  // Tabs que solo se muestran en modo Default (cuando hay datos)
  const defaultOnlyTabs = ['columns', 'correlations', 'distributions'];
  
  // Tabs que se muestran en ambos modos (cuando hay datos)
  const commonTabs = ['overview', 'data'];
  
  // Mostrar/ocultar tabs según modo
  commonTabs.forEach(id => {
    const el = document.getElementById('nav-' + id);
    if (el) el.style.display = hasData ? 'flex' : 'none';
  });
  
  defaultOnlyTabs.forEach(id => {
    const el = document.getElementById('nav-' + id);
    if (el) {
      // Mostrar solo si hay datos Y NO estamos en modo Broadcast
      el.style.display = (hasData && !isBroadcast) ? 'flex' : 'none';
    }
  });
  
  // Comparar siempre visible si hay al menos 2 análisis guardados
  getAllAnalyses().then(all => {
    const el = document.getElementById('nav-compare');
    if (el) el.style.display = all.length >= 2 ? 'flex' : 'none';
  });
}

// ===================================================================
// 10. MODO - ACTUALIZADO
// ===================================================================
function setMode(mode) {
  if (isProcessing) {
    setTimeout(() => setMode(mode), 100);
    return;
  }
  
  if (currentMode === mode) {
    console.log('ℹ️ Ya estamos en modo', mode);
    return;
  }
  
  console.log('🔀 Cambiando modo a:', mode);
  currentMode = mode;
  
  document.querySelectorAll('.mode-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  
  const descriptions = {
    default: 'Análisis estándar con estadísticas generales',
    broadcast: 'Análisis especializado para datos de emisiones de radio'
  };
  const descEl = document.getElementById('mode-description');
  if (descEl) descEl.textContent = descriptions[mode] || '';
  
  // Actualizar visibilidad de tabs según el modo
  updateNavVisibility();
  
  if (currentAnalysis && currentRawData) {
    if (mode === 'broadcast') {
      console.log('📊 Recalculando análisis Broadcast...');
      currentBroadcastData = analyzeBroadcastData(currentRawData);
      console.log('✅ Broadcast recalculado');
    } else {
      currentBroadcastData = null;
    }
    renderOverview();
  } else {
    console.log('ℹ️ No hay datos cargados, solo cambiando modo');
  }
}

// ===================================================================
// 11. CARGA DE ARCHIVOS
// ===================================================================
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');

if (dropZone) {
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
}

if (fileInput) {
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });
}

function handleFile(file) {
  if (isProcessing) {
    showToast('Ya hay un proceso en ejecución', 'info');
    return;
  }
  
  const validExts = ['.xlsx', '.xls', '.csv'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!validExts.includes(ext)) {
    showToast('Formato no soportado. Usa .xlsx, .xls o .csv', 'error');
    return;
  }

  console.log('📁 Cargando archivo:', file.name);
  currentFileName = file.name;
  
  const loading = document.getElementById('upload-loading');
  const progressFill = document.getElementById('progress-fill');
  const loadingText = document.getElementById('loading-text');
  
  if (loading) loading.style.display = 'block';
  if (progressFill) progressFill.style.width = '10%';
  if (loadingText) loadingText.textContent = 'Leyendo archivo...';

  isProcessing = true;

  const reader = new FileReader();
  reader.onload = (e) => {
    if (progressFill) progressFill.style.width = '50%';
    if (loadingText) loadingText.textContent = 'Parseando contenido...';
    setTimeout(() => processWorkbook(e.target.result, progressFill, loadingText, loading), 50);
  };
  reader.onerror = () => {
    if (loading) loading.style.display = 'none';
    showToast('Error al leer el archivo', 'error');
    isProcessing = false;
  };
  reader.readAsArrayBuffer(file);
}

function processWorkbook(data, progressFill, loadingText, loadingEl) {
  try {
    const wb = XLSX.read(data, { type: 'array', cellDates: true });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { defval: null });

    if (jsonData.length === 0) {
      if (loadingEl) loadingEl.style.display = 'none';
      showToast('El archivo está vacío o no tiene datos válidos', 'error');
      isProcessing = false;
      return;
    }

    console.log('📊 Datos cargados:', jsonData.length, 'filas');
    console.log('📋 Columnas:', Object.keys(jsonData[0]));

    if (progressFill) progressFill.style.width = '70%';
    if (loadingText) loadingText.textContent = 'Analizando datos...';

    currentRawData = jsonData;

    setTimeout(() => {
      currentAnalysis = analyzeData(jsonData);
      console.log('✅ Análisis Default completado');
      
      if (currentMode === 'broadcast') {
        console.log('📊 Calculando análisis Broadcast...');
        currentBroadcastData = analyzeBroadcastData(jsonData);
        console.log('✅ Análisis Broadcast completado');
      } else {
        currentBroadcastData = null;
      }
      
      if (progressFill) progressFill.style.width = '100%';
      if (loadingText) loadingText.textContent = 'Análisis completo';

      setTimeout(() => {
        if (loadingEl) loadingEl.style.display = 'none';
        if (progressFill) progressFill.style.width = '0%';
        updateNavVisibility();
        navigateTo('overview');
        showToast(`Analizadas ${jsonData.length} filas y ${currentAnalysis.columnCount} columnas`);
        isProcessing = false;
      }, 300);
    }, 100);

  } catch (err) {
    console.error('❌ Error procesando archivo:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    showToast('Error al procesar: ' + err.message, 'error');
    isProcessing = false;
  }
}

// ===================================================================
// 12. FUNCIONES RESTANTES (SIMPLIFICADAS)
// ===================================================================
function showSaveModal() {
  if (!currentAnalysis) { showToast('No hay datos para guardar', 'error'); return; }
  showModal(`
    <h3 style="font-size:18px; font-weight:700; margin-bottom:8px;">Guardar Análisis</h3>
    <p style="color:var(--text-muted); font-size:13px; margin-bottom:20px;">Asigna un nombre para identificar este análisis posteriormente.</p>
    <input type="text" class="input-field" id="save-name" placeholder="Ej: Ventas Q4 2024" value="${currentFileName ? currentFileName.replace(/\.[^.]+$/, '') : 'análisis'}" style="margin-bottom:20px;">
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn-primary" onclick="doSave()">Guardar</button>
    </div>
  `);
  setTimeout(() => { const input = document.getElementById('save-name'); if (input) input.focus(); }, 100);
}

async function doSave() {
  const name = document.getElementById('save-name').value.trim();
  if (!name) { showToast('Ingresa un nombre para el análisis', 'error'); return; }
  try {
    await saveAnalysis(name, currentFileName, currentAnalysis, currentMode, currentBroadcastData);
    closeModal();
    showToast('Análisis guardado correctamente');
    await updateDBStats();
    updateNavVisibility();
    loadQuickHistory();
  } catch (e) { showToast('Error al guardar: ' + e.message, 'error'); }
}

async function loadSavedAnalysis(id) {
  const record = await getAnalysisById(id);
  if (!record) { showToast('Análisis no encontrado', 'error'); return; }
  currentAnalysis = record.analysis;
  currentFileName = record.fileName;
  currentMode = record.mode || 'default';
  currentBroadcastData = record.broadcastData || null;
  currentRawData = null;
  
  document.querySelectorAll('.mode-option').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === currentMode);
  });
  const descEl = document.getElementById('mode-description');
  if (descEl) descEl.textContent = currentMode === 'broadcast' ? 'Análisis especializado para datos de emisiones de radio' : 'Análisis estándar con estadísticas generales';
  
  updateNavVisibility();
  navigateTo('overview');
  showToast(`Cargado: ${record.name}`);
}

function confirmDelete(id, name) {
  showModal(`
    <h3 style="font-size:18px; font-weight:700; margin-bottom:8px;">Eliminar Análisis</h3>
    <p style="color:var(--text-secondary); margin-bottom:20px;">Vas a eliminar <strong>"${name}"</strong>. Esta acción no se puede deshacer.</p>
    <div style="display:flex; gap:8px; justify-content:flex-end;">
      <button class="btn-ghost" onclick="closeModal()">Cancelar</button>
      <button class="btn-primary" style="background:linear-gradient(135deg, #dc2626, #f87171);" onclick="doDelete(${id})">Eliminar</button>
    </div>
  `);
}

async function doDelete(id) {
  await deleteAnalysis(id);
  closeModal();
  showToast('Análisis eliminado');
  await updateDBStats();
  updateNavVisibility();
  renderHistory();
}

async function loadQuickHistory() {
  const all = await getAllAnalyses();
  const container = document.getElementById('quick-history');
  const list = document.getElementById('quick-history-list');
  if (all.length === 0) { if (container) container.style.display = 'none'; return; }
  if (container) container.style.display = 'block';
  if (list) {
    list.innerHTML = all.slice(0, 3).map(a => {
      const date = new Date(a.timestamp).toLocaleDateString('es');
      return `<div class="card" style="padding:16px; cursor:pointer;" onclick="loadSavedAnalysis(${a.id})">
        <div style="font-weight:600; font-size:13px; margin-bottom:4px;">${a.name}</div>
        <div style="font-size:11px; color:var(--text-muted);">${a.fileName} · ${date} · ${a.analysis.rowCount.toLocaleString('es')} filas</div>
      </div>`;
    }).join('');
  }
}

async function renderHistory() {
  const all = await getAllAnalyses();
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');

  if (all.length === 0) {
    if (list) list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  if (list) {
    list.innerHTML = all.map(a => {
      const analysis = a.analysis;
      const date = new Date(a.timestamp).toLocaleString('es');
      const modeLabel = a.mode === 'broadcast' ? '📡 Broadcast' : '📊 Default';
      return `<div class="card" style="padding:20px; margin-bottom:12px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div style="flex:1; min-width:200px;">
          <div style="font-weight:600; font-size:15px; margin-bottom:4px;">${a.name}</div>
          <div style="font-size:12px; color:var(--text-muted);">${a.fileName} · ${date}</div>
          <div style="display:flex; gap:12px; margin-top:8px; flex-wrap:wrap;">
            <span class="mono" style="font-size:12px; color:var(--accent);">${analysis.rowCount.toLocaleString('es')} filas</span>
            <span class="mono" style="font-size:12px; color:#93c5fd;">${analysis.columnCount} cols</span>
            <span class="badge" style="font-size:10px;">${modeLabel}</span>
          </div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-ghost" onclick="loadSavedAnalysis(${a.id})"><i class="fas fa-eye" style="margin-right:4px;"></i> Ver</button>
          <button class="btn-ghost" onclick="confirmDelete(${a.id}, '${a.name.replace(/'/g, "\\'")}')" style="color:var(--danger); border-color:rgba(248,113,113,0.3);"><i class="fas fa-trash"></i></button>
        </div>
      </div>`;
    }).join('');
  }
}

async function renderCompareSelects() {
  const all = await getAllAnalyses();
  const selA = document.getElementById('compare-a');
  const selB = document.getElementById('compare-b');
  const opts = all.map(a => `<option value="${a.id}">${a.name} (${a.fileName})</option>`).join('');
  if (selA) selA.innerHTML = opts;
  if (selB) selB.innerHTML = opts;
  if (all.length >= 2 && selB) selB.selectedIndex = 1;
  runComparison();
}

async function runComparison() {
  const idA = parseInt(document.getElementById('compare-a')?.value);
  const idB = parseInt(document.getElementById('compare-b')?.value);
  const container = document.getElementById('comparison-result');

  if (!idA || !idB || idA === idB) {
    if (container) container.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:40px;">Selecciona dos análisis diferentes para comparar.</p>';
    return;
  }

  const a = await getAnalysisById(idA);
  const b = await getAnalysisById(idB);
  if (!a || !b) return;

  const an = a.analysis;
  const bn = b.analysis;

  let html = `<div class="card" style="padding:20px; margin-bottom:16px;">
    <h3 style="font-size:14px; font-weight:600; margin-bottom:16px; color:var(--text-secondary);">Comparación General</h3>
    <table class="data-table">
      <thead><tr><th>Métrica</th><th>${a.name}</th><th>${b.name}</th><th>Diferencia</th></tr></thead>
      <tbody>`;

  const generalMetrics = [
    { label: 'Filas', keyA: an.rowCount, keyB: bn.rowCount },
    { label: 'Columnas', keyA: an.columnCount, keyB: bn.columnCount },
    { label: 'Columnas numéricas', keyA: an.typeCounts.numeric, keyB: bn.typeCounts.numeric }
  ];

  generalMetrics.forEach(m => {
    const diff = m.keyB - m.keyA;
    const diffStr = typeof m.keyA === 'number' && Number.isInteger(m.keyA) ? diff.toLocaleString('es') : diff.toFixed(2);
    const cls = diff > 0 ? 'diff-negative' : diff < 0 ? 'diff-positive' : 'diff-neutral';
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    html += `<tr>
      <td>${m.label}</td>
      <td class="mono">${m.keyA.toLocaleString('es')}</td>
      <td class="mono">${m.keyB.toLocaleString('es')}</td>
      <td class="mono ${cls}">${arrow} ${diffStr}</td>
    </tr>`;
  });

  html += '</tbody></table></div>';
  if (container) container.innerHTML = html;
}

function renderRawData() {
  if (!currentRawData) { showToast('No hay datos cargados', 'error'); return; }
  dataPage = 0;
  const rawInfo = document.getElementById('raw-data-info');
  if (rawInfo) rawInfo.textContent = `Mostrando ${Math.min(DATA_PAGE_SIZE, currentRawData.length)} de ${currentRawData.length.toLocaleString('es')} filas`;

  const table = document.getElementById('raw-data-table');
  if (!table) return;
  const thead = table.querySelector('thead');
  if (thead) {
    thead.innerHTML = '<tr>' + currentAnalysis.columns.map(c => `<th>${c.length > 25 ? c.slice(0, 23) + '…' : c}</th>`).join('') + '</tr>';
  }
  renderDataPage();
}

function renderDataPage() {
  const search = (document.getElementById('data-search')?.value || '').toLowerCase();
  let filtered = currentRawData;
  if (search) {
    filtered = currentRawData.filter(row => currentAnalysis.columns.some(c => String(row[c] || '').toLowerCase().includes(search)));
  }

  const totalPages = Math.ceil(filtered.length / DATA_PAGE_SIZE);
  if (dataPage >= totalPages) dataPage = Math.max(0, totalPages - 1);
  const start = dataPage * DATA_PAGE_SIZE;
  const pageData = filtered.slice(start, start + DATA_PAGE_SIZE);

  const rawInfo = document.getElementById('raw-data-info');
  if (rawInfo) rawInfo.textContent = `Mostrando ${start + 1}-${Math.min(start + DATA_PAGE_SIZE, filtered.length)} de ${filtered.length.toLocaleString('es')} filas`;

  const tbody = document.querySelector('#raw-data-table tbody');
  if (tbody) {
    tbody.innerHTML = pageData.map(row =>
      '<tr>' + currentAnalysis.columns.map(c => {
        let val = row[c];
        if (val instanceof Date) val = val.toLocaleDateString('es');
        if (val === null || val === undefined) val = '<span style="color:var(--text-muted);">null</span>';
        else val = String(val);
        return `<td>${val}</td>`;
      }).join('') + '</tr>'
    ).join('');
  }

  const pag = document.getElementById('data-pagination');
  if (!pag) return;
  if (totalPages <= 1) { pag.innerHTML = ''; return; }

  let pagHtml = '';
  pagHtml += `<button class="btn-ghost" onclick="dataPage=Math.max(0,dataPage-1);renderDataPage()" ${dataPage === 0 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''}><i class="fas fa-chevron-left"></i></button>`;
  const maxButtons = 7;
  let startPage = Math.max(0, dataPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages - 1, startPage + maxButtons - 1);
  if (endPage - startPage < maxButtons - 1) startPage = Math.max(0, endPage - maxButtons + 1);
  for (let i = startPage; i <= endPage; i++) {
    const active = i === dataPage;
    pagHtml += `<button class="${active ? 'btn-primary' : 'btn-ghost'}" onclick="dataPage=${i};renderDataPage()" style="min-width:36px;">${i + 1}</button>`;
  }
  pagHtml += `<button class="btn-ghost" onclick="dataPage=Math.min(${totalPages - 1},dataPage+1);renderDataPage()" ${dataPage >= totalPages - 1 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''}><i class="fas fa-chevron-right"></i></button>`;
  pag.innerHTML = pagHtml;
}

function filterDataTable() { dataPage = 0; renderDataPage(); }

function exportCurrentCSV() {
  if (!currentRawData) return;
  const headers = currentAnalysis.columns.join(',');
  const rows = currentRawData.map(row =>
    currentAnalysis.columns.map(c => {
      let val = row[c];
      if (val === null || val === undefined) return '';
      val = String(val);
      if (val.includes(',') || val.includes('"') || val.includes('\n')) val = '"' + val.replace(/"/g, '""') + '"';
      return val;
    }).join(',')
  );
  const csv = [headers, ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentFileName.replace(/\.[^.]+$/, '_export.csv');
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exportado correctamente');
}

function renderCorrelations() {
  if (!currentAnalysis) return;
  destroyAllCharts();
  const container = document.getElementById('correlation-container');
  if (!container) return;
  const numCols = currentAnalysis.numericCols;

  if (numCols.length < 2) {
    container.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:40px;">Se necesitan al menos 2 columnas numéricas para calcular correlaciones.</p>';
    return;
  }

  let html = '<table class="data-table" style="font-size:12px;"><thead><tr><th></th>';
  numCols.forEach(c => {
    const label = c.length > 15 ? c.slice(0, 13) + '…' : c;
    html += `<th style="font-size:10px; writing-mode:vertical-rl; text-orientation:mixed; padding:16px 6px; max-width:40px;">${label}</th>`;
  });
  html += '</tr></thead><tbody>';

  numCols.forEach(c1 => {
    const label = c1.length > 20 ? c1.slice(0, 18) + '…' : c1;
    html += `<tr><td class="mono" style="font-weight:600; font-size:11px; white-space:nowrap;">${label}</td>`;
    numCols.forEach(c2 => {
      if (c1 === c2) {
        html += `<td style="background:rgba(52,211,153,0.3); text-align:center; font-weight:700;" class="mono">1.00</td>`;
      } else {
        const key1 = `${c1}__${c2}`;
        const key2 = `${c2}__${c1}`;
        const corr = currentAnalysis.correlations[key1] || currentAnalysis.correlations[key2];
        const r = corr ? corr.r : 0;
        html += `<td style="background:${correlationColor(r)}; text-align:center;" class="mono">${r.toFixed(3)}</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderDistributions() {
  if (!currentAnalysis) return;
  destroyAllCharts();
  const container = document.getElementById('distribution-charts');
  if (!container) return;
  let html = '';

  currentAnalysis.columns.forEach((col, idx) => {
    const a = currentAnalysis.columnAnalyses[col];
    if (a.type === 'numeric') {
      html += `<div class="card" style="padding:20px;">
        <h4 class="mono" style="font-size:13px; font-weight:600; margin-bottom:12px; color:var(--text-secondary);">${col}</h4>
        <div style="height:250px;"><canvas id="dist-${idx}"></canvas></div>
      </div>`;
    }
    if (a.type === 'categorical' && a.topValues) {
      html += `<div class="card" style="padding:20px;">
        <h4 class="mono" style="font-size:13px; font-weight:600; margin-bottom:12px; color:var(--text-secondary);">${col}</h4>
        <div style="height:250px;"><canvas id="dist-${idx}"></canvas></div>
      </div>`;
    }
  });

  if (!html) {
    html = '<p style="color:var(--text-muted); text-align:center; grid-column:1/-1; padding:40px;">No hay columnas para mostrar distribuciones.</p>';
  }
  container.innerHTML = html;

  currentAnalysis.columns.forEach((col, idx) => {
    const a = currentAnalysis.columnAnalyses[col];
    const canvas = document.getElementById(`dist-${idx}`);
    if (!canvas) return;

    if (a.type === 'numeric' && a.values) {
      const bins = createHistogramBins(a.values, 15);
      chartInstances['dist-' + idx] = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: bins.map(b => b.label),
          datasets: [{ data: bins.map(b => b.count), backgroundColor: 'rgba(96,165,250,0.5)', borderColor: 'rgba(96,165,250,0.8)', borderWidth: 1, borderRadius: 3 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#5c7a66', font: { size: 9, family: 'JetBrains Mono' }, maxRotation: 45 } },
            y: { grid: { color: 'rgba(42,61,48,0.3)' }, ticks: { color: '#5c7a66' } }
          }
        }
      });
    }

    if (a.type === 'categorical' && a.topValues) {
      const topN = a.topValues.slice(0, 8);
      chartInstances['dist-' + idx] = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: topN.map(v => v[0].length > 15 ? v[0].slice(0, 13) + '…' : v[0]),
          datasets: [{ data: topN.map(v => v[1]), backgroundColor: generateColors(topN.length), borderRadius: 4 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          indexAxis: 'y',
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: 'rgba(42,61,48,0.3)' }, ticks: { color: '#5c7a66' } },
            y: { grid: { display: false }, ticks: { color: '#8fa898', font: { size: 11, family: 'Space Grotesk' } } }
          }
        }
      });
    }
  });
}

function renderColumnDetails() {
  if (!currentAnalysis) return;
  destroyAllCharts();
  const container = document.getElementById('column-details');
  if (!container) return;
  let html = '';

  currentAnalysis.columns.forEach((col, idx) => {
    const a = currentAnalysis.columnAnalyses[col];
    html += `<div class="card" style="padding:24px; margin-bottom:16px;">`;
    html += `<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">`;
    html += `<div><h3 class="mono" style="font-size:16px; font-weight:600;">${col}</h3>${typeBadge(a.type)} <span style="color:var(--text-muted); font-size:12px; margin-left:8px;">${a.nonNullCount} valores válidos</span></div>`;
    html += `</div>`;

    if (a.type === 'numeric') {
      const stats = [
        { label: 'Mínimo', value: formatNumber(a.min) },
        { label: 'Q1 (25%)', value: formatNumber(a.q1) },
        { label: 'Mediana', value: formatNumber(a.median) },
        { label: 'Media', value: formatNumber(a.mean) },
        { label: 'Q3 (75%)', value: formatNumber(a.q3) },
        { label: 'Máximo', value: formatNumber(a.max) },
        { label: 'Desv. Estándar', value: formatNumber(a.stdDev) },
        { label: 'Asimetría', value: formatNumber(a.skewness) }
      ];
      html += `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:12px; margin-bottom:20px;">`;
      stats.forEach(s => {
        html += `<div style="background:var(--bg-deep); padding:12px; border-radius:8px; border:1px solid var(--border);">
          <div style="font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.3px;">${s.label}</div>
          <div class="mono" style="font-size:16px; font-weight:600; margin-top:4px;">${s.value}</div>
        </div>`;
      });
      html += `</div>`;
      html += `<div style="height:160px;"><canvas id="col-chart-${idx}"></canvas></div>`;
    }

    if (a.type === 'categorical' && a.topValues) {
      html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">`;
      html += `<div><div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">Moda: <strong style="color:var(--text-primary);">${a.mode || '—'}</strong> (${a.modeCount} ocurrencias)</div>`;
      html += `<table class="data-table"><thead><tr><th>Valor</th><th>Frecuencia</th><th>%</th></tr></thead><tbody>`;
      a.topValues.forEach(([val, count]) => {
        const pct = ((count / a.nonNullCount) * 100).toFixed(1);
        html += `<tr><td style="max-width:150px;">${val}</td><td class="mono">${count}</td><td class="mono">${pct}%</td></tr>`;
      });
      html += `</tbody></table></div>`;
      html += `<div style="height:200px;"><canvas id="col-chart-${idx}"></canvas></div></div>`;
    }

    if (a.type === 'date') {
      html += `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:12px;">`;
      html += `<div style="background:var(--bg-deep); padding:12px; border-radius:8px; border:1px solid var(--border);">
        <div style="font-size:11px; color:var(--text-muted);">Fecha mínima</div>
        <div class="mono" style="font-size:14px; font-weight:600; margin-top:4px;">${a.minDate ? a.minDate.toLocaleDateString('es') : '—'}</div>
      </div>`;
      html += `<div style="background:var(--bg-deep); padding:12px; border-radius:8px; border:1px solid var(--border);">
        <div style="font-size:11px; color:var(--text-muted);">Fecha máxima</div>
        <div class="mono" style="font-size:14px; font-weight:600; margin-top:4px;">${a.maxDate ? a.maxDate.toLocaleDateString('es') : '—'}</div>
      </div></div>`;
    }
    html += `</div>`;
  });

  container.innerHTML = html;

  currentAnalysis.columns.forEach((col, idx) => {
    const a = currentAnalysis.columnAnalyses[col];
    const canvas = document.getElementById(`col-chart-${idx}`);
    if (!canvas) return;

    if (a.type === 'numeric' && a.values) {
      const bins = createHistogramBins(a.values, 20);
      chartInstances['col-' + idx] = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: bins.map(b => b.label),
          datasets: [{ data: bins.map(b => b.count), backgroundColor: 'rgba(52,211,153,0.5)', borderRadius: 2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { display: false }, ticks: { color: '#5c7a66', font: { size: 9, family: 'JetBrains Mono' }, maxRotation: 45 } },
            y: { grid: { color: 'rgba(42,61,48,0.3)' }, ticks: { color: '#5c7a66', font: { size: 10 } } }
          }
        }
      });
    }

    if (a.type === 'categorical' && a.topValues) {
      chartInstances['col-' + idx] = new Chart(canvas, {
        type: 'doughnut',
        data: {
          labels: a.topValues.map(v => v[0].length > 15 ? v[0].slice(0, 13) + '…' : v[0]),
          datasets: [{ data: a.topValues.map(v => v[1]), backgroundColor: generateColors(a.topValues.length), borderWidth: 0 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: '50%',
          plugins: { legend: { position: 'right', labels: { color: '#8fa898', font: { size: 10, family: 'Space Grotesk' }, boxWidth: 10, padding: 8 } } }
        }
      });
    }
  });
}

function renderLogsView() {
  const container = document.getElementById('logs-container');
  if (!container) return;
  container.innerHTML = `
    <div style="text-align:center; padding:40px; color:var(--text-muted);">
      <i class="fas fa-file-alt" style="font-size:40px; margin-bottom:16px; opacity:0.3;"></i>
      <p>Sistema de logs activo</p>
      <p style="font-size:13px; margin-top:4px;">Los logs se guardan automáticamente durante el análisis</p>
    </div>
  `;
}

// ===================================================================
// 13. INICIALIZACIÓN
// ===================================================================
(async function init() {
  console.log('🚀 Inicializando Broadcast...');
  try {
    await openDB();
    await updateDBStats();
    updateNavVisibility();
    loadQuickHistory();
    const descEl = document.getElementById('mode-description');
    if (descEl) descEl.textContent = 'Análisis estándar con estadísticas generales';
    console.log('✅ Broadcast listo');
  } catch (error) {
    console.error('Error en inicialización:', error);
  }
})();
