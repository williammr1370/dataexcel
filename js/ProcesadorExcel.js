// Función auxiliar para convertir duraciones a segundos
function parseDurationToSeconds(val) {
  if (val === null || val === undefined) return 0;
  
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

  // Lista de nombres de columnas a eliminar (en minúsculas para comparación insensitive)
  const columnasAEliminar = [
    'epg title',
    'epg type',
    'epg date',
    'epg start time',
    'epg end time',
    'epg duration'
  ];

  btnProcesar.disabled = true;
  btnProcesar.style.opacity = '0.6';
  statusDiv.style.display = 'flex';
  const statusText = statusDiv.querySelector('span');

  try {
    const workbookDestino = new ExcelJS.Workbook();
    const worksheetMaestra = workbookDestino.addWorksheet('CRP_Consolidado');

    // Estilos de relleno verde y naranja suaves (ARGB)
    const fillVerde = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAD3' }
    };

    const fillNaranja = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFCE5CD' }
    };

    let filaActualMaestra = 1;
    let mapaColumnasOrigen = {}; // Para ubicar valores requeridos en la hoja de origen
    let indicesIgnorarOrigen = new Set(); // Índices de columna a omitir al copiar
    let MappingsColumnasLimpias = []; // Mapeo de columna origen -> columna destino

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

      // 1. Escanear fila de encabezados para identificar columnas y crear el mapa de exclusión
      const primeraFila = worksheetOrigen.getRow(1);
      mapaColumnasOrigen = {};
      indicesIgnorarOrigen.clear();
      MappingsColumnasLimpias = [];

      let colDestinoIdx = 1;

      primeraFila.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const valHeader = String(cell.value || '').trim();
        const headerLower = valHeader.toLowerCase();

        // Guardar la posición de la columna de origen
        if (valHeader) {
          mapaColumnasOrigen[headerLower] = colNumber;
        }

        // Si la columna debe ser eliminada, guardamos su índice para ignorarla
        if (columnasAEliminar.includes(headerLower)) {
          indicesIgnorarOrigen.add(colNumber);
        } else {
          // Si no se elimina, creamos el mapeo [colOrigen -> colDestino]
          MappingsColumnasLimpias.push({
            origenIdx: colNumber,
            destinoIdx: colDestinoIdx
          });

          // Copiar anchos de columna en el primer archivo
          if (i === 0) {
            const colOrigen = worksheetOrigen.getColumn(colNumber);
            if (colOrigen && colOrigen.width) {
              worksheetMaestra.getColumn(colDestinoIdx).width = colOrigen.width;
            }
          }

          colDestinoIdx++;
        }
      });

      // 2. Recorrer filas del archivo actual
      worksheetOrigen.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        // Omitir encabezados en los archivos posteriores
        if (i > 0 && rowNumber === 1) {
          return;
        }

        const rowDestino = worksheetMaestra.getRow(filaActualMaestra);

        // Copiar celdas omitiendo las columnas eliminadas
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

          if (cellOrigen.font) {
            celdaDestino.font = cellOrigen.font;
          }
        });

        // 3. Aplicar reglas de color condicional si no es la fila de encabezado
        if (rowNumber > 1) {
          const valDuration = mapaColumnasOrigen['duration'] ? row.getCell(mapaColumnasOrigen['duration']).value : null;
          const valMS = mapaColumnasOrigen['m/s'] ? String(row.getCell(mapaColumnasOrigen['m/s']).value || '').trim() : '';
          const valBmatId = mapaColumnasOrigen['bmatid'] ? String(row.getCell(mapaColumnasOrigen['bmatid']).value || '').trim() : '';
          const valLabel = mapaColumnasOrigen['label'] ? String(row.getCell(mapaColumnasOrigen['label']).value || '').trim() : '';

          const segundosDuration = parseDurationToSeconds(valDuration);

          // Condición corregida: M/S igual a "music"
          const esMusic = valMS.toLowerCase() === 'music';
          const esBmatIdVacio = valBmatId === '' || valBmatId === 'null' || valBmatId === 'undefined';
          const esFCF = valLabel.toUpperCase() === 'FCF';

          let colorAplicar = null;

          // Regla 1: Verde -> duration > 0:01:30 (90s), M/S = music, BmatId vacio
          if (segundosDuration > 90 && esMusic && esBmatIdVacio) {
            colorAplicar = fillVerde;
          }
          // Regla 2: Naranja -> M/S = music, Label = FCF
          else if (esMusic && esFCF) {
            colorAplicar = fillNaranja;
          }

          // Aplicar color a toda la fila resultante
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