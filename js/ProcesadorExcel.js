// Listener para mostrar archivos seleccionados en la UI
document.addEventListener('DOMContentLoaded', () => {
  const crpInput = document.getElementById('crp-file-input');
  const topTracksInput = document.getElementById('toptracks-file-input');

  if (crpInput) {
    crpInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      const countDiv = document.getElementById('crp-file-count');
      countDiv.textContent = files.length > 0 ? `${files.length} archivos seleccionados` : '';
    });
  }

  if (topTracksInput) {
    topTracksInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const nameDiv = document.getElementById('toptracks-file-name');
      nameDiv.textContent = file ? `Cargado: ${file.name}` : '';
    });
  }
});

// Función auxiliar para convertir duraciones a segundos
function parseDurationToSeconds(val) {
  if (val === null || val === undefined) return 0;
  if (val instanceof Date) return val.getHours() * 3600 + val.getMinutes() * 60 + val.getSeconds();
  
  const str = String(val).trim();
  if (!str) return 0;

  const parts = str.split(':').map(p => parseFloat(p) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  
  const num = Number(val);
  return !isNaN(num) ? Math.round(num * 86400) : 0;
}

// Función auxiliar para obtener el día de la semana (0: Domingo, 6: Sábado)
function getDayOfWeek(val) {
  if (!val) return -1;
  if (val instanceof Date) return val.getDay();
  const parsedDate = new Date(String(val).trim());
  return !isNaN(parsedDate.getTime()) ? parsedDate.getDay() : -1;
}

async function procesarArchivosCRP() {
  const fileInput = document.getElementById('crp-file-input');
  const topTracksInput = document.getElementById('toptracks-file-input');
  const btnProcesar = document.getElementById('crp-btn-procesar');
  const statusDiv = document.getElementById('crp-status');
  const errorDiv = document.getElementById('crp-error');

  errorDiv.style.display = 'none';
  errorDiv.textContent = '';

  const files = Array.from(fileInput.files);
  const topTracksFile = topTracksInput.files[0];

  if (files.length === 0) {
    errorDiv.textContent = 'Por favor, selecciona al menos un archivo CRP (.xlsx).';
    errorDiv.style.display = 'block';
    return;
  }

  const columnasAEliminar = [
    'epg title', 'epg type', 'epg date', 'epg start time', 'epg end time', 'epg duration',
    'utc start time', 'utc end time', 'utc duration (s)', 'raw'
  ];

  btnProcesar.disabled = true;
  btnProcesar.style.opacity = '0.6';
  statusDiv.style.display = 'flex';
  const statusText = statusDiv.querySelector('span');

  try {
    // ==========================================
    // PASO 1: Procesar archivo TopTracks
    // ==========================================
    const mapaTopTracks = new Map(); // Key: bmatid -> Value: crp_id

    if (topTracksFile) {
      if (statusText) statusText.textContent = `Leyendo archivo TopTracks: ${topTracksFile.name}...`;
      const bufferTT = await topTracksFile.arrayBuffer();
      const wbTT = new ExcelJS.Workbook();
      await wbTT.xlsx.load(bufferTT);
      const wsTT = wbTT.worksheets[0];

      if (wsTT) {
        const totalFilasTT = wsTT.rowCount;
        const filaInicioDatos = 5; // La fila 4 es cabecera, datos desde la 5
        const filaFinDatos = totalFilasTT - 3; // Omitir las 3 últimas filas (footer)

        let colBmatIdIdx = -1;
        let colCrpIdIdx = -1;

        // Fila 4: Cabecera de TopTracks
        const filaCabecera = wsTT.getRow(4);
        filaCabecera.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const val = String(cell.value || '').trim().toLowerCase();
          if (val === 'bmatid') colBmatIdIdx = colNumber;
          if (val === 'crp_id') colCrpIdIdx = colNumber;
        });

        if (colBmatIdIdx !== -1 && colCrpIdIdx !== -1) {
          for (let r = filaInicioDatos; r <= filaFinDatos; r++) {
            const row = wsTT.getRow(r);
            const bmatIdVal = String(row.getCell(colBmatIdIdx).value || '').trim();
            const crpIdVal = row.getCell(colCrpIdIdx).value;

            if (bmatIdVal) {
              mapaTopTracks.set(bmatIdVal.toLowerCase(), crpIdVal);
            }
          }
        }
      }
    }

    // ==========================================
    // PASO 2: Unificar archivos CRP
    // ==========================================
    const workbookDestino = new ExcelJS.Workbook();
    const worksheetMaestra = workbookDestino.addWorksheet('CRP_Consolidado');

    const fillVerde = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9EAD3' } };
    const fillNaranja = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE5CD' } };
    const fillAmarillo = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2CC' } };

    let filaActualMaestra = 1;
    let mapaColumnasOrigen = {};
    let MappingsColumnasLimpias = [];
    let colCrpIdDestinoIdx = -1;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (statusText) statusText.textContent = `Procesando CRP (${i + 1}/${files.length}): ${file.name}...`;

      const arrayBuffer = await file.arrayBuffer();
      const workbookOrigen = new ExcelJS.Workbook();
      await workbookOrigen.xlsx.load(arrayBuffer);
      const worksheetOrigen = workbookOrigen.worksheets[0];
      if (!worksheetOrigen) continue;

      // Escanear encabezados
      const primeraFila = worksheetOrigen.getRow(1);
      mapaColumnasOrigen = {};
      MappingsColumnasLimpias = [];

      let colDestinoIdx = 1;

      primeraFila.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const valHeader = String(cell.value || '').trim();
        const headerLower = valHeader.toLowerCase();

        if (valHeader) mapaColumnasOrigen[headerLower] = colNumber;

        if (!columnasAEliminar.includes(headerLower)) {
          MappingsColumnasLimpias.push({
            origenIdx: colNumber,
            destinoIdx: colDestinoIdx
          });

          if (i === 0) {
            const colOrigen = worksheetOrigen.getColumn(colNumber);
            if (colOrigen && colOrigen.width) {
              worksheetMaestra.getColumn(colDestinoIdx).width = colOrigen.width;
            }
          }
          colDestinoIdx++;
        }
      });

      // Insertar la columna 'crp_id' al final de la cabecera si no existe
      if (i === 0) {
        colCrpIdDestinoIdx = colDestinoIdx;
        worksheetMaestra.getRow(1).getCell(colCrpIdDestinoIdx).value = 'crp_id';
        worksheetMaestra.getColumn(colCrpIdDestinoIdx).width = 15;
      }

      // Copiar filas y aplicar el MERGE con TopTracks
      worksheetOrigen.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (i > 0 && rowNumber === 1) return; // Omitir encabezados en archivos posteriores

        const rowDestino = worksheetMaestra.getRow(filaActualMaestra);

        // Copiar celdas filtradas
        MappingsColumnasLimpias.forEach((mapping) => {
          const cellOrigen = row.getCell(mapping.origenIdx);
          const celdaDestino = rowDestino.getCell(mapping.destinoIdx);

          if (cellOrigen.type === ExcelJS.ValueType.Hyperlink) {
            celdaDestino.value = {
              text: cellOrigen.value.text || cellOrigen.value.hyperlink,
              hyperlink: cellOrigen.value.hyperlink
            };
          } else {
            celdaDestino.value = cellOrigen.value;
          }

          if (cellOrigen.font) celdaDestino.font = cellOrigen.font;
        });

        // MERGE: Insertar 'crp_id' buscando por 'bmatid'
        if (rowNumber > 1) {
          const bmatIdColIdx = mapaColumnasOrigen['bmatid'];
          if (bmatIdColIdx) {
            const valBmatId = String(row.getCell(bmatIdColIdx).value || '').trim().toLowerCase();
            if (valBmatId && mapaTopTracks.has(valBmatId)) {
              rowDestino.getCell(colCrpIdDestinoIdx).value = mapaTopTracks.get(valBmatId);
            }
          }
        }

        // ==========================================
        // PASO 3: Coloreado condicional
        // ==========================================
        if (rowNumber > 1) {
          const valDuration = mapaColumnasOrigen['duration'] ? row.getCell(mapaColumnasOrigen['duration']).value : null;
          const valMS = mapaColumnasOrigen['m/s'] ? String(row.getCell(mapaColumnasOrigen['m/s']).value || '').trim() : '';
          const valBmatId = mapaColumnasOrigen['bmatid'] ? String(row.getCell(mapaColumnasOrigen['bmatid']).value || '').trim() : '';
          const valLabel = mapaColumnasOrigen['label'] ? String(row.getCell(mapaColumnasOrigen['label']).value || '').trim() : '';
          const valChannel = mapaColumnasOrigen['channel'] ? String(row.getCell(mapaColumnasOrigen['channel']).value || '').trim() : '';
          const valStartTime = mapaColumnasOrigen['start time'] ? row.getCell(mapaColumnasOrigen['start time']).value : null;
          const valDate = mapaColumnasOrigen['date'] ? row.getCell(mapaColumnasOrigen['date']).value : null;

          const segundosDuration = parseDurationToSeconds(valDuration);
          const segundosStartTime = parseDurationToSeconds(valStartTime);
          const diaSemana = getDayOfWeek(valDate);

          const esMusic = valMS.toLowerCase() === 'music';
          const esBmatIdVacio = valBmatId === '' || valBmatId === 'null' || valBmatId === 'undefined';
          const esFCF = valLabel.toUpperCase() === 'FCF';

          const esLaInolvidable = valChannel.toLowerCase().includes('la inolvidable');
          const enHorarioMadrugada = segundosStartTime >= 7200 && segundosStartTime <= 21600;
          const esFinDeSemana = diaSemana === 0 || diaSemana === 6;

          let colorAplicar = null;

          if (segundosDuration > 90 && esMusic && esBmatIdVacio) {
            colorAplicar = fillVerde;
          } else if (esMusic && esFCF) {
            colorAplicar = fillNaranja;
          } else if (esLaInolvidable && enHorarioMadrugada && esFinDeSemana) {
            colorAplicar = fillAmarillo;
          }

          if (colorAplicar) {
            rowDestino.eachCell({ includeEmpty: true }, (celda) => {
              celda.fill = colorAplicar;
            });
          }
        }

        rowDestino.commit();
        filaActualMaestra++;
      });
    }

    if (statusText) statusText.textContent = 'Generando archivo Excel unificado...';

    const buffer = await workbookDestino.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CRP_Unificado_Consolidado.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

  } catch (err) {
    console.error(err);
    errorDiv.textContent = `Error al procesar los archivos: ${err.message}`;
    errorDiv.style.display = 'block';
  } finally {
    btnProcesar.disabled = false;
    btnProcesar.style.opacity = '1';
    statusDiv.style.display = 'none';
  }
}