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
    // Crear una única pestaña maestra donde se consolidarán todos los datos
    const worksheetMaestra = workbookDestino.addWorksheet('CRP_Consolidado');

    // Relleno verde suave (ARGB)
    const fillVerde = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAD3' }
    };

    let filaActualMaestra = 1;

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

      // Recorrer las filas del archivo actual
      worksheetOrigen.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        // Si no es el primer archivo y es la primera fila (encabezados), la omitimos para no duplicar títulos
        if (i > 0 && rowNumber === 1) {
          return;
        }

        const rowDestino = worksheetMaestra.getRow(filaActualMaestra);

        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          const celdaDestino = rowDestino.getCell(colNumber);

          // 1. Copiar Valor / Hipervínculo
          if (cell.type === ExcelJS.ValueType.Hyperlink) {
            celdaDestino.value = {
              text: cell.value.text || cell.value.hyperlink,
              hyperlink: cell.value.hyperlink
            };
          } else {
            celdaDestino.value = cell.value;
          }

          // 2. Copiar o conservar fuentes e hipervínculos
          if (cell.font) {
            celdaDestino.font = cell.font;
          }

          // 3. Regla de coloreado condicional para "OK" o "COMPLETADO"
          let valorTexto = '';
          if (typeof cell.value === 'string') {
            valorTexto = cell.value;
          } else if (cell.value && typeof cell.value === 'object' && cell.value.text) {
            valorTexto = cell.value.text;
          }

          if (valorTexto) {
            const txtUpper = valorTexto.toUpperCase();
            if (txtUpper.includes('OK') || txtUpper.includes('COMPLETADO')) {
              celdaDestino.fill = fillVerde;
            }
          }
        });

        rowDestino.commit();
        filaActualMaestra++; // Avanzar a la siguiente fila en la pestaña maestra
      });
    }

    if (statusText) statusText.textContent = 'Generando archivo Excel unificado...';

    // Exportar archivo final
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