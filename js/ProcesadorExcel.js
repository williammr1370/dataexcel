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
    // Crear un nuevo libro consolidado con ExcelJS
    const workbookDestino = new ExcelJS.Workbook();

    // Relleno verde suave (ARGB: FF D9 EA D3)
    const fillVerde = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD9EAD3' }
    };

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (statusText) {
        statusText.textContent = `Procesando archivo ${i + 1} de ${files.length}: ${file.name}...`;
      }

      const arrayBuffer = await file.arrayBuffer();
      const workbookOrigen = new ExcelJS.Workbook();
      await workbookOrigen.xlsx.load(arrayBuffer);

      // Tomar la primera hoja del archivo de origen
      const worksheetOrigen = workbookOrigen.worksheets[0];
      if (!worksheetOrigen) continue;

      // Definir un nombre válido para la pestaña (máx. 31 caracteres)
      let nombreHoja = file.name.replace(/\.(xlsx|xls)$/i, '').substring(0, 31);
      
      // Evitar nombres duplicados
      let contador = 1;
      let nombreBase = nombreHoja;
      while (workbookDestino.getWorksheet(nombreHoja)) {
        nombreHoja = `${nombreBase.substring(0, 27)}_${contador}`;
        contador++;
      }

      const worksheetDestino = workbookDestino.addWorksheet(nombreHoja);

      // Copiar el ancho de columnas si existe
      worksheetOrigen.columns?.forEach((col, colIdx) => {
        if (col.width) {
          worksheetDestino.getColumn(colIdx + 1).width = col.width;
        }
      });

      // Recorrer filas y celdas
      worksheetOrigen.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const rowDestino = worksheetDestino.getRow(rowNumber);

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

          // 2. Copiar o conservar estilos originales (si existen)
          if (cell.fill) {
            celdaDestino.fill = cell.fill;
          }
          if (cell.font) {
            celdaDestino.font = cell.font;
          }

          // 3. Regla de coloreado condicional
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
      });
    }

    if (statusText) statusText.textContent = 'Generando archivo Excel unificado...';

    // Exportar archivo descargable desde el navegador
    const buffer = await workbookDestino.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });

    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'CRP_Unificado_Coloreado.xlsx';
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