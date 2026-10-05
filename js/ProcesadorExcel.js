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

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  try {
    const response = await fetch('/api/procesar-excel', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      // Manejar respuestas que no sean JSON (por ejemplo, errores 413 o 504 de Vercel)
      const errorText = await response.text();
      let mensajeError = 'Error al procesar los archivos.';

      try {
        const errJson = JSON.parse(errorText);
        mensajeError = errJson.detail || mensajeError;
      } catch (e) {
        if (response.status === 413 || errorText.includes('Request Entity Too Large')) {
          mensajeError = 'Los archivos seleccionados superan el límite de tamaño permitido por Vercel (4.5 MB en total). Intenta con menos archivos o más livianos.';
        } else if (response.status === 504 || errorText.includes('Timeout')) {
          mensajeError = 'El procesamiento tomó demasiado tiempo. Intenta subirlos de 2 en 2.';
        } else {
          mensajeError = `Error del servidor (${response.status}): ${errorText.substring(0, 150)}`;
        }
      }

      throw new Error(mensajeError);
    }

    // Obtener el nombre del archivo
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = 'CRP_procesado.xlsx';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

  } catch (err) {
    errorDiv.textContent = err.message;
    errorDiv.style.display = 'block';
  } finally {
    btnProcesar.disabled = false;
    btnProcesar.style.opacity = '1';
    statusDiv.style.display = 'none';
  }
}