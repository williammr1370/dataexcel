// Función auxiliar para convertir duraciones en formato "HH:MM:SS" o "MM:SS" a segundos
function parseDurationToSeconds(val) {
  if (val === null || val === undefined) return 0;
  
  // Si Excel lo leyó como objeto fecha/hora de JS
  if (val instanceof Date) {
    return val.getHours() * 3600 + val.getMinutes() * 60 + val.getSeconds();
  }
  
  const str = String(val).trim();
  if (!str) return 0;

  const parts = str.split(':').map(p => parseFloat(p) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]; // HH:MM:SS
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1]; // MM:SS
  }
  
  // En caso de recibir el número de días flotante propio de Excel (ej: 0.00104)
  const num = Number(val);
  if (!isNaN(num)) {
    return Math.round(num * 86400);
  }

  return 0;
}

async function procesarArchivosCRP() {
  const fileInput = document.getElementById('crp-file-input');
  const btnProcesar = document.getElementById('crp-btn-procesar');
  const statusDiv = document.getElementById('crp-status');
  const errorDiv = document.getElementById('crp-error');

  errorDiv.style.display = 'none';
  errorDiv.textContent = '';

  const files = Array.from(fileInput.files);
  if (files.length === 0) {
    errorDiv.textContent = 'Por favor, selecciona al menos un archivo Excel (.xlsx).';
    errorDiv.style.display = 'block';
    return;
  }

  btnProcesar.disabled = true;
  btnProcesar.style.opacity = '0.6';
  statusDiv.style.display = 'flex';
  const statusText = statusDiv.querySelector('span');

  try {
    const workbookDestino = new ExcelJS.Workbook();
    const worksheetMaestra = workbookDestino.addWorksheet('CRP_Consolidado');

    // Definición de colores pastel (ARGB)
    const fillVerde = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAD3' } // Verde suave
    };

    const fillNaranja = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFCE5CD' } // Naranja suave
    };

    let filaActualMaestra = 1;
    let mapaColumnas = {}; // Guarda los índices de columna por nombre

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (statusText) {
        statusText.textContent = `Procesando archivo ${i + 1} de ${files.length}: ${file.name}...`;
      }

      const arrayBuffer = await file.arrayBuffer();
      const workbookOrigen = new ExcelJS.Workbook();
      await workbookOrigen.xlsx.load(arrayBuffer);

      const worksheetOrigen = workbookOrigen.worksheets[0];
      if (!worksheetOrigen) continue;

      // Copiar anchos de columna si es el primer archivo
      if (i === 0) {
        worksheetOrigen.columns?.forEach((col, colIdx) => {
          if (col.width) {
            worksheetMaestra.getColumn(colIdx + 1).width = col.width;
          }
        });
      }

      // Mapear encabezados de la fila 1 para ubicar "duration", "M/S", "BmatId", "Label", etc.
      const primeraFila = worksheetOrigen.getRow(1);
      mapaColumnas = {};
      primeraFila.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (cell.value) {
          const colName = String(cell.value).trim().toLowerCase();
          mapaColumnas[colName] = colNumber;
        }
      });

      // Recorrer filas del archivo actual
      worksheetOrigen.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        // Omitir la fila 1 en archivos posteriores para no duplicar encabezados
        if (i > 0 && rowNumber === 1) {
          return;
        }

        const rowDestino = worksheetMaestra.getRow(filaActualMaestra);

        // Copiar celdas y sus propiedades
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const celdaDestino = rowDestino.getCell(colNumber);

          if (cell.type === ExcelJS.ValueType.Hyperlink) {
            celdaDestino.value = {
              text: cell.value.text || cell.value.hyperlink,
              hyperlink: cell.value.hyperlink
            };
          } else {
            celdaDestino.value = cell.value;
          }

          if (cell.font) {
            celdaDestino.font = cell.font;
          }
        });

        // Aplicar reglas de color si no es la fila de encabezado
        if (rowNumber > 1) {
          // Extraer valores de columnas requeridas
          const valDuration = mapaColumnas['duration'] ? row.getCell(mapaColumnas['duration']).value : null;
          const valMS = mapaColumnas['m/s'] ? String(row.getCell(mapaColumnas['m/s']).value || '').trim() : '';
          const valBmatId = mapaColumnas['bmatid'] ? String(row.getCell(mapaColumnas['bmatid']).value || '').trim() : '';
          const valLabel = mapaColumnas['label'] ? String(row.getCell(mapaColumnas['label']).value || '').trim() : '';

          const segundosDuration = parseDurationToSeconds(valDuration);

          const esMusica = valMS.toLowerCase() === 'musica' || valMS.toLowerCase() === 'música' || valMS.toUpperCase() === 'M';
          const esBmatIdVacio = valBmatId === '' || valBmatId === 'null' || valBmatId === 'undefined';
          const esFCF = valLabel.toUpperCase() === 'FCF';

          let colorAplicar = null;

          // Regla 1: Verde -> duration > 0:01:30 (90s), M/S = musica, BmatId vacio
          if (segundosDuration > 90 && esMusica && esBmatIdVacio) {
            colorAplicar = fillVerde;
          }
          // Regla 2: Naranja -> M/S = musica, Label = FCF
          else if (esMusica && esFCF) {
            colorAplicar = fillNaranja;
          }

          // Aplicar el color a toda la fila si cumple alguna condición
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